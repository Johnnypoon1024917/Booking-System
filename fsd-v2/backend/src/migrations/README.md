# Database migrations (AUD-002)

This project now manages schema with TypeORM migrations instead of relying on
`synchronize`.

## Generate the baseline (one-time)

Against an **empty** database matching the current entities:

```bash
# from fsd-v2/backend, with DB_* env vars set
npm run migration:generate -- src/migrations/Baseline
```

Review the generated SQL, then commit it.

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
