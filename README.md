Deployment

docker compose down
docker compose build --progress=plain
docker compose up -d

Fresh Deploy
.\scripts\dev.ps1 rebuild

App	http://localhost:8080/	see below
API docs (Swagger)	http://localhost:8080/api/docs	—
OpenAPI JSON	http://localhost:8080/api/openapi.json	—
RabbitMQ UI	http://localhost:15672/	guest / guest
Postgres	localhost:5432	mrbs_admin / SecurePass123!
Demo logins
User	Password	Role
admin	admin123	System Admin (sees Tenant Studio)
officer	pass	General User
Useful commands

.\scripts\dev.ps1 logs        # tail combined logs
.\scripts\dev.ps1 down        # stop everything (keeps DB volume)
.\scripts\dev.ps1 reset       # nuke DB volume and rebuild fresh
.\scripts\dev.ps1 rebuild     # rebuild image with no cache
.\scripts\dev.ps1 psql        # open psql shell on the DB
What gets seeded
The third migration (003_seed_default_tenant.up.sql) inserts:

Default tenant (00000000-0000-0000-0000-000000000001) with full FSD customization document
admin and officer users matching the simulated AD service
7 sample resources across rooms / vehicle / equipment / top management
3 HK public holidays so the holiday-blocking flow has dates to refuse on
Login → SPA at /app/ → KPIs, calendar with demo events, today's agenda, activity feed, quick actions, search results pulling the seeded resources, and the Tenant Studio at /app/admin where you can rebrand live.

If docker compose up errors out, paste the message — most likely the Docker daemon isn't running yet. Otherwise, try the URL once you see Starting API… in the logs.


Week 1: Real LDAP + JWT-from-secret-manager + TLS termination + rate limiting + atomic booking insert via DB unique-exclusion constraint
Week 2: Approval workflow (handler + UI inbox) + booking edit/cancel + idempotency keys + recurring expansion
Week 3: Real SMTP wiring + tested template per tenant + MS Graph one-way sync + structured logging + Prometheus metrics
Week 4: WCAG audit fixes + DR drill (backup/restore) + load test baseline + dependency scanning in CI