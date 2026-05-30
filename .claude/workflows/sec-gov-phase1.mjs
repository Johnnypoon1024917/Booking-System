export const meta = {
  name: 'sec-gov-phase1',
  description: 'Phase 1: Security & Governance features + 6 modal CSS bug fixes (fsd-v2)',
  phases: [
    { title: 'Backend', detail: 'audit-on-save + SSO security-context (be1), sessions + retention (be2), CSS bug fixes — disjoint files, parallel' },
    { title: 'Frontend', detail: 'api client methods, then Settings security tab + Tenant Studio history/retention in parallel' },
    { title: 'Verify', detail: 'backend+frontend typecheck/build with fixes, then adversarial auth/session review' },
  ],
}

// ---------------------------------------------------------------------------
// Shared context every agent needs. Project is a NestJS (TypeORM) backend +
// React (Vite) frontend under fsd-v2/. Windows host, PowerShell shell. Do NOT
// start dev servers. Match existing code style exactly. The SPA must use the
// custom dialog helpers (confirmDialog/promptDialog/alertDialog from
// stores/confirm.ts) — NEVER native window.confirm/prompt/alert.
// ---------------------------------------------------------------------------
const COMMON = `
PROJECT GROUND TRUTH (already verified — do not re-explore unless needed):
- Backend root: fsd-v2/backend/src ; modules live under modules/<name>/.
- Global API prefix is "api/v1", so a @Controller('foo') route is reached by the SPA at /api/v1/foo.
- Auth: global JwtAuthGuard protects everything; opt out with @Public(). Admin-only routes use
  @UseGuards(RolesGuard) + @RequireRoles(...AdminRoles) (from common/decorators/roles.decorator).
- Current user: @CurrentUser() u: AuthUser (common/decorators/current-user.decorator). AuthUser =
  { id, tenantId, username, role, grade?, regionAccess? }.
- AuditService (modules/audit/audit.service.ts) exposes:
    record(user: AuthUser, ev: { action; severity?; outcome?; targetEntity?; targetId?; previous?; next? })
    list(tenantId, limit)
  AuditModule is imported early in app.module.ts and exports AuditService; import AuditModule to inject it.
- Frontend root: fsd-v2/frontend/src. API client: api/client.ts (object 'api' with methods returning r.data).
  Toaster: stores/toast (useToast). Custom dialogs: stores/confirm (confirmDialog/promptDialog/alertDialog) —
  NEVER use native window.confirm/prompt/alert. Buttons use className "btn-fsd" / "btn-fsd ghost" /
  "btn-fsd danger". Cards "fsd-card" or "card". i18n via useT() in some pages (Settings uses t('...')).
- Windows + PowerShell. Do NOT launch servers. Keep diffs minimal and idiomatic.
`

const CONTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['endpoints', 'customizationDefaults', 'notes'],
  properties: {
    endpoints: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['method', 'spaPath', 'description'],
        properties: {
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'] },
          spaPath: { type: 'string', description: 'Full SPA-facing path incl. /api/v1 prefix' },
          description: { type: 'string' },
          requestShape: { type: 'string', description: 'JSON body / query shape, or "none"' },
          responseShape: { type: 'string', description: 'JSON response shape' },
        },
      },
    },
    customizationDefaults: {
      type: 'array',
      description: 'New keys added to defaultCustomization (customization.entity.ts), if any',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'default', 'description'],
        properties: { key: { type: 'string' }, default: { type: 'string' }, description: { type: 'string' } },
      },
    },
    filesChanged: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string', description: 'Anything the frontend must know to wire this correctly' },
  },
}

// ===========================================================================
// PHASE 1 — Backend (be1, be2) + CSS, all on disjoint files → parallel
// ===========================================================================
phase('Backend')

const BE1 = `${COMMON}
TASK (Backend group 1 — Configuration Audit Trails + IdP-aware MFA). You own ONLY these files:
  fsd-v2/backend/src/modules/customization/{customization.service.ts,customization.controller.ts,customization.module.ts}
  fsd-v2/backend/src/modules/audit/{audit.service.ts,audit.controller.ts}
  fsd-v2/backend/src/modules/sso/{sso.service.ts,sso.controller.ts}
Do NOT touch app.module.ts, auth.*, jwt.strategy.ts, or any sessions/retention code — another agent owns those.

1) AUDIT-ON-SAVE (Configuration Audit Trails / Change History):
   - CustomizationService.save() currently does NOT write an audit entry. Change save() so it records an
     audit diff: read the existing row's data BEFORE upsert (previous), and pass it + the merged result (next)
     to AuditService.record with action 'customization.update', targetEntity 'customization'.
   - The audit record needs the AuthUser. Change the save signature to accept the user:
     save(user: AuthUser, data) and update CustomizationController.save to pass @CurrentUser().
   - Wire AuditService into CustomizationModule (import AuditModule; CustomizationService constructor injects it).
   - To make the change history queryable: add an optional 'action' filter to AuditService.list(tenantId, limit, action?)
     and to AuditController.list via a @Query('action') param. Keep existing callers working (action optional).
   - Store a compact diff in previous/next: the full customization JSON is fine (it is small JSONB).

2) IdP-AWARE MFA — security context endpoint:
   - Add an AUTHENTICATED (not @Public) endpoint the SPA calls to learn if the tenant's security is org-managed.
     Put it on SsoController, e.g. @Get('security-context') returning
     { ssoEnforced: boolean, providerName?: string }.
   - Implement SsoService.securityContext(tenantId): a tenant is "SSO enforced" if it has an enabled
     IdentityProvider whose config.enforced === true (saml/oauth2 = the IdP-managed kinds). Return the first
     such provider's name. If none, ssoEnforced=false. (config is the existing jsonb column.)

VERIFY your slice compiles: run a TypeScript check on the backend (e.g. in fsd-v2/backend:
  npx tsc -p tsconfig.json --noEmit  — or 'npm run build' if that's the project's check). Fix any errors you introduce.
Return the CONTRACT (endpoints with /api/v1 paths, any customizationDefaults you added (none expected here),
filesChanged, and notes for the frontend — especially the exact audit list path + how to filter by action,
and the security-context response shape).`

const BE2 = `${COMMON}
TASK (Backend group 2 — Active Session Management + Automated Data Retention). You own NEW module files plus
these existing files (no other agent touches them): app.module.ts, modules/auth/auth.service.ts,
modules/auth/auth.module.ts, modules/auth/jwt.strategy.ts. Do NOT touch customization/*, sso/*, or audit/* files.

1) ACTIVE SESSION MANAGEMENT — make it ADDITIVE and SAFE (must not lock out existing tokens):
   - Create modules/sessions/: session.entity.ts (UserSession: id uuid, tenantId, userId, jti unique, device?,
     browser?, ip?, userAgent?, createdAt, lastActiveAt, revokedAt nullable), sessions.service.ts,
     sessions.controller.ts, sessions.module.ts. Follow the style of an existing simple module (e.g. audit or scim).
   - On login (AuthService.issueAccessToken or the login path): mint a random jti, add it to the JWT claims, and
     create a UserSession row. Parse device/browser from the User-Agent (a tiny inline parser is fine — no new deps)
     and capture client IP. You'll need request context: pass userAgent/ip into the issue path from the controller
     (inspect modules/auth/auth.controller.ts for the login handler and thread them through). If wiring the request
     into issueAccessToken is invasive, create the session in the controller after issuing instead — your call,
     keep it clean.
   - jwt.strategy.ts: after the existing payload validation, if payload.jti is present, look up the session; if it
     exists and revokedAt is set, throw UnauthorizedException. If jti is ABSENT (legacy tokens) or no row is found,
     ALLOW the request (backward compatible). Opportunistically bump lastActiveAt at most every ~5 minutes to avoid
     a write per request. JwtStrategy will need the repo injected — register it via SessionsModule and ensure the
     strategy can access it (PassportStrategy providers are in AuthModule; import what you need without creating a
     circular module dependency — a forwardRef or moving the repo into AuthModule's TypeOrmModule.forFeature is fine).
   - sessions.controller.ts (authenticated, the calling user's own sessions):
       GET /sessions            -> list caller's non-revoked sessions (mark which is current via the caller's jti)
       POST /sessions/revoke-others -> revoke every session for the caller EXCEPT the current jti
     The SPA needs to know which row is "this device": include isCurrent based on req.user jti. To know the caller's
     jti in the controller, add jti to the AuthUser returned by jwt.strategy.validate (extend the AuthUser shape
     minimally) OR read it from the validated payload — pick the least invasive route and document it in notes.

2) AUTOMATED DATA RETENTION:
   - Add customization default key 'anonymize_bookings_after_days' (number, default 0 meaning OFF). NOTE: the
     customization.entity.ts defaultCustomization object is owned by THIS task — add the key there.
   - Create modules/retention/: retention.service.ts with an @Cron (use @nestjs/schedule, already imported in
     app.module via ScheduleModule.forRoot()) daily job that, per tenant with anonymize_bookings_after_days > 0,
     anonymizes bookings whose end time is older than N days. REUSE the anonymisation approach already in
     modules/dsar/dsar.service.ts (read it first; call into it or replicate its field-scrubbing — do not invent a
     new scheme). Add a manual admin trigger endpoint POST /admin/retention/run (RolesGuard + AdminRoles) returning
     { anonymized: number } so it is testable without waiting for the cron. retention.module.ts wires it.
   - Audit the run: record an AuditService entry action 'retention.anonymize' with the count (import AuditModule).
   - Register SessionsModule and RetentionModule in app.module.ts imports.

VERIFY your slice compiles (fsd-v2/backend: npx tsc -p tsconfig.json --noEmit, or npm run build). Fix errors you introduce.
Return the CONTRACT (endpoints with /api/v1 paths, customizationDefaults you added, filesChanged, and notes —
ESPECIALLY: exact session list/revoke response shapes, the isCurrent mechanism, and the retention trigger path).`

const CSS = `${COMMON}
TASK (CSS modal/theme bug fixes). Edit ONLY fsd-v2/frontend/src/styles/index.css. The line numbers in this brief
are from an older revision and will NOT match — LOCATE each rule by its selector/value via search, then fix. Make
the minimal change for each; keep surrounding style conventions.

Fix these 6 bugs:
1) Date-picker vs textbox selector mismatch: there is a uniform modal control block where date inputs are targeted
   as descendants (".modal section input[type=date]") but text/email inputs as DIRECT children
   (".modal section > input[type=text]" and "... > input[type=email]"). Because inputs are usually wrapped in a
   label/div, the '>' makes text/email fall back to legacy styling. FIX: remove the '>' so they match as
   descendants too (".modal section input[type=text]", ".modal section input[type=email]").
2) "Frankenstein" modal footer buttons: modal inputs are modern (border-radius:10px, min-height:44px, font-size:14px)
   but ".modal footer .btn" only sets background, inheriting legacy geometry (sharp/small). FIX: add border-radius
   and a matching height/padding/font-size override to ".modal footer .btn" so buttons match the inputs.
3) Dark-mode ghost-button "flashbang": ".btn-fsd.ghost:hover" hardcodes a light background (e.g. #f5f6f8). FIX:
   add a [data-theme="dark"] override for .btn-fsd.ghost:hover using a subtle dark hover surface (use an existing
   dark surface var if one exists; otherwise a sensible dark gray).
4) Z-index trap: ".menu" (dropdown) has a lower z-index than the modal ".overlay", so dropdowns inside a modal
   render behind the backdrop. FIX: ensure ".menu" (or a modal-scoped ".modal .menu") gets a z-index ABOVE the
   overlay so dropdowns inside modals are clickable.
5) Table sort caret broken by WCAG !important: a rule like ".caret, table.dt th .caret { color:#5f6875 !important }"
   overrides the active-sort color (".dt th.sorted-asc .caret::after { color: var(--fsd-primary) }"). FIX: make the
   active-sort caret color win (add !important to the sorted-asc/desc caret rules, or scope the WCAG rule so it does
   not clobber the active state) while preserving the contrast fix for inactive carets.
6) 0px topbar collapse: ":root" sets "--topbar-h: 0px" and ".topbar { height: var(--topbar-h) }", so a plain
   .topbar without .fsd-topbar collapses to 0. FIX: give the base .topbar a safe fallback height
   (e.g. height: var(--topbar-h, 48px) AND/OR a min-height) so it never collapses to 0 if .fsd-topbar is missing.
   Do not break the existing .fsd-topbar.topbar { height:48px } behaviour.

After editing, re-read your changed regions to confirm each fix is present and selectors are valid CSS.
Briefly report each fix with the selector you changed.`

const [be1, be2, css] = await parallel([
  () => agent(BE1, { label: 'be:audit+sso', phase: 'Backend', schema: CONTRACT_SCHEMA }),
  () => agent(BE2, { label: 'be:sessions+retention', phase: 'Backend', schema: CONTRACT_SCHEMA }),
  () => agent(CSS, { label: 'css:modal-fixes', phase: 'Backend' }),
])

const contract = JSON.stringify({ be1, be2 }, null, 2)

// ===========================================================================
// PHASE 2 — Frontend. api-client first (sole owner of client.ts), then the two
// page agents in parallel (disjoint files).
// ===========================================================================
phase('Frontend')

const API_CLIENT = `${COMMON}
TASK: Add the new API client methods to fsd-v2/frontend/src/api/client.ts ONLY. Add them to the exported 'api'
object following the EXACT existing style (arrow fns returning http.<verb>(...).then(r => r.data); DELETE/POST
bodies use the existing patterns). Group them under clear comment headers.

Add methods for every endpoint in this backend contract (use the spaPath verbatim, strip the leading /api/v1 since
existing methods already include it — match how sibling methods are written; e.g. existing call uses
'/api/v1/admin/audit'? check: existing methods DO include the full '/api/v1/...' path, so include it):

CONTRACT:
${contract}

Required method names (use these so the page agents can rely on them):
- auditLog(action?: string, limit?: number)         -> GET the audit list, optional ?action= & ?limit=
- ssoSecurityContext()                               -> GET the SSO security-context endpoint
- listSessions()                                     -> GET caller's sessions
- revokeOtherSessions()                              -> POST revoke-others
- runRetention()                                     -> POST the admin retention trigger
If the contract's actual paths differ from what you'd guess, TRUST THE CONTRACT paths. Do not change any existing
methods. Re-read your additions to confirm they compile (valid TS, no duplicate keys).`

await agent(API_CLIENT, { label: 'fe:api-client', phase: 'Frontend' })

const SETTINGS = `${COMMON}
TASK: Edit ONLY fsd-v2/frontend/src/pages/Settings.tsx. Add two things; keep the existing sections intact and match
the file's existing style (it uses useT() t('...') for labels, fsd-card sections, btn-fsd buttons, inline status line).

Backend contract (for shapes/paths — the api client methods already exist: api.ssoSecurityContext(),
api.listSessions(), api.revokeOtherSessions()):
${contract}

1) IdP-AWARE MFA: On load, call api.ssoSecurityContext(). If ssoEnforced is true, REPLACE the MFA enrol/disarm
   controls in the existing MFA section with an informational notice:
   "Your security settings are managed by your organization" + the providerName if present
   (e.g. "(e.g. Microsoft Entra)"). Hide/disable the local TOTP enrol + disarm UI in that case. If ssoEnforced is
   false, behave exactly as today. Guard the call (it may fail on older backends — fall back to showing local MFA).

2) SECURITY / ACTIVE SESSIONS: Add a new "Security" fsd-card section (place it sensibly, e.g. right after the MFA
   section) titled for sessions. Load api.listSessions() and render a table: Device, Browser, IP, Last Active
   (format the timestamp readably), and mark the current session (isCurrent) with a chip/badge like "This device".
   Add a "Revoke all other sessions" button (btn-fsd danger). On click, use confirmDialog (from stores/confirm —
   NOT window.confirm) to confirm, then call api.revokeOtherSessions(), then reload the list and show a status
   message. Disable the button while busy and when there are no other sessions.

Use the file's existing busy/status state machinery. Re-read your changes to confirm valid TSX.`

const STUDIO = `${COMMON}
TASK: Edit ONLY fsd-v2/frontend/src/pages/TenantStudio.tsx. Keep all existing tabs/behaviour intact and match the
file's style (TABS array with lucide icons; sections use className "card"; fields use label.field > span + input).

Backend contract (api.auditLog(action?, limit?) and api.runRetention() already exist in the client; the customization
default 'anonymize_bookings_after_days' is now part of the backend default doc):
${contract}

1) DATA RETENTION setting (in the existing 'workflow' tab): add a numeric field "Auto-anonymize booking data older
   than (days)" bound to c.anonymize_bookings_after_days (default 0). Add helper text that 0 = disabled. It saves
   through the existing Save flow (it's just another customization key — no special handling needed). Optionally
   add a small "Run now" button that calls api.runRetention() and toasts the returned count — admin-only page so OK.

2) CHANGE HISTORY tab: add a new tab to the TABS array (e.g. key 'history', label 'History', icon History from
   lucide-react). When active, fetch api.auditLog('customization.update', 50) (lazy-load like the holidays tab does,
   with a loading state). Render each entry as a row/card showing who (username), when (createdAt formatted), and a
   readable DIFF between entry.previous and entry.next: compute the keys whose values changed and show
   "key: oldValue -> newValue" lines (JSON.stringify non-primitive values). Keep it simple and readable; reuse the
   existing 'card'/table styling. Handle empty/loading/error states.

Do not break the dirty-tracking/save logic. Re-read your changes to confirm valid TSX.`

await parallel([
  () => agent(SETTINGS, { label: 'fe:settings', phase: 'Frontend' }),
  () => agent(STUDIO, { label: 'fe:studio', phase: 'Frontend' }),
])

// ===========================================================================
// PHASE 3 — Verify (build + fix) then adversarial auth/session review.
// ===========================================================================
phase('Verify')

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['backendBuild', 'frontendBuild', 'fixesApplied', 'summary'],
  properties: {
    backendBuild: { type: 'string', enum: ['pass', 'fail', 'unknown'] },
    frontendBuild: { type: 'string', enum: ['pass', 'fail', 'unknown'] },
    fixesApplied: { type: 'array', items: { type: 'string' } },
    remainingErrors: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}

const VERIFY = `${COMMON}
TASK: Integration verification of all Phase-1 changes. Run the type/build checks for BOTH packages and FIX any
compile/type errors introduced by the changes (you may edit any changed file to resolve errors, but do not add new
features or revert intended functionality).
- Backend (fsd-v2/backend): find the check command in package.json (likely "npm run build" -> nest build / tsc).
  Run it. If a full build is heavy, 'npx tsc -p tsconfig.json --noEmit' is an acceptable type check.
- Frontend (fsd-v2/frontend): run the type check / build (package.json — likely "npm run build" -> tsc + vite build,
  or "npx tsc --noEmit"). Run the lighter type check if the full vite build is slow.
Capture failures, fix the root cause, re-run until green (or until errors are clearly pre-existing and unrelated to
our changes — note those as remaining). Report which builds passed, what you fixed, and any remaining errors.`

const verify = await agent(VERIFY, { label: 'verify:build', phase: 'Verify', schema: VERIFY_SCHEMA })

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['safe', 'risky', 'broken'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'file', 'issue'],
        properties: {
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          file: { type: 'string' },
          issue: { type: 'string' },
          fix: { type: 'string' },
        },
      },
    },
  },
}

const REVIEW = `${COMMON}
TASK (read-only adversarial review — do NOT edit files): The session-management change touches authentication, which
is the highest-risk part of this work. Review the auth/session changes for correctness and lockout risk:
- Read modules/auth/jwt.strategy.ts, modules/auth/auth.service.ts, modules/auth/auth.controller.ts, and the new
  modules/sessions/* files.
- VERIFY THE CRITICAL INVARIANT: tokens WITHOUT a jti (legacy / already-issued tokens) and tokens whose session row
  is missing must STILL AUTHENTICATE. Only a present-jti-with-revokedAt-set session may be rejected. A regression
  here logs out every existing user — flag it critical.
- Check for: circular module dependency / DI failures around the JwtStrategy repo injection; a DB write on every
  request (lastActiveAt) that should be throttled; revoke-others accidentally revoking the current session; jti not
  actually added to issued tokens (which would make sessions un-listable); tenant isolation on session queries
  (a user must only see/revoke their own sessions).
Return a verdict and concrete findings. Be skeptical; default to flagging if uncertain.`

const review = await agent(REVIEW, { label: 'review:auth-session', phase: 'Verify', schema: REVIEW_SCHEMA })

return { contract: { be1, be2 }, cssReport: css, verify, review }
