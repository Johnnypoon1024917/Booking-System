# Database migrations (AUD-002)

This project manages schema with TypeORM migrations instead of `synchronize`.

## Committed migrations

- **`*-Baseline.ts`** — the full schema (all 42 tables, indexes, FKs) generated
  from the entities. This is the production bootstrap; no `DB_SYNCHRONIZE=true`
  first-boot step is needed any more.
- **`*-BookingOverlapConstraint.ts`** — Postgres GIST `EXCLUDE` constraint that
  rejects overlapping bookings on an exclusive resource at the storage layer
  (pods are exempt). A backstop behind the application-level lock.

## Regenerate a baseline (only if starting fresh)

Against an **empty** database matching the current entities:

```bash
# from fsd-v2/backend, with DB_* env vars set
npm run migration:generate -- src/migrations/Baseline
```

Review the generated SQL, then commit it.

## Add a migration for a schema change

After editing entities, generate the diff and commit it:

```bash
npm run migration:generate -- src/migrations/<DescriptiveName>
```

## Multi-instance note

Run migrations as a **one-shot** (e.g. `docker compose run --rm api npm run
migration:run`) or let a single api instance apply them before scaling — don't
rely on N replicas racing `DB_MIGRATIONS_RUN=true` on first boot.

## Apply migrations

```bash
npm run migration:run        # apply all pending
npm run migration:revert     # roll back the most recent
```

In containers, set `DB_MIGRATIONS_RUN=true` so pending migrations apply on boot
(see `src/config/database.config.ts`). Keep `DB_SYNCHRONIZE=false` everywhere
outside local development.

## Why

`synchronize` diffs entities against the live schema and applies changes with no
review, no history, and no rollback — unsafe for production. Migrations make
schema changes reviewable, repeatable, and reversible.
