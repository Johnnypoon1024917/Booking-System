# FSD-V2 Audit Remediation (2026-06)

Remediation of the findings in `Test Result/FSD_audit_report.pdf` against the
Node.js (`fsd-v2`) stack. Each finding was re-validated against the current code
before fixing — AUD-006 was already fixed in-tree and is noted as such.

Backend `npm run build`, `npm test` (14 tests), `npm run lint` (0 errors), and
frontend `npm run build` all pass after these changes.

## Fixed in code

| ID | Area | Fix |
|----|------|-----|
| AUD-006 | Approval delegation | Already fixed in-tree (caller eligibility enforced). |
| AUD-007 | Check-in token | `issueToken` now requires booking owner/admin. |
| AUD-008 | Recurring cancel | Owner/admin check + routes each occurrence through the normal cancel path (realtime, calendar-sync, notifications, audit fire). |
| AUD-031 | Service add-ons | List/attach/detach now require booking owner/admin. |
| AUD-018 | Graph manual sync | Endpoint gated with `RolesGuard` + admin roles. |
| AUD-005 | Kiosk endpoints | Fail closed when `KIOSK_TOKEN` unset (unless explicit local dev). |
| AUD-020 | Teams webhook | Fail closed when `BOT_APP_ID` unset (unless explicit local dev). |
| AUD-009 | Integration key | Already hard-fails in prod via `onModuleInit`; documented in `.env.example`. |
| AUD-029 | Crypto/nginx/docker | AES-GCM `authTagLength` enforced; nginx `Host` fixed to internal upstream; backend & frontend run as non-root. |
| AUD-003 | Tenant RLS | Fail-closed policy (default in prod) with an `app.rls_bypass` GUC + `RlsService.withBypass()` for system contexts; requires non-superuser DB role. |
| AUD-032 | Pwd-change token | `changePassword` re-checks account state (`isActive` + `mustChangePassword`), making the token effectively one-time. |
| AUD-023 | DSAR erasure | Self-erasure now requires password re-authentication. |
| AUD-019 | LDAP injection | Usernames RFC-4515-escaped before filter interpolation. |
| AUD-010 | SSE JWT in URL | `?token=` query param honored only on the `/realtime` SSE route. |
| AUD-011 | CORS | Restricted by `CORS_ORIGINS` allow-list in production. |
| AUD-022 | Swagger | Disabled in production unless `ENABLE_SWAGGER=true`. |
| AUD-012 | Rate limiting | Uses trust-proxy-resolved `req.ip` (not spoofable XFF); WebAuthn login endpoints now rate-limited. |
| AUD-013 | Validation | Representative DTO hardening (`@IsUUID`/`@IsIn` on departments, location-groups). |
| AUD-021 | nginx headers | CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy on SPA responses (HSTS commented for TLS). |
| AUD-026 | Docker | Backend uses `npm ci` + prod-only deps + non-root; frontend prod uses non-root nginx-unprivileged. |
| AUD-002 | Migrations | TypeORM CLI data-source + `migration:*` scripts + runtime `migrationsRun`; `synchronize` stays off outside local. |
| AUD-024 | Lint | ESLint + `@typescript-eslint` installed and configured; `npm run lint` works (0 errors). |
| AUD-015 | Health/shutdown | `/health/ready` DB readiness probe; `enableShutdownHooks()`; api/frontend compose healthchecks. |
| AUD-016 | CI/CD | `.github/workflows/ci.yml` (build, test, lint, audit, docker build, Trivy). |
| AUD-028 | Leaked JWTs | Removed `e2e/playwright/.auth/admin.json` from the tree; `.gitignore` now ignores auth-state. |
| AUD-027 | Hygiene | Removed zero-byte `fsd-v2/docker`; fixed malformed root `.gitignore`. |
| AUD-004 | Dev compose | Marked local-only with an explicit warning header. |
| AUD-033 | react-router | Upgraded to `^6.30.4` — frontend prod audit now reports **0 vulnerabilities**. |
| AUD-001 | Backend deps | Migrated `passport-saml` → `@node-saml/passport-saml` (**critical CVE-2025-54419 cleared**); `uuid`→11, `nodemailer`→7. Prod audit: critical 1→0, high 10→5, moderate 20→12. |
| AUD-025 | Tests | Added `env.spec.ts` (fail-closed helpers); test count 10→14. |

## Requires operational action (cannot be done in-repo)

- **AUD-028 secret rotation / history purge** — the committed admin JWT must be
  invalidated and the JWT signing secret rotated if it was ever shared; purge
  the secret from Git history (`git filter-repo`) if the repo is shared. Removal
  from the working tree is done; history rewrite is intentionally **not** done
  (destructive, shared-history sensitive — do it deliberately).
- **AUD-001/AUD-030 residual deps/images** — remaining transitive highs
  (`multer`, `tar`/`@mapbox/node-pre-gyp` via `bcrypt`, `lodash`) need a
  regression-tested upgrade pass or documented risk-acceptance, then rebuild
  images and re-run Trivy in CI (the workflow scans report-only until then).
- **AUD-003 DB role** — deploy with a least-privileged (non-superuser) Postgres
  role so the now-fail-closed RLS policies actually enforce; verify cron/seeder
  paths via `RlsService.withBypass`.
- **AUD-002 baseline migration** — run `npm run migration:generate` against an
  empty DB, review, and commit before enabling `DB_MIGRATIONS_RUN` in prod.
- **SAML regression test** — the `@node-saml/passport-saml` migration is API-
  complete and builds, but SSO/SAML must be tested against a live IdP before
  production (config key `cert` → `idpCert`).

## Deferred (larger efforts, scoped by the audit as long-term)

- **AUD-014** (bearer tokens in `localStorage`) — moving to same-site cookies +
  CSRF is a cross-cutting auth change; the new nginx CSP reduces XSS exposure in
  the interim.
- **AUD-017** (fine-grained permission matrix) — mapping every privileged route
  to `@RequirePermission` with role tests is a dedicated workstream.
- **AUD-013 / AUD-025** — remaining SCIM `any` DTOs and broad test coverage
  (authorization, tenant isolation, integrations) should continue to expand.
