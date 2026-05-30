// FSD MRBS API server entry point.
//
// This binary serves three concerns:
//  1. The JSON API for the SPA / kiosks / external integrations
//  2. The WebSocket realtime stream
//  3. Static asset serving for the SPA bundle (single-binary deploy)
//
// Background workers (notification SMTP, scheduler) live in
// src/cmd/worker and src/cmd/scheduler so they can be scaled independently.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"

	"fsd-mrbs/src/application/api/handlers"
	"fsd-mrbs/src/application/usecase"
	"fsd-mrbs/src/domain/audit"
	"fsd-mrbs/src/domain/mfa"
	"fsd-mrbs/src/domain/user"
	"fsd-mrbs/src/infrastructure/ad"
	"fsd-mrbs/src/infrastructure/auditlog"
	infauth "fsd-mrbs/src/infrastructure/auth"
	"fsd-mrbs/src/infrastructure/external"
	infraintegration "fsd-mrbs/src/infrastructure/integration"
	"fsd-mrbs/src/infrastructure/observability"
	"fsd-mrbs/src/infrastructure/postgres"
	"fsd-mrbs/src/infrastructure/rabbitmq"
	"fsd-mrbs/src/infrastructure/realtime"
	apispec "fsd-mrbs/src/presentation/api"
	"fsd-mrbs/src/presentation/api/middleware"
)

func main() {
	ctx := context.Background()
	dbURL := os.Getenv("DB_DSN")
	if dbURL == "" {
		log.Fatal("DB_DSN is required; refusing to start with an embedded default credential.")
	}
	if strings.Contains(dbURL, "sslmode=disable") && !strings.EqualFold(os.Getenv("ALLOW_INSECURE_DB"), "true") {
		log.Fatal("DB_DSN has sslmode=disable; set sslmode=require (or higher), or ALLOW_INSECURE_DB=true for local dev only.")
	}

	cfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		log.Fatalf("db config: %v", err)
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		log.Fatalf("db: %v", err)
	}
	defer pool.Close()

	// --- Repositories
	adminRepo := postgres.NewAdminRepo(pool)
	bookingRepo := postgres.NewBookingRepository(pool)
	resourceRepo := postgres.NewResourceRepo(pool)
	reportRepo := postgres.NewReportRepo(pool)
	customizationRepo := postgres.NewCustomizationRepo(pool)
	checkinRepo := postgres.NewCheckinTokenRepo(pool)
	userRepo := postgres.NewUserRepository(pool)
	holidayRepo := postgres.NewHolidayRepository(pool)
	deptRepo := postgres.NewDepartmentRepo(pool)
	approvalRepo := postgres.NewApprovalRepo(pool)
	approvalRuleRepo := postgres.NewApprovalRuleRepo(pool)
	approvalStepRepo := postgres.NewApprovalStepRepo(pool)
	seriesRepo := postgres.NewRecurringSeriesRepository(pool)
	// ADDED: Service repository
	serviceRepo := postgres.NewServiceRepository(pool)
	floorPlanRepo := postgres.NewFloorPlanRepo(pool)
	locationGroupRepo := postgres.NewLocationGroupRepo(pool)
	locationRepo := postgres.NewLocationRepo(pool)
	broadcastRepo := postgres.NewBroadcastRepository(pool)
	auditRepo := postgres.NewAuditRepository(pool)
	auditlog.SetSink(auditRepo)
	tenantRepo := postgres.NewTenantRepository(pool)
	providerFactory := infauth.NewProviderFactory()

	// --- Infra
	pimm := rabbitmq.NewRabbitMQPublisher(os.Getenv("RABBITMQ_URL"))
	adService := ad.NewLDAPService(os.Getenv("LDAP_URL"))
	hub := realtime.NewHub()
	hkClient := external.NewGovHKHolidayClient(0)
	hkoWeather := external.NewHKOClient(0)
	weatherH := handlers.NewWeatherHandler(hkoWeather)

	// Seed the dev simulator's directory users into postgres so the admin
	// portal lists them immediately. Real LDAP deployments rely on the
	// upsert-on-login path in loginHandler instead.
	if os.Getenv("LDAP_URL") == "" {
		seedSimulatorUsers(ctx, userRepo, getDefaultTenantID())
	}

	// --- Use cases
	chainUC := usecase.NewApprovalChainUseCase(approvalRuleRepo, approvalStepRepo, resourceRepo, bookingRepo, approvalRepo)

	bookingUC := usecase.NewCreateBookingUseCase(bookingRepo, adminRepo, pimm).
		WithResourceLookup(resourceRepo).
		WithChainMaterializer(chainUC).
		WithPrivilegePolicy(usecase.NewPrivilegeMatrixPolicy(userRepo, locationGroupRepo)).
		WithZoomMaskBase(orDefault(os.Getenv("ZOOM_MASK_BASE"), "https://ess.hkfsd.hksarg/redirect"))
	reportUC := usecase.NewGenerateReportUseCase(reportRepo)
	checkinUC := usecase.NewCheckinUseCase(checkinRepo, bookingRepo)
	approvalUC := usecase.NewApprovalUseCase(bookingRepo, resourceRepo, approvalRepo, pimm)
	updateUC := usecase.NewUpdateBookingUseCase(bookingRepo, pimm)
	recurringUC := usecase.NewExpandRecurringBookingUseCase(bookingRepo, seriesRepo)

	// --- Handlers
	adminH := handlers.NewAdminHandler(usecase.NewAdminManagerUseCase(adminRepo))
	bookingH := handlers.NewBookingHandler(resourceRepo, bookingUC, customizationRepo).
		WithRecurrence(recurringUC)
	reportH := handlers.NewReportHandler(reportUC)
	customizationH := handlers.NewCustomizationHandler(customizationRepo)
	checkinH := handlers.NewCheckinHandler(checkinUC)
	realtimeH := handlers.NewRealtimeHandler(hub)
	resH := handlers.NewAdminResourceHandler(resourceRepo)
	resourceCatalogH := handlers.NewResourceCatalogHandler(resourceRepo)
	userH := handlers.NewAdminUserHandler(userRepo)
	deptH := handlers.NewAdminDepartmentHandler(deptRepo)
	holidayH := handlers.NewAdminHolidayHandler(holidayRepo, hkClient,
		orDefault(os.Getenv("DEFAULT_ADMIN_USER_ID"), "11111111-1111-1111-1111-111111111111"))
	approvalH := handlers.NewApprovalHandler(approvalUC, bookingRepo).WithChain(chainUC, approvalStepRepo).WithDelegation(approvalStepRepo)
	lifecycleH := handlers.NewBookingLifecycleHandler(bookingRepo, resourceRepo, updateUC)
	bookingCheckinH := handlers.NewBookingCheckinHandler(bookingRepo)
	approvalRulesH := handlers.NewAdminApprovalRulesHandler(approvalRuleRepo)
	webhooksH := handlers.NewAdminWebhooksHandler(pool)
	resourceTypeRepo := postgres.NewResourceTypeRepo(pool)
	resourceTypesH := handlers.NewAdminResourceTypesHandler(resourceTypeRepo)
	permCatalogRepo := postgres.NewPermissionCatalogRepo(pool)
	permCatalogH := handlers.NewAdminPermissionCatalogHandler(permCatalogRepo)
	// ADDED: Service handler
	serviceH := handlers.NewAdminServiceHandler(serviceRepo)
	floorPlanH := handlers.NewAdminFloorPlanHandler(floorPlanRepo)
	locationGroupH := handlers.NewAdminLocationGroupHandler(locationGroupRepo)
	locationH := handlers.NewAdminLocationHandler(locationRepo)
	broadcastH := handlers.NewBroadcastHandler(broadcastRepo)

	// Integrations + permissions + Teams
	integrationCredRepo := postgres.NewIntegrationCredentialRepo(pool)
	mailboxRepo := postgres.NewRoomMailboxRepo(pool)
	outlookSyncRepo := postgres.NewOutlookSyncRepo(pool)
	permRepo := postgres.NewPermissionRepo(pool)
	graphSubRepo := postgres.NewGraphSubscriptionRepo(pool)
	scimTokenRepo := postgres.NewSCIMTokenRepo(pool)
	convoRepo := postgres.NewBotConversationRepo(pool)
	graphClient := infraintegration.NewGraphClient(0)

	// Graph two-way sync use cases need to exist BEFORE the integrations
	// handler so we can pass closures that call them on mailbox map/unmap.
	reconcileUC := usecase.NewReconcileGraphEventUseCase(integrationCredRepo, mailboxRepo, bookingRepo, resourceRepo, outlookSyncRepo, graphClient)
	subMgrUC := usecase.NewManageGraphSubscriptionsUseCase(integrationCredRepo, mailboxRepo, graphSubRepo, graphClient,
		os.Getenv("GRAPH_NOTIFY_URL"))
	graphNotifH := handlers.NewGraphNotificationsHandler(graphSubRepo, reconcileUC)

	integrationsH := handlers.NewAdminIntegrationsHandler(integrationCredRepo, mailboxRepo, graphClient).
		WithSubscriptionLifecycle(
			func(ctx interface{ Done() <-chan struct{} }, tid, upn string) {
				if c, ok := ctx.(context.Context); ok {
					if err := subMgrUC.EnsureSubscription(c, tid, upn); err != nil {
						log.Printf("graph subscribe %s/%s: %v", tid, upn, err)
					}
				}
			},
			func(ctx interface{ Done() <-chan struct{} }, tid, upn string) {
				if c, ok := ctx.(context.Context); ok {
					if err := subMgrUC.Remove(c, tid, upn); err != nil {
						log.Printf("graph unsubscribe %s/%s: %v", tid, upn, err)
					}
				}
			},
		)
	permissionsH := handlers.NewAdminPermissionsHandler(permRepo)
	teamsH := handlers.NewTeamsHandler(convoRepo)
	scimH := handlers.NewSCIMHandler(pool, scimTokenRepo, userRepo)
	scimAdminH := handlers.NewSCIMTokenAdminHandler(scimTokenRepo)

	// --- Middleware
	middleware.SetupLogger()
	tenantMW := middleware.NewTenantMiddleware(pool)
	idemMW := middleware.NewIdempotencyMiddleware(pool)
	permMW := middleware.NewPermissionMiddleware(permRepo)

	// perm wraps a handler with both role gate (existing) AND the
	// granular permission check. The role list still controls UI menu
	// visibility; the permission key is what actually gates the action.
	perm := func(roles []string, key string, h http.HandlerFunc) http.Handler {
		return middleware.RequireRoleHandler(roles, permMW.RequireFunc(key, h).ServeHTTP)
	}
	_ = perm

	// --- Observability: OTel tracing (no-op when OTEL_EXPORTER_OTLP_ENDPOINT unset)
	tracingShutdown, err := observability.SetupTracing(ctx, "fsd-mrbs-api")
	if err != nil {
		log.Printf("warning: tracing setup failed: %v", err)
	}
	defer func() { _ = tracingShutdown(context.Background()) }()

	// Rate limits — defaults sized for production. Override at deploy time via
	// LOGIN_RATE_LIMIT / LOGIN_RATE_WINDOW / LOGIN_LOCKOUT and
	// WRITE_RATE_LIMIT / WRITE_RATE_WINDOW / WRITE_LOCKOUT (e.g. "100",
	// "1m", "0s"). Empty/invalid env values fall back to the defaults.
	loginLimit := intEnv("LOGIN_RATE_LIMIT", 5)
	loginWindow := durationEnv("LOGIN_RATE_WINDOW", 5*time.Minute)
	loginLockout := durationEnv("LOGIN_LOCKOUT", 15*time.Minute)
	writeLimit := intEnv("WRITE_RATE_LIMIT", 60)
	writeWindow := durationEnv("WRITE_RATE_WINDOW", time.Minute)
	writeLockout := durationEnv("WRITE_LOCKOUT", time.Minute)
	loginLimiter := middleware.NewRateLimiter(loginLimit, loginWindow, loginLockout)
	writeLimiter := middleware.NewRateLimiter(writeLimit, writeWindow, writeLockout)
	log.Printf("rate limits: login=%d/%v lockout=%v · writes=%d/%v lockout=%v",
		loginLimit, loginWindow, loginLockout,
		writeLimit, writeWindow, writeLockout)

	mux := http.NewServeMux()

	// ---- Public ----
	mux.Handle("/api/v1/login", loginLimiter.LoginGuard(http.HandlerFunc(loginHandler(pool, adService, userRepo, auditRepo))))
	mux.Handle("/api/v1/mfa/verify", loginLimiter.LoginGuard(http.HandlerFunc(mfaVerifyHandler(pool, userRepo, auditRepo))))
	// Forced first-login password reset — public, gated by the scoped
	// change-token rather than a session. Rate-limited like login.
	mux.Handle("/api/v1/auth/change-password", loginLimiter.LoginGuard(http.HandlerFunc(changePasswordHandler(userRepo, auditRepo))))

	// Federated SSO — OIDC + SAML — backed by the per-tenant identity
	// provider config. The handler resolves the right provider from the
	// tenant row and dispatches.
	ssoH := handlers.NewSSOHandler(
		pool, providerFactory, userRepo,
		middleware.JwtSecretKey, 8*time.Hour, getDefaultTenantID(),
		func(ctx context.Context, tenantID string) (map[string]interface{}, error) {
			tid, err := uuid.Parse(tenantID)
			if err != nil {
				return nil, err
			}
			t, err := tenantRepo.GetByID(ctx, tid)
			if err != nil {
				return nil, err
			}
			return t.IdentityProviderConfig, nil
		},
	)
	mux.HandleFunc("/api/v1/auth/oidc/start", ssoH.OIDCStart)
	mux.HandleFunc("/api/v1/auth/oidc/callback", ssoH.OIDCCallback)
	mux.HandleFunc("/api/v1/auth/saml/init", ssoH.SAMLInit)
	mux.HandleFunc("/api/v1/auth/saml/acs", ssoH.SAMLACS)
	mux.HandleFunc("/api/v1/checkin/", checkinH.Redeem)
	mux.HandleFunc("/api/v1/healthz", healthzHandler(hub))
	mux.HandleFunc("/api/v1/readyz", readyzHandler(pool))
	mux.HandleFunc("/api/openapi.json", apispec.SpecHandler)
	mux.HandleFunc("/api/docs", apispec.SwaggerUIHandler)
	mux.HandleFunc("/api/v1/realtime", realtimeH.ServeWS)
	mux.Handle("/api/metrics", observability.MetricsHandler())

	allBookerRoles := []string{user.RoleGeneralUser, user.RoleRoomAdmin, user.RoleSecretary, user.RoleSystemAdmin, user.RoleSecurityAdmin}
	approverRoles := []string{user.RoleSystemAdmin, user.RoleSecurityAdmin, user.RoleRoomAdmin, user.RoleSecretary}
	adminRoles := []string{user.RoleSystemAdmin, user.RoleSecurityAdmin}
	roomAdminRoles := []string{user.RoleSystemAdmin, user.RoleSecurityAdmin, user.RoleRoomAdmin}

	// ---- Bookings ----
	// Read-only room catalogue for every authenticated user (Calendar /
	// Search columns). Role-gated only — no booking permission required,
	// so officers can always see the rooms even if they lack booking.create.
	mux.Handle("/api/v1/resources", tenantMW.Middleware(
		middleware.RequireRoleHandler(allBookerRoles, resourceCatalogH.List),
	))
	// Read-only managed-location list for every authenticated user
	// (resource editor dropdown, hierarchy). Writes are admin-only below.
	mux.Handle("/api/v1/locations", tenantMW.Middleware(
		middleware.RequireRoleHandler(allBookerRoles, locationH.List),
	))

	// Search is gated by booking.create (anyone who can book needs to find rooms).
	mux.Handle("/api/v1/bookings/search", tenantMW.Middleware(
		perm(allBookerRoles, "booking.create", bookingH.SearchAvailableRooms),
	))
	// "Suggest next available slots" — used by the SPA's New Booking page
	// to render Calendly-style alternative-time chips when the user's
	// preferred window may not be ideal.
	mux.Handle("/api/v1/bookings/suggest-slots", tenantMW.Middleware(
		perm(allBookerRoles, "booking.create", bookingH.SuggestSlots),
	))
	// Wrap booking write routes in WithTenantTx so the RLS policy can
	// see app.current_tenant_id. The handler chain below ends up running
	// inside a request-pinned transaction; ExecutorFromContext in
	// booking_repo automatically picks the tx up.
	mux.Handle("/api/v1/bookings", writeLimiter.Middleware(tenantMW.Middleware(
		middleware.WithTenantTx(pool)(perm(allBookerRoles, "booking.create",
			idemMW.Wrap(http.HandlerFunc(bookingH.CreateBooking)).ServeHTTP)),
	)))

	// Booking edit / cancel / get-one — methods gate inside lifecycle handler
	mux.Handle("/api/v1/bookings/", tenantMW.Middleware(
		middleware.WithTenantTx(pool)(perm(allBookerRoles, "booking.update", lifecycleH.DispatchOne)),
	))

	// Quick check-in (dashboard action). More specific than the
	// "/api/v1/bookings/" lifecycle prefix so ServeMux routes it here.
	mux.Handle("/api/v1/bookings/checkin/", tenantMW.Middleware(
		middleware.RequireRoleHandler(allBookerRoles, bookingCheckinH.Checkin),
	))

	// My bookings — every authenticated user can see their own
	mux.Handle("/api/v1/me/bookings", tenantMW.Middleware(
		middleware.RequireRoleHandler(allBookerRoles, lifecycleH.ListMine),
	))

	// Busy-intervals feed for every booker: returns blocking time ranges
	// per resource WITHOUT PII so the calendar can grey out taken slots.
	// Officers, secretaries, even general users hit this so the UI no
	// longer pretends a room is free just because the viewer didn't
	// personally make the booking. See lifecycle.Busy for the scrub list.
	mux.Handle("/api/v1/bookings/busy", tenantMW.Middleware(
		middleware.RequireRoleHandler(allBookerRoles, lifecycleH.Busy),
	))

	// Federated free/busy — scheduling-assistant compatible endpoint.
	// Same wire shape as Microsoft Graph getSchedule / Google freeBusy
	// so external connectors slot in cleanly. PII-free by construction
	// (see freebusy_handler.go).
	freebusyH := handlers.NewFreeBusyHandler(pool, bookingRepo, resourceRepo)
	mux.Handle("/api/v1/freebusy", tenantMW.Middleware(
		middleware.RequireRoleHandler(allBookerRoles, freebusyH.Query),
	))

	// Data-Subject Access Requests (GDPR Art. 15/17/20, HK PDPO DPP6).
	// Every authenticated user can export or erase their own data without
	// admin intervention. Audit row marks the action as critical severity.
	dsarH := handlers.NewDSARHandler(pool)
	mux.Handle("/api/v1/me/export", tenantMW.Middleware(
		middleware.RequireRoleHandler(allBookerRoles, dsarH.Export),
	))
	mux.Handle("/api/v1/me", tenantMW.Middleware(
		middleware.RequireRoleHandler(allBookerRoles, dsarH.Delete),
	))

	// MFA self-service enrolment.
	mfaH := handlers.NewMFAHandler(pool, os.Getenv("MFA_ISSUER"))
	mux.Handle("/api/v1/me/mfa", tenantMW.Middleware(
		middleware.RequireRoleHandler(allBookerRoles, func(w http.ResponseWriter, r *http.Request) {
			switch r.Method {
			case http.MethodGet:
				mfaH.Status(w, r)
			case http.MethodDelete:
				mfaH.Disarm(w, r)
			default:
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			}
		}),
	))
	mux.Handle("/api/v1/me/mfa/enroll", tenantMW.Middleware(
		middleware.RequireRoleHandler(allBookerRoles, mfaH.Enroll),
	))
	mux.Handle("/api/v1/me/mfa/activate", tenantMW.Middleware(
		middleware.RequireRoleHandler(allBookerRoles, mfaH.Activate),
	))

	// WebAuthn / passkey enrolment (FIDO2). The /authenticate/* surface
	// for step-up login lands alongside the existing /mfa/verify path in
	// a future revision; this initial cut wires enrolment + listing so
	// users can register passkeys via Settings → MFA.
	webauthnH := handlers.NewWebAuthnHandler(pool)
	mux.Handle("/api/v1/me/webauthn", tenantMW.Middleware(
		middleware.WithTenantTx(pool)(middleware.RequireRoleHandler(allBookerRoles, webauthnH.List)),
	))
	mux.Handle("/api/v1/me/webauthn/", tenantMW.Middleware(
		middleware.WithTenantTx(pool)(middleware.RequireRoleHandler(allBookerRoles, webauthnH.Delete)),
	))
	mux.Handle("/api/v1/me/webauthn/register/start", tenantMW.Middleware(
		middleware.WithTenantTx(pool)(middleware.RequireRoleHandler(allBookerRoles, webauthnH.RegisterStart)),
	))
	mux.Handle("/api/v1/me/webauthn/register/finish", tenantMW.Middleware(
		middleware.WithTenantTx(pool)(middleware.RequireRoleHandler(allBookerRoles, webauthnH.RegisterFinish)),
	))

	// Subscribable iCal feed. The token endpoint is authenticated; the
	// feed itself lives on /ical/<token>.ics and is public-by-design so
	// calendar clients without an Authorization header still work.
	publicURL := orDefault(os.Getenv("PUBLIC_BASE_URL"), "http://localhost:8080")
	icalH := handlers.NewICalFeedHandler(pool, middleware.JwtSecretKey, publicURL, 365*24*time.Hour)
	mux.Handle("/api/v1/me/calendar/token", tenantMW.Middleware(
		middleware.RequireRoleHandler(allBookerRoles, icalH.MintToken),
	))
	mux.HandleFunc("/ical/", icalH.Serve)

	// Kiosk / room-display agenda. Unauthenticated by design — see the
	// docstring on KioskHandler.Agenda for the minimal projection rule.
	kioskH := handlers.NewKioskHandler(pool)
	mux.HandleFunc("/api/v1/kiosk/", kioskH.Agenda)

	// Web Push subscriptions. The VAPID public key is served unauthenticated
	// so the SPA service worker can register without a token round-trip;
	// the subscribe/unsubscribe endpoints are user-scoped.
	// Visitor management — host invites, kiosk QR redemption, reception
	// dashboard. The QR redemption endpoint is unauthenticated by design.
	visitorRepo := postgres.NewVisitorRepository(pool)
	visitorH := handlers.NewVisitorHandler(visitorRepo)
	mux.Handle("/api/v1/visits", tenantMW.Middleware(
		middleware.WithTenantTx(pool)(middleware.RequireRoleHandler(allBookerRoles, visitorH.Dispatch)),
	))
	mux.Handle("/api/v1/visits/", tenantMW.Middleware(
		middleware.WithTenantTx(pool)(middleware.RequireRoleHandler(allBookerRoles, visitorH.Dispatch)),
	))
	mux.Handle("/api/v1/admin/visits", tenantMW.Middleware(
		middleware.WithTenantTx(pool)(middleware.RequireRoleHandler(adminRoles, visitorH.AdminToday)),
	))
	mux.HandleFunc("/api/v1/checkin/visit/", visitorH.RedeemKioskToken)

	// IoT sensor ingestion + admin CRUD.
	sensorH := handlers.NewSensorHandler(pool)
	mux.HandleFunc("/api/v1/sensors/ingest", sensorH.Ingest) // HMAC-signed; no JWT
	mux.Handle("/api/v1/admin/sensors", tenantMW.Middleware(
		middleware.WithTenantTx(pool)(middleware.RequireRoleHandler(adminRoles, func(w http.ResponseWriter, r *http.Request) {
			switch r.Method {
			case http.MethodGet:
				sensorH.List(w, r)
			case http.MethodPost:
				sensorH.Enrol(w, r)
			default:
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			}
		})),
	))
	mux.HandleFunc("/api/v1/resources/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/occupancy") {
			sensorH.Occupancy(w, r)
			return
		}
		http.NotFound(w, r)
	})

	// Charge-back / invoicing.
	invoiceH := handlers.NewInvoiceHandler(pool)
	mux.Handle("/api/v1/admin/invoices", tenantMW.Middleware(
		middleware.WithTenantTx(pool)(middleware.RequireRoleHandler(adminRoles, invoiceH.Dispatch)),
	))
	mux.Handle("/api/v1/admin/invoices/", tenantMW.Middleware(
		middleware.WithTenantTx(pool)(middleware.RequireRoleHandler(adminRoles, invoiceH.Dispatch)),
	))

	pushH := handlers.NewPushHandler(pool)
	mux.HandleFunc("/api/v1/push/vapid-key", pushH.VapidKey)
	mux.Handle("/api/v1/me/push", tenantMW.Middleware(
		middleware.WithTenantTx(pool)(middleware.RequireRoleHandler(allBookerRoles, func(w http.ResponseWriter, r *http.Request) {
			switch r.Method {
			case http.MethodPost:
				pushH.Subscribe(w, r)
			case http.MethodDelete:
				pushH.Unsubscribe(w, r)
			default:
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			}
		})),
	))

	// Admin: all bookings for timetable view
	mux.Handle("/api/v1/admin/bookings", tenantMW.Middleware(
		perm(adminRoles, "report.export", lifecycleH.ListAll),
	))

	// Admin-side booking-status overrides. The allowlist below is the
	// authoritative source: only System Admin, Room Admin, and Secretary
	// can force another user's booking into "No Show". Security Admin
	// and General User are deliberately excluded — Security Admin owns
	// permission and identity, not the operations side, and a general
	// user must not be able to take their colleague's room away.
	noShowRoles := []string{user.RoleSystemAdmin, user.RoleRoomAdmin, user.RoleSecretary}
	adminBookingStatusH := handlers.NewAdminBookingStatusHandler(pool, bookingRepo)
	mux.Handle("/api/v1/admin/bookings/", tenantMW.Middleware(
		middleware.WithTenantTx(pool)(
			middleware.RequireRoleHandler(noShowRoles, func(w http.ResponseWriter, r *http.Request) {
				switch {
				case strings.HasSuffix(r.URL.Path, "/no-show"):
					adminBookingStatusH.MarkNoShow(w, r)
				case strings.HasSuffix(r.URL.Path, "/attended"):
					adminBookingStatusH.MarkAttended(w, r)
				default:
					http.NotFound(w, r)
				}
			}),
		),
	))

	// Approvals
	mux.Handle("/api/v1/approvals", tenantMW.Middleware(
		middleware.WithTenantTx(pool)(perm(approverRoles, "approval.decide", approvalH.Dispatch)),
	))
	mux.Handle("/api/v1/approvals/", tenantMW.Middleware(
		middleware.WithTenantTx(pool)(perm(approverRoles, "approval.decide", approvalH.Dispatch)),
	))

	// ---- Customization + reports ----
	// GET is readable by ANY authed user (everyone needs the brand colors,
	// locale, layout). Writes are admin-only — checked inside the dispatcher.
	mux.Handle("/api/v1/admin/customization", tenantMW.Middleware(
		middleware.RequireRoleHandler(allBookerRoles, customizationDispatchGuarded(customizationH, permMW)),
	))
	mux.Handle("/api/v1/reports/usage", tenantMW.Middleware(
		perm(adminRoles, "report.export", reportH.ExportUsageReport),
	))
	// Dashboard aggregates — landing page for every authenticated user
	// (tenant-scoped inside the repo).
	mux.Handle("/api/v1/reports/dashboard", tenantMW.Middleware(
		middleware.RequireRoleHandler(allBookerRoles, reportH.Dashboard),
	))
	// Current HK Observatory weather (temperature + signals) for the
	// dashboard widget — visible to every authenticated user.
	mux.Handle("/api/v1/weather", tenantMW.Middleware(
		middleware.RequireRoleHandler(allBookerRoles, weatherH.Current),
	))
	// On-screen report preview + generic per-type Excel/CSV export.
	mux.Handle("/api/v1/reports/data", tenantMW.Middleware(
		perm(adminRoles, "report.export", reportH.ReportData),
	))
	mux.Handle("/api/v1/reports/export", tenantMW.Middleware(
		perm(adminRoles, "report.export", reportH.ExportReport),
	))

	// ---- Admin module — every endpoint gated by a specific permission ----
	mux.Handle("/api/v1/admin/resources", tenantMW.Middleware(
		perm(roomAdminRoles, "resource.update", resH.Dispatch)))
	mux.Handle("/api/v1/admin/resources/", tenantMW.Middleware(
		perm(roomAdminRoles, "resource.update", resH.Dispatch)))

	// Wrapped in WithTenantTx so that writes to user_departments (added
	// in migration 032) execute under the per-request RLS GUC.
	// Without this the multi-statement DELETE+INSERT in
	// SetDepartmentIDs runs on autocommit connections with
	// app.current_tenant_id unset, which silently no-ops under RLS and
	// is also non-atomic against partial failure.
	mux.Handle("/api/v1/admin/users", tenantMW.Middleware(
		middleware.WithTenantTx(pool)(perm(adminRoles, "user.update", userH.Dispatch))))
	mux.Handle("/api/v1/admin/users/", tenantMW.Middleware(
		middleware.WithTenantTx(pool)(perm(adminRoles, "user.update", userH.Dispatch))))

	mux.Handle("/api/v1/admin/departments", tenantMW.Middleware(
		perm(adminRoles, "department.manage", deptH.Dispatch)))
	mux.Handle("/api/v1/admin/departments/", tenantMW.Middleware(
		perm(adminRoles, "department.manage", deptH.Dispatch)))

	mux.Handle("/api/v1/admin/holidays", tenantMW.Middleware(
		perm(adminRoles, "holiday.manage", holidayH.Dispatch)))
	mux.Handle("/api/v1/admin/holidays/", tenantMW.Middleware(
		perm(adminRoles, "holiday.manage", holidayH.Dispatch)))

	mux.Handle("/api/v1/admin/holidays/register", tenantMW.Middleware(
		middleware.RequireRoleHandler([]string{user.RoleSystemAdmin}, adminH.RegisterHoliday),
	))

	// Approval-rule CRUD (multi-level chain configuration)
	mux.Handle("/api/v1/admin/approval-rules", tenantMW.Middleware(
		perm(adminRoles, "approval_rule.manage", approvalRulesH.Dispatch)))
	mux.Handle("/api/v1/admin/approval-rules/", tenantMW.Middleware(
		perm(adminRoles, "approval_rule.manage", approvalRulesH.Dispatch)))

	// Webhook subscription CRUD + delivery audit
	mux.Handle("/api/v1/admin/webhooks", tenantMW.Middleware(
		perm(adminRoles, "webhook.manage", webhooksH.Dispatch)))
	mux.Handle("/api/v1/admin/webhooks/", tenantMW.Middleware(
		perm(adminRoles, "webhook.manage", webhooksH.Dispatch)))

	// Microsoft 365 / Google / Zoom integrations + room mailbox map
	mux.Handle("/api/v1/admin/integrations", tenantMW.Middleware(
		perm(adminRoles, "integration.manage", integrationsH.Dispatch)))
	mux.Handle("/api/v1/admin/integrations/", tenantMW.Middleware(
		perm(adminRoles, "integration.manage", integrationsH.Dispatch)))

	// Granular role × permission matrix
	mux.Handle("/api/v1/admin/permissions", tenantMW.Middleware(
		perm(adminRoles, "permission.manage", permissionsH.Dispatch)))
	mux.Handle("/api/v1/admin/permissions/", tenantMW.Middleware(
		perm(adminRoles, "permission.manage", permissionsH.Dispatch)))

	// Tenant-defined resource type catalog (Room, Vehicle, Gym, Studio, …)
	mux.Handle("/api/v1/admin/resource-types", tenantMW.Middleware(
		perm(adminRoles, "resource.create", resourceTypesH.Dispatch)))
	mux.Handle("/api/v1/admin/resource-types/", tenantMW.Middleware(
		perm(adminRoles, "resource.create", resourceTypesH.Dispatch)))

	// Admin-extensible permission catalog (custom groups + custom keys)
	mux.Handle("/api/v1/admin/permission-catalog", tenantMW.Middleware(
		perm(adminRoles, "permission.manage", permCatalogH.Dispatch)))
	mux.Handle("/api/v1/admin/permission-catalog/", tenantMW.Middleware(
		perm(adminRoles, "permission.manage", permCatalogH.Dispatch)))

	// ADDED: Catering & Services CRUD. Gated by a new 'service.manage' permission.
	mux.Handle("/api/v1/admin/services", tenantMW.Middleware(
		perm(adminRoles, "service.manage", serviceH.Dispatch)))
	mux.Handle("/api/v1/admin/services/", tenantMW.Middleware(
		perm(adminRoles, "service.manage", serviceH.Dispatch)))

	// Admin-drawn floor plans (used by the AdminBookings floor-plan view).
	// Reuses the same 'resource.update' permission as resources because both
	// govern the physical layout of bookable space — anyone who can move a
	// resource onto the floor plan should be able to draw the floor plan.
	mux.Handle("/api/v1/admin/floor-plans", tenantMW.Middleware(
		perm(roomAdminRoles, "resource.update", floorPlanH.Dispatch)))
	mux.Handle("/api/v1/admin/floor-plans/", tenantMW.Middleware(
		perm(roomAdminRoles, "resource.update", floorPlanH.Dispatch)))

	// Broadcast Messaging (R13). Active list is readable by every
	// authenticated user (header banner); management is admin-gated.
	mux.Handle("/api/v1/broadcasts", tenantMW.Middleware(
		middleware.RequireRoleHandler(allBookerRoles, broadcastH.ActiveForUser)))
	mux.Handle("/api/v1/admin/broadcasts", tenantMW.Middleware(
		perm(adminRoles, "broadcast.manage", broadcastH.Dispatch)))
	mux.Handle("/api/v1/admin/broadcasts/", tenantMW.Middleware(
		perm(adminRoles, "broadcast.manage", broadcastH.Dispatch)))

	// Location user groups (Room Privilege Setup by Organisation
	// Hierarchy — FSD spec p.12). Admin-scoped; reuses department.manage.
	mux.Handle("/api/v1/admin/location-groups", tenantMW.Middleware(
		perm(adminRoles, "department.manage", locationGroupH.Dispatch)))
	mux.Handle("/api/v1/admin/location-groups/", tenantMW.Middleware(
		perm(adminRoles, "department.manage", locationGroupH.Dispatch)))

	// Managed Locations CRUD (admin). Read path is the booker route above.
	mux.Handle("/api/v1/admin/locations", tenantMW.Middleware(
		perm(adminRoles, "department.manage", locationH.Dispatch)))
	mux.Handle("/api/v1/admin/locations/", tenantMW.Middleware(
		perm(adminRoles, "department.manage", locationH.Dispatch)))

	// Microsoft Teams app endpoints (manifest + JWT-validated bot webhook)
	mux.HandleFunc("/api/v1/teams/manifest", teamsH.Manifest)
	mux.HandleFunc("/api/v1/teams/messages", teamsH.Messages)

	// Microsoft Graph change-notifications webhook (no auth header — Graph
	// authenticates by signing inbound JWT in upper protocols; we verify
	// per-notification clientState ourselves).
	mux.HandleFunc("/api/v1/graph/notifications", graphNotifH.Handle)

	// SCIM 2.0 endpoints — bearer auth handled inside.
	mux.HandleFunc("/scim/v2/", scimH.Dispatch)

	// SCIM token issuance (in-app admin) — gated on user.create since
	// holding a SCIM token effectively delegates user creation rights.
	mux.Handle("/api/v1/admin/scim/tokens", tenantMW.Middleware(
		perm(adminRoles, "user.create", scimAdminH.Dispatch)))
	mux.Handle("/api/v1/admin/scim/tokens/", tenantMW.Middleware(
		perm(adminRoles, "user.create", scimAdminH.Dispatch)))

	// ---- Static SPA ----
	spaRoot := orDefault(os.Getenv("SPA_DIR"), "./src/presentation/web/spa/dist")
	mux.Handle("/app/", http.StripPrefix("/app/", spaFallback(spaRoot)))
	mux.Handle("/kiosk/", http.StripPrefix("/kiosk/", spaFallback(spaRoot)))
	mux.Handle("/", http.FileServer(http.Dir("./src/presentation/web/public")))

	// ---- Server with optional TLS ----
	addr := orDefault(os.Getenv("LISTEN_ADDR"), ":8080")
	// Outermost → innermost: tracing → metrics → logging → security headers → mux.
	// Trace span wraps the whole request; metrics see the final status; logging
	// records the request id; security headers go on every response.
	wrapped := observability.TracingMiddleware(
		observability.HTTPMiddleware(
			middleware.Logging(securityHeaders(mux))))

	srv := &http.Server{
		Addr:              addr,
		Handler:           wrapped,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	certFile := os.Getenv("TLS_CERT")
	keyFile := os.Getenv("TLS_KEY")

	// Graceful shutdown on SIGINT / SIGTERM so kubernetes rolling deploys
	// drain in-flight requests instead of severing them mid-write. The
	// SHUTDOWN_TIMEOUT env caps how long we wait for active handlers.
	stopCh := make(chan os.Signal, 1)
	signal.Notify(stopCh, syscall.SIGINT, syscall.SIGTERM)

	listenErr := make(chan error, 1)
	go func() {
		if certFile != "" && keyFile != "" {
			log.Printf("FSD MRBS Platform live on %s (TLS) — docs: %s/api/docs", addr, addr)
			listenErr <- srv.ListenAndServeTLS(certFile, keyFile)
			return
		}
		log.Printf("FSD MRBS Platform live on %s (HTTP) — docs: %s/api/docs", addr, addr)
		listenErr <- srv.ListenAndServe()
	}()

	select {
	case err := <-listenErr:
		if err != nil && err != http.ErrServerClosed {
			log.Fatalf("listen: %v", err)
		}
	case sig := <-stopCh:
		log.Printf("received %s, draining...", sig)
		timeout := durationEnv("SHUTDOWN_TIMEOUT", 30*time.Second)
		shutdownCtx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			log.Printf("shutdown: %v", err)
		}
	}
}

// readyzHandler returns 200 only when the API can serve traffic: the DB
// pool can complete a trivial round-trip within a short deadline. This is
// distinct from /healthz (liveness) and is the probe kubernetes should
// gate traffic on. RabbitMQ availability is intentionally NOT a readiness
// gate — message publishing degrades gracefully in handlers.
func readyzHandler(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		var n int
		if err := pool.QueryRow(ctx, "SELECT 1").Scan(&n); err != nil {
			http.Error(w, "db not ready: "+err.Error(), http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ready"})
	}
}

// loginHandler accepts either the legacy X-Username/X-Password headers or
// a JSON body { "username", "password" } for new clients. JSON over TLS is
// preferred — proxy logs commonly capture headers but not bodies.
//
// On successful authentication we upsert the directory user into the local
// users table so the admin portal (which lists from postgres) sees them.
// Without this, AD-only accounts like "officer" authenticate fine but never
// surface in the user list, breaking permissions / region-access editing.
func loginHandler(pool *pgxpool.Pool, adService ad.Service, userRepo postgres.UserRepository, auditRepo audit.Repository) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
			return
		}
		username := r.Header.Get("X-Username")
		password := r.Header.Get("X-Password")
		if username == "" || password == "" {
			var body struct {
				Username string `json:"username"`
				Password string `json:"password"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err == nil {
				username, password = body.Username, body.Password
			}
		}
		// Authentication: first try an app-managed LOCAL password (accounts
		// created via the admin portal store a bcrypt hash in postgres),
		// then fall back to the directory (AD/LDAP) for federated accounts
		// which carry no local hash.
		var authUser *user.User
		if local, lerr := userRepo.GetByUsername(r.Context(), getDefaultTenantID(), username); lerr == nil && local != nil && local.PasswordHash != "" {
			if bcrypt.CompareHashAndPassword([]byte(local.PasswordHash), []byte(password)) != nil {
				writeAuditAuth(r, auditRepo, audit.ActionLoginFailure, audit.OutcomeFailure, audit.SeverityWarning,
					local.ID, username, local.TenantID, "invalid local password")
				http.Error(w, "Invalid Credentials", http.StatusUnauthorized)
				return
			}
			authUser = local
		} else {
			ad, err := adService.Authenticate(r.Context(), username, password)
			if err != nil {
				writeAuditAuth(r, auditRepo, audit.ActionLoginFailure, audit.OutcomeFailure, audit.SeverityWarning,
					"", username, "", err.Error())
				http.Error(w, "Invalid Credentials", http.StatusUnauthorized)
				return
			}
			authUser = ad
			authUser.TenantID = getTenantIDForUser(authUser)
			// Reconcile the directory principal into postgres: prefer the
			// existing row's stable ID so FK references (bookings, audit)
			// keep pointing at the same user. The directory layer (dev
			// simulator) hands back non-UUID strings like "AD-9981" — mint a
			// deterministic UUIDv5 when no row exists yet. Local accounts
			// already have a row, so this only runs on the AD path.
			if existing, eerr := userRepo.GetByUsername(r.Context(), authUser.TenantID, authUser.Username); eerr == nil && existing != nil {
				authUser.ID = existing.ID
			} else if _, perr := uuid.Parse(authUser.ID); perr != nil {
				authUser.ID = uuid.NewSHA1(uuid.NameSpaceDNS, []byte("fsd-mrbs/"+authUser.TenantID+"/"+authUser.Username)).String()
			}
			if serr := userRepo.Save(r.Context(), *authUser); serr != nil {
				log.Printf("login: upsert directory user %q failed: %v", authUser.Username, serr)
			}
		}

		if !authUser.IsActive {
			writeAuditAuth(r, auditRepo, audit.ActionLoginFailure, audit.OutcomeDenied, audit.SeverityWarning,
				authUser.ID, username, getTenantIDForUser(authUser), "account inactive")
			http.Error(w, "Account Inactive", http.StatusForbidden)
			return
		}
		tenantID := getTenantIDForUser(authUser)
		authUser.TenantID = tenantID

		// Forced first-login reset: an admin-issued initial password must be
		// replaced before any session is granted. Hand back a short-lived
		// token scoped to the change-password exchange only.
		if authUser.MustChangePassword {
			change := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
				"sub":       authUser.ID,
				"tenant_id": tenantID,
				"scope":     "pwd_change",
				"exp":       time.Now().Add(10 * time.Minute).Unix(),
				"iat":       time.Now().Unix(),
			})
			changeSigned, _ := change.SignedString(middleware.JwtSecretKey)
			writeAuditAuth(r, auditRepo, audit.ActionLoginSuccess, audit.OutcomeSuccess, audit.SeverityInfo,
				authUser.ID, authUser.Username, tenantID, "password ok; must change")
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"must_change_password": true,
				"change_token":         changeSigned,
			})
			return
		}

		// If MFA is enrolled for this user, do NOT hand out a full session
		// JWT yet. Return a short-lived (5 min) token whose only legal use
		// is the /api/v1/mfa/verify exchange. The pending token is bound
		// to the user id and tenant so it can't be replayed as someone
		// else's challenge.
		if mfaEnabled, _ := userMFAEnabled(r.Context(), pool, authUser.ID, tenantID); mfaEnabled {
			pending := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
				"sub":       authUser.ID,
				"tenant_id": tenantID,
				"scope":     "mfa_pending",
				"exp":       time.Now().Add(5 * time.Minute).Unix(),
				"iat":       time.Now().Unix(),
			})
			pendingSigned, _ := pending.SignedString(middleware.JwtSecretKey)
			writeAuditAuth(r, auditRepo, audit.ActionLoginSuccess, audit.OutcomeSuccess, audit.SeverityInfo,
				authUser.ID, authUser.Username, tenantID, "password ok; awaiting mfa")
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"mfa_required": true,
				"mfa_token":    pendingSigned,
			})
			return
		}

		token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
			"sub":       authUser.ID,
			"tenant_id": tenantID,
			"role":      authUser.Role,
			"grade":     authUser.Grade,
			"regions":   authUser.RegionAccess,
			"dn":        authUser.DN,
			"exp":       time.Now().Add(8 * time.Hour).Unix(),
			"iat":       time.Now().Unix(),
		})
		signed, _ := token.SignedString(middleware.JwtSecretKey)
		writeAuditAuth(r, auditRepo, audit.ActionLoginSuccess, audit.OutcomeSuccess, audit.SeverityInfo,
			authUser.ID, authUser.Username, tenantID, "")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"token":     signed,
			"role":      authUser.Role,
			"tenant_id": tenantID,
			"grade":     authUser.Grade,
		})
	}
}

// changePasswordHandler completes a forced first-login reset. The caller
// holds only the short-lived change-token issued by loginHandler (scope
// "pwd_change"); on success we set the new password, clear the force-change
// flag, and hand back a full session so the user lands logged in.
func changePasswordHandler(userRepo postgres.UserRepository, auditRepo audit.Repository) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
			return
		}
		var body struct {
			ChangeToken string `json:"change_token"`
			NewPassword string `json:"new_password"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid payload", http.StatusBadRequest)
			return
		}
		if len(body.NewPassword) < 8 {
			http.Error(w, "password must be at least 8 characters", http.StatusBadRequest)
			return
		}
		tok, err := jwt.Parse(body.ChangeToken, func(t *jwt.Token) (interface{}, error) {
			if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
				return nil, errors.New("unexpected signing method")
			}
			return middleware.JwtSecretKey, nil
		})
		if err != nil || !tok.Valid {
			http.Error(w, "reset link expired — sign in again", http.StatusUnauthorized)
			return
		}
		claims, _ := tok.Claims.(jwt.MapClaims)
		if claims == nil || claims["scope"] != "pwd_change" {
			http.Error(w, "invalid reset token", http.StatusUnauthorized)
			return
		}
		userID, _ := claims["sub"].(string)
		tenantID, _ := claims["tenant_id"].(string)
		if userID == "" {
			http.Error(w, "invalid reset token", http.StatusUnauthorized)
			return
		}
		hash, herr := bcrypt.GenerateFromPassword([]byte(body.NewPassword), bcrypt.DefaultCost)
		if herr != nil {
			http.Error(w, "could not hash password", http.StatusInternalServerError)
			return
		}
		if serr := userRepo.SetPassword(r.Context(), userID, string(hash)); serr != nil {
			http.Error(w, "could not set password", http.StatusInternalServerError)
			return
		}
		// Load the refreshed row to mint a normal session token.
		u, gerr := userRepo.GetByID(r.Context(), userID)
		if gerr != nil {
			http.Error(w, "could not load user", http.StatusInternalServerError)
			return
		}
		writeAuditAuth(r, auditRepo, audit.ActionLoginSuccess, audit.OutcomeSuccess, audit.SeverityInfo,
			u.ID, u.Username, tenantID, "password changed; session issued")
		token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
			"sub":       u.ID,
			"tenant_id": tenantID,
			"role":      u.Role,
			"grade":     u.Grade,
			"regions":   u.RegionAccess,
			"dn":        u.DN,
			"exp":       time.Now().Add(8 * time.Hour).Unix(),
			"iat":       time.Now().Unix(),
		})
		signed, _ := token.SignedString(middleware.JwtSecretKey)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"token":     signed,
			"role":      u.Role,
			"tenant_id": tenantID,
			"grade":     u.Grade,
		})
	}
}

// userMFAEnabled is a tiny inline query so loginHandler can branch without
// taking a new repo dependency. Returns (false, nil) when the row is
// missing — MFA simply isn't enforced for that user yet.
func userMFAEnabled(ctx context.Context, pool *pgxpool.Pool, userID, tenantID string) (bool, error) {
	var enabled bool
	err := pool.QueryRow(ctx,
		`SELECT COALESCE(mfa_enabled, FALSE) FROM users WHERE id = $1 AND tenant_id = $2`,
		userID, tenantID).Scan(&enabled)
	return enabled, err
}

// mfaVerifyHandler exchanges a `scope=mfa_pending` token plus a TOTP code
// for a full session JWT. The pending token is bound to the user id and
// tenant the password step established; the code is verified against the
// user's stored TOTP secret. On success an audit row marks the completed
// step-up; on failure the row is severity=warning so SIEM rules can fire.
func mfaVerifyHandler(pool *pgxpool.Pool, userRepo postgres.UserRepository, auditRepo audit.Repository) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
			return
		}
		var body struct {
			MFAToken string `json:"mfa_token"`
			Code     string `json:"code"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.MFAToken == "" || body.Code == "" {
			http.Error(w, "mfa_token and code required", http.StatusBadRequest)
			return
		}
		tok, err := jwt.Parse(body.MFAToken, func(t *jwt.Token) (interface{}, error) {
			if t.Method.Alg() != jwt.SigningMethodHS256.Alg() {
				return nil, jwt.ErrSignatureInvalid
			}
			return middleware.JwtSecretKey, nil
		}, jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}), jwt.WithExpirationRequired())
		if err != nil || !tok.Valid {
			http.Error(w, "invalid mfa token", http.StatusUnauthorized)
			return
		}
		claims, _ := tok.Claims.(jwt.MapClaims)
		if scope, _ := claims["scope"].(string); scope != "mfa_pending" {
			http.Error(w, "mfa token has wrong scope", http.StatusUnauthorized)
			return
		}
		userID, _ := claims["sub"].(string)
		tenantID, _ := claims["tenant_id"].(string)
		if userID == "" || tenantID == "" {
			http.Error(w, "mfa token missing claims", http.StatusUnauthorized)
			return
		}
		var secret string
		_ = pool.QueryRow(r.Context(),
			`SELECT COALESCE(mfa_secret,'') FROM users WHERE id = $1 AND tenant_id = $2`,
			userID, tenantID).Scan(&secret)
		if secret == "" {
			http.Error(w, "mfa not enrolled", http.StatusUnauthorized)
			return
		}
		ok, err := mfa.Verify(secret, body.Code)
		if err != nil || !ok {
			writeAuditAuth(r, auditRepo, audit.ActionLoginFailure, audit.OutcomeDenied, audit.SeverityWarning,
				userID, "", tenantID, "bad totp code")
			http.Error(w, "invalid code", http.StatusUnauthorized)
			return
		}
		// Recover the role/grade/regions to build the final JWT.
		u, err := userRepo.GetByID(r.Context(), userID)
		if err != nil || u == nil || u.TenantID != tenantID {
			http.Error(w, "user lookup failed", http.StatusInternalServerError)
			return
		}
		token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
			"sub":       u.ID,
			"tenant_id": tenantID,
			"role":      u.Role,
			"grade":     u.Grade,
			"regions":   u.RegionAccess,
			"dn":        u.DN,
			"exp":       time.Now().Add(8 * time.Hour).Unix(),
			"iat":       time.Now().Unix(),
		})
		signed, _ := token.SignedString(middleware.JwtSecretKey)
		writeAuditAuth(r, auditRepo, audit.ActionLoginSuccess, audit.OutcomeSuccess, audit.SeverityInfo,
			u.ID, u.Username, tenantID, "mfa ok")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"token":     signed,
			"role":      u.Role,
			"tenant_id": tenantID,
			"grade":     u.Grade,
		})
	}
}

// writeAuditAuth appends an authentication-related audit entry. Failures
// to write the audit row are logged but do not block the response — the
// auth decision must not depend on audit availability.
func writeAuditAuth(r *http.Request, repo audit.Repository, action, outcome, severity, actorID, username, tenantID, detail string) {
	if repo == nil {
		return
	}
	ip := clientIP(r)
	ua := r.UserAgent()
	tid := tenantID
	if tid == "" {
		tid = getDefaultTenantID()
	}
	entry := audit.AuditEntry{
		ID:           uuid.NewString(),
		TenantID:     tid,
		Timestamp:    time.Now().UTC(),
		ActorUserID:  actorID,
		ActionType:   action,
		TargetEntity: audit.TargetEntityUser,
		TargetID:     username,
		IPAddress:    ip,
		UserAgent:    ua,
		Outcome:      outcome,
		Severity:     severity,
		NewState:     map[string]interface{}{"username": username, "detail": detail},
	}
	if err := repo.Save(r.Context(), entry); err != nil {
		log.Printf("audit: %s failed for %q: %v", action, username, err)
	}
}

// clientIP returns the caller IP, honouring X-Forwarded-For only when the
// request arrives through a trusted proxy. For now we accept the first
// X-Forwarded-For hop; this is acceptable for audit attribution because
// audit IPs are informational, not authority.
func clientIP(r *http.Request) string {
	raw := r.RemoteAddr
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		raw = xff
		if comma := strings.Index(raw, ","); comma > 0 {
			raw = raw[:comma]
		}
	}
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	// audit_entries.ip_address is inet; strip the port if RemoteAddr
	// gave us "host:port".
	if host, _, err := net.SplitHostPort(raw); err == nil {
		return host
	}
	return raw
}

func customizationDispatch(h *handlers.CustomizationHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			h.Get(w, r)
		case http.MethodPut, http.MethodPost:
			h.Put(w, r)
		case http.MethodDelete:
			h.ResetToFSD(w, r)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	}
}

// customizationDispatchGuarded lets every authenticated user GET the
// document (it's the source of truth for brand colors / locale / layout
// the SPA needs at boot), but PUT/DELETE require customization.manage.
func customizationDispatchGuarded(h *handlers.CustomizationHandler, mw *middleware.PermissionMiddleware) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			h.Get(w, r)
			return
		case http.MethodPut, http.MethodPost:
			mw.RequireFunc("customization.manage", h.Put).ServeHTTP(w, r)
			return
		case http.MethodDelete:
			mw.RequireFunc("customization.manage", h.ResetToFSD).ServeHTTP(w, r)
			return
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	}
}

func healthzHandler(hub *realtime.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status": "ok",
			"ws":     hub.Stats(),
			"time":   time.Now().UTC(),
		})
	}
}

func spaFallback(root string) http.Handler {
	fs := http.FileServer(http.Dir(root))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if strings.Contains(path, ".") || path == "" {
			fs.ServeHTTP(w, r)
			return
		}
		http.ServeFile(w, r, root+"/index.html")
	})
}

// securityHeaders applies a government-grade baseline of HTTP security
// headers on every response.
//
// The CSP is tight: same-origin scripts/styles plus a single
// /api/v1/realtime WebSocket. Images additionally allow HTTPS from any
// origin so tenant-configured logos / avatars / branding images don't
// trip CSP — images carry no script execution surface, and forcing every
// customer to host their logo on our origin is impractical for a
// multi-tenant SaaS. HTTP images are still blocked (mixed-content +
// upgrade-insecure-requests handle the rest).
//
// Cross-Origin-Embedder-Policy is intentionally NOT set to require-corp:
// we don't use SharedArrayBuffer or wasm threads, and require-corp would
// reject any external logo CDN that doesn't return CORP/CORS consent
// headers (which most don't). Leaving it unset is the right trade-off
// for the branding-image use case.
//
// `frame-ancestors 'none'` is the modern equivalent of X-Frame-Options
// and is the one browsers consult — XFO is left in for legacy crawlers.
//
// HSTS is only emitted when the request arrived over TLS. A request
// can be considered TLS-bearing in one of two ways:
//
//   1. `r.TLS != nil` — direct TLS termination on the Go process.
//   2. The operator opted in to honouring `X-Forwarded-Proto: https`
//      by setting `TRUST_FORWARDED_PROTO=true`. This MUST only be
//      enabled when a sanitising reverse proxy (nginx, Cloudfront,
//      ALB) is in front and is guaranteed to strip the header on
//      every inbound request. Trusting the header from any client is
//      the classic spoofable-HSTS-pin pitfall: an attacker could
//      sneak `X-Forwarded-Proto: https` past a misconfigured proxy
//      and permanently pin a victim to https on an origin that
//      doesn't actually serve TLS, effectively a self-DoS.
//
// We log a one-shot warning at boot when TRUST_FORWARDED_PROTO is on
// so operators see in the logs that the relaxed mode is active.
func securityHeaders(next http.Handler) http.Handler {
	csp := strings.Join([]string{
		"default-src 'self'",
		"script-src 'self'",
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob: https:",
		"font-src 'self' data:",
		"connect-src 'self' ws: wss:",
		"frame-ancestors 'none'",
		"base-uri 'self'",
		"form-action 'self'",
		"object-src 'none'",
		"upgrade-insecure-requests",
	}, "; ")
	trustForwardedProto := strings.EqualFold(os.Getenv("TRUST_FORWARDED_PROTO"), "true")
	if trustForwardedProto {
		log.Println("WARNING: TRUST_FORWARDED_PROTO=true — HSTS will trust X-Forwarded-Proto from upstream. Ensure the reverse proxy strips this header on inbound requests.")
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		if r.TLS != nil || (trustForwardedProto && r.Header.Get("X-Forwarded-Proto") == "https") {
			h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload")
		}
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()")
		h.Set("Content-Security-Policy", csp)
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		next.ServeHTTP(w, r)
	})
}

func orDefault(v, d string) string {
	if v == "" {
		return d
	}
	return v
}

// intEnv reads an int from env, falling back to def on empty/invalid input.
func intEnv(key string, def int) int {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 {
		log.Printf("warning: %s=%q is not a valid non-negative integer, using default %d", key, v, def)
		return def
	}
	return n
}

// durationEnv reads a Go duration string (e.g. "5m", "30s") from env,
// falling back to def on empty/invalid input.
func durationEnv(key string, def time.Duration) time.Duration {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		log.Printf("warning: %s=%q is not a valid duration, using default %v", key, v, def)
		return def
	}
	return d
}

func getTenantIDForUser(u *user.User) string {
	if u.TenantID != "" {
		return u.TenantID
	}
	return getDefaultTenantID()
}

func getDefaultTenantID() string {
	if v := os.Getenv("DEFAULT_TENANT_ID"); v != "" {
		return v
	}
	return "00000000-0000-0000-0000-000000000001"
}

// seedSimulatorUsers writes the dev simulator's well-known directory accounts
// into postgres so the admin portal shows them on first boot. The users table
// uses UUID primary keys, so we mint a deterministic UUIDv5 per username —
// re-seeding produces the same id, and ON CONFLICT (tenant_id, username) keeps
// the row idempotent.
func seedSimulatorUsers(ctx context.Context, repo postgres.UserRepository, tenantID string) {
	seeds := []user.User{
		{
			Username: "admin",
			DN:       "CN=System Admin,OU=IT,DC=fsd,DC=gov,DC=hk",
			Role:     user.RoleSystemAdmin,
			Grade:    "SDO",
			IsActive: true, RegionAccess: []string{"Hong Kong", "Kowloon", "New Territories"},
		},
		{
			Username: "officer",
			DN:       "CN=Fire Officer,OU=Operations,DC=fsd,DC=gov,DC=hk",
			Role:     user.RoleGeneralUser,
			IsActive: true, RegionAccess: []string{"Hong Kong"},
		},
		{
			Username: "secretary",
			DN:       "CN=DGFS Secretary,OU=Senior,DC=fsd,DC=gov,DC=hk",
			Role:     user.RoleSecretary, Grade: "SDO", IsActive: true,
		},
	}
	for _, u := range seeds {
		u.TenantID = tenantID
		// Reuse the existing row's UUID if one is already present so FK
		// references in bookings / audit stay valid.
		if existing, err := repo.GetByUsername(ctx, tenantID, u.Username); err == nil && existing != nil {
			u.ID = existing.ID
		} else {
			u.ID = uuid.NewSHA1(uuid.NameSpaceDNS, []byte("fsd-mrbs-sim/"+tenantID+"/"+u.Username)).String()
		}
		if err := repo.Save(ctx, u); err != nil {
			log.Printf("seed simulator user %q: %v", u.Username, err)
		}
	}
}
