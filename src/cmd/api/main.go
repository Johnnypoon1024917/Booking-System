// FSD MRBS API server entry point.
//
// This binary serves three concerns:
//   1. The JSON API for the SPA / kiosks / external integrations
//   2. The WebSocket realtime stream
//   3. Static asset serving for the SPA bundle (single-binary deploy)
//
// Background workers (notification SMTP, scheduler) live in
// src/cmd/worker and src/cmd/scheduler so they can be scaled independently.
package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"fsd-mrbs/src/application/api/handlers"
	"fsd-mrbs/src/application/usecase"
	"fsd-mrbs/src/domain/user"
	"fsd-mrbs/src/infrastructure/ad"
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
		log.Println("DB_DSN not set; using local default")
		dbURL = "postgres://mrbs_admin:SecurePass123!@localhost:5432/fsd_mrbs?sslmode=disable"
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

	// --- Infra
	pimm := rabbitmq.NewRabbitMQPublisher(os.Getenv("RABBITMQ_URL"))
	adService := ad.NewLDAPService(os.Getenv("LDAP_URL"))
	hub := realtime.NewHub()
	hkClient := external.NewGovHKHolidayClient(0)

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
		WithZoomMaskBase(orDefault(os.Getenv("ZOOM_MASK_BASE"), "https://ess.hkfsd.hksarg/redirect"))
	reportUC := usecase.NewGenerateReportUseCase(reportRepo)
	checkinUC := usecase.NewCheckinUseCase(checkinRepo, bookingRepo)
	approvalUC := usecase.NewApprovalUseCase(bookingRepo, resourceRepo, approvalRepo, pimm)
	updateUC := usecase.NewUpdateBookingUseCase(bookingRepo, pimm)
	_ = usecase.NewExpandRecurringBookingUseCase(bookingRepo, seriesRepo)
	_ = seriesRepo

	// --- Handlers
	adminH := handlers.NewAdminHandler(usecase.NewAdminManagerUseCase(adminRepo))
	bookingH := handlers.NewBookingHandler(resourceRepo, bookingUC)
	reportH := handlers.NewReportHandler(reportUC)
	customizationH := handlers.NewCustomizationHandler(customizationRepo)
	checkinH := handlers.NewCheckinHandler(checkinUC)
	realtimeH := handlers.NewRealtimeHandler(hub)
	resH := handlers.NewAdminResourceHandler(resourceRepo)
	userH := handlers.NewAdminUserHandler(userRepo)
	deptH := handlers.NewAdminDepartmentHandler(deptRepo)
	holidayH := handlers.NewAdminHolidayHandler(holidayRepo, hkClient,
		orDefault(os.Getenv("DEFAULT_ADMIN_USER_ID"), "11111111-1111-1111-1111-111111111111"))
	approvalH := handlers.NewApprovalHandler(approvalUC, bookingRepo).WithChain(chainUC, approvalStepRepo)
	lifecycleH := handlers.NewBookingLifecycleHandler(bookingRepo, updateUC)
	approvalRulesH := handlers.NewAdminApprovalRulesHandler(approvalRuleRepo)
	webhooksH := handlers.NewAdminWebhooksHandler(pool)
	resourceTypeRepo := postgres.NewResourceTypeRepo(pool)
	resourceTypesH := handlers.NewAdminResourceTypesHandler(resourceTypeRepo)
	permCatalogRepo := postgres.NewPermissionCatalogRepo(pool)
	permCatalogH := handlers.NewAdminPermissionCatalogHandler(permCatalogRepo)

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

	// /login: 5 attempts per 5 min then 15-min lockout per IP+username.
	loginLimiter := middleware.NewRateLimiter(5, 5*time.Minute, 15*time.Minute)
	// Write endpoints: 60 / minute / IP.
	writeLimiter := middleware.NewRateLimiter(60, time.Minute, time.Minute)

	mux := http.NewServeMux()

	// ---- Public ----
	mux.Handle("/api/v1/login", loginLimiter.LoginGuard(http.HandlerFunc(loginHandler(adService, userRepo))))
	mux.HandleFunc("/api/v1/checkin/", checkinH.Redeem)
	mux.HandleFunc("/api/v1/healthz", healthzHandler(hub))
	mux.HandleFunc("/api/openapi.json", apispec.SpecHandler)
	mux.HandleFunc("/api/docs", apispec.SwaggerUIHandler)
	mux.HandleFunc("/api/v1/realtime", realtimeH.ServeWS)
	mux.Handle("/api/metrics", observability.MetricsHandler())

	allBookerRoles := []string{user.RoleGeneralUser, user.RoleRoomAdmin, user.RoleSecretary, user.RoleSystemAdmin, user.RoleSecurityAdmin}
	approverRoles := []string{user.RoleSystemAdmin, user.RoleSecurityAdmin, user.RoleRoomAdmin, user.RoleSecretary}
	adminRoles := []string{user.RoleSystemAdmin, user.RoleSecurityAdmin}
	roomAdminRoles := []string{user.RoleSystemAdmin, user.RoleSecurityAdmin, user.RoleRoomAdmin}

	// ---- Bookings ----
	// Search is gated by booking.create (anyone who can book needs to find rooms).
	mux.Handle("/api/v1/bookings/search", tenantMW.Middleware(
		perm(allBookerRoles, "booking.create", bookingH.SearchAvailableRooms),
	))
	mux.Handle("/api/v1/bookings", writeLimiter.Middleware(tenantMW.Middleware(
		perm(allBookerRoles, "booking.create",
			idemMW.Wrap(http.HandlerFunc(bookingH.CreateBooking)).ServeHTTP),
	)))

	// Booking edit / cancel / get-one — methods gate inside lifecycle handler
	mux.Handle("/api/v1/bookings/", tenantMW.Middleware(
		perm(allBookerRoles, "booking.update", lifecycleH.DispatchOne),
	))

	// My bookings — every authenticated user can see their own
	mux.Handle("/api/v1/me/bookings", tenantMW.Middleware(
		middleware.RequireRoleHandler(allBookerRoles, lifecycleH.ListMine),
	))

	// Approvals
	mux.Handle("/api/v1/approvals", tenantMW.Middleware(
		perm(approverRoles, "approval.decide", approvalH.Dispatch),
	))
	mux.Handle("/api/v1/approvals/", tenantMW.Middleware(
		perm(approverRoles, "approval.decide", approvalH.Dispatch),
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

	// ---- Admin module — every endpoint gated by a specific permission ----
	mux.Handle("/api/v1/admin/resources", tenantMW.Middleware(
		perm(roomAdminRoles, "resource.update", resH.Dispatch)))
	mux.Handle("/api/v1/admin/resources/", tenantMW.Middleware(
		perm(roomAdminRoles, "resource.update", resH.Dispatch)))

	mux.Handle("/api/v1/admin/users", tenantMW.Middleware(
		perm(adminRoles, "user.update", userH.Dispatch)))
	mux.Handle("/api/v1/admin/users/", tenantMW.Middleware(
		perm(adminRoles, "user.update", userH.Dispatch)))

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
	if certFile != "" && keyFile != "" {
		log.Printf("FSD MRBS Platform live on %s (TLS) — docs: %s/api/docs", addr, addr)
		log.Fatal(srv.ListenAndServeTLS(certFile, keyFile))
	}
	log.Printf("FSD MRBS Platform live on %s (HTTP) — docs: %s/api/docs", addr, addr)
	log.Fatal(srv.ListenAndServe())
}

// loginHandler accepts either the legacy X-Username/X-Password headers or
// a JSON body { "username", "password" } for new clients. JSON over TLS is
// preferred — proxy logs commonly capture headers but not bodies.
//
// On successful authentication we upsert the directory user into the local
// users table so the admin portal (which lists from postgres) sees them.
// Without this, AD-only accounts like "officer" authenticate fine but never
// surface in the user list, breaking permissions / region-access editing.
func loginHandler(adService ad.Service, userRepo postgres.UserRepository) http.HandlerFunc {
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
		authUser, err := adService.Authenticate(r.Context(), username, password)
		if err != nil {
			http.Error(w, "Invalid Credentials", http.StatusUnauthorized)
			return
		}
		if !authUser.IsActive {
			http.Error(w, "Account Inactive", http.StatusForbidden)
			return
		}
		tenantID := getTenantIDForUser(authUser)
		authUser.TenantID = tenantID

		// Reconcile with postgres: prefer the existing row's stable ID so
		// FK references (bookings, audit) keep pointing at the same user.
		// The directory layer (especially the dev simulator) hands back
		// non-UUID strings like "AD-9981" — users.id is UUID, so we mint a
		// deterministic UUIDv5 when no row exists yet.
		if existing, err := userRepo.GetByUsername(r.Context(), tenantID, authUser.Username); err == nil && existing != nil {
			authUser.ID = existing.ID
		} else if _, err := uuid.Parse(authUser.ID); err != nil {
			authUser.ID = uuid.NewSHA1(uuid.NameSpaceDNS, []byte("fsd-mrbs/"+tenantID+"/"+authUser.Username)).String()
		}
		if err := userRepo.Save(r.Context(), *authUser); err != nil {
			log.Printf("login: upsert directory user %q failed: %v", authUser.Username, err)
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
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"token":     signed,
			"role":      authUser.Role,
			"tenant_id": tenantID,
			"grade":     authUser.Grade,
		})
	}
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

// securityHeaders applies a sane baseline of HTTP security headers.
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		next.ServeHTTP(w, r)
	})
}

func orDefault(v, d string) string {
	if v == "" {
		return d
	}
	return v
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
