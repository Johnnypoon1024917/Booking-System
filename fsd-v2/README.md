# FSD MRBS — v2 (NestJS + React)

Client-recommended stack rewrite of the Go + Vue platform that ships under
`../src`. Both stacks are kept side-by-side so a phased cut-over can run
in parallel.

## Stack

| Layer            | Choice                              |
|------------------|-------------------------------------|
| Backend          | NestJS 10 (TypeScript)              |
| API style        | REST                                |
| API docs         | Swagger / OpenAPI (auto-generated)  |
| ORM              | TypeORM 0.3                         |
| Database         | PostgreSQL 16 + Row-Level Security  |
| Auth             | JWT (HS256) — same shape as v1      |
| Frontend         | React 18 + Vite 5 (TypeScript)      |
| State            | TanStack Query + Zustand            |
| Calendar         | FullCalendar 6                      |
| Batch / Scheduler| NestJS `@nestjs/schedule` cron jobs |
| Container        | Docker compose                      |

## What's in this version

Spine of the platform — enough to log in, browse rooms, make and manage
bookings, and administer users / departments / tenant settings.

* **Backend modules** — `auth`, `tenants`, `users`, `departments`,
  `resources`, `bookings`, `customization`, `audit`, `dashboard`.
* **RLS** is engaged on every request via the `RlsInterceptor` (sets
  `app.current_tenant_id` for the request transaction, identical
  policy semantics to v1).
* **Swagger UI** at `/api/docs`.
* **Frontend pages** — Login, Dashboard, Calendar (Day/Week/Month),
  Search, My Bookings, Admin → Users (with department M2M), Admin →
  Resources, Tenant Studio (branding + layout).

## What's deferred from v1

These exist in the Go codebase but are deliberately out of scope for
the initial port. Each is a multi-day effort and is best done in
follow-up sprints once the spine is proven.

* MFA / TOTP, WebAuthn passkeys, SAML, OAuth2, LDAP providers
* Recurring bookings & exception handling
* Approval chains (multi-step approver routing)
* Microsoft Graph, Bot Framework, Outlook add-in integrations
* Push notifications (VAPID), ICS feed encoder
* Broadcast banner (news ticker) — UI is also a future port
* Reports CSV/XLSX export
* HK Observatory weather + GovHK holidays sync
* Audit-chain tamper-evident SHA-256 (basic audit_log table is in;
  hash-chain is deferred)
* SCIM provisioning

The shapes of every deferred module mirror v1 so porting them is
mostly mechanical translation.

## Quick start

```bash
cd fsd-v2
docker compose up -d --build
# Backend:  http://localhost:3000        Swagger: http://localhost:3000/api/docs
# Frontend: http://localhost:5173
# Login:    admin / admin (seeded — change immediately in production)
```

## High availability (active-active, multi-instance)

The API is stateless on the request path (JWT auth, DB-checked `/health/ready`,
LDAP/SSO state in the DB), so it scales horizontally behind a load balancer. Three
pieces of state that used to live in one process's memory are made multi-instance
safe by a shared **Redis** backplane, and Postgres reads can be split across
replicas:

| Concern | Single node (no Redis) | Multi-instance (Redis set) |
|---|---|---|
| Realtime SSE fan-out | in-process RxJS bus | Redis pub/sub — events reach clients on every node, with a per-tenant replay buffer so a reconnecting client catches up missed events via `Last-Event-ID` (plus refetch-on-reconnect on the SPA) |
| Auth rate-limit window | per-pod Map (N× the limit) | atomic Redis INCR — one global window |
| Broadcast announcements | one announcer | Redis `NX` lock dedups N pods firing the same timer |
| Postgres failover | single DB | primary fronted by an HA proxy/VIP; `DB_REPLICA_HOSTS` opens warm replica pools (used by the readiness probe / standby). NB: app reads still run on the primary inside the tenant transaction — replica read-scaling is a documented follow-up, not yet wired |

Enable it by setting two env vars (see [.env.example](.env.example)):

```bash
REDIS_URL=redis://redis:6379        # shared by every api instance (both sites)
DB_REPLICA_HOSTS=replica1,replica2  # writes still go to DB_HOST (the primary)
```

Leave both empty and the app falls back to in-memory behaviour (correct for a
single instance). The production compose ([docker-compose.prod.yml](docker-compose.prod.yml))
ships a `redis` service and wires these through.

**Database failover** is handled at the infrastructure layer: point `DB_HOST` at
the primary's floating VIP / HA proxy (Patroni, repmgr, or a managed Postgres),
which keeps that address aimed at the current primary. The app fails fast on a
dead connection (`DB_CONNECT_TIMEOUT_MS`), retries the initial connect through a
failover (`DB_RETRY_ATTEMPTS`/`DB_RETRY_DELAY_MS`), and the pool transparently
reconnects to the promoted primary on the next query.

## Layout

```
fsd-v2/
├── backend/                  NestJS API + scheduler
│   ├── src/
│   │   ├── common/           Interceptors, guards, decorators, errors
│   │   ├── config/           Env, TypeORM, JWT config
│   │   ├── modules/
│   │   │   ├── auth/
│   │   │   ├── tenants/
│   │   │   ├── users/
│   │   │   ├── departments/
│   │   │   ├── resources/
│   │   │   ├── bookings/
│   │   │   ├── customization/
│   │   │   ├── audit/
│   │   │   └── dashboard/
│   │   ├── app.module.ts
│   │   └── main.ts
│   ├── package.json
│   └── Dockerfile
├── frontend/                 React + Vite SPA
│   ├── src/
│   │   ├── api/              Generated client + axios wrapper
│   │   ├── components/
│   │   ├── hooks/
│   │   ├── pages/
│   │   ├── styles/
│   │   ├── App.tsx
│   │   └── main.tsx
│   ├── package.json
│   ├── vite.config.ts
│   └── Dockerfile
├── docker-compose.yml
└── README.md
```
