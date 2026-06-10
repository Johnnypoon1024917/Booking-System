import 'reflect-metadata';
import { DataSource } from 'typeorm';

// Standalone TypeORM DataSource for the migration CLI (AUD-002).
//
// The running app uses Nest's TypeOrmModule (database.config.ts) with
// autoLoadEntities; the CLI can't see Nest's DI, so it discovers entities and
// migrations by glob. Use the npm scripts:
//
//   npm run migration:generate -- src/migrations/<Name>   # diff entities → SQL
//   npm run migration:run                                  # apply pending
//   npm run migration:revert                               # roll back last
//
// Generate the baseline once against an empty database, review the SQL, commit
// it, then deploy with DB_SYNCHRONIZE=false and migrationsRun=true (the runtime
// config runs pending migrations on boot). This replaces the unsafe
// "DB_SYNCHRONIZE=true on first boot" workflow.
//
// Provide DB_* via the environment (e.g. `set -a; . ./.env; set +a` or your
// shell's dotenv) before invoking the CLI, exactly as the app reads them.
export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  username: process.env.DB_USER || 'mrbs_admin',
  password: process.env.DB_PASS || 'changeme',
  database: process.env.DB_NAME || 'mrbs_db_v2',
  // Globs resolve against ts (CLI via ts-node) and js (compiled) entrypoints.
  entities: ['src/**/*.entity.{ts,js}'],
  migrations: ['src/migrations/*.{ts,js}'],
  migrationsTableName: 'typeorm_migrations',
  synchronize: false,
});

// NB: exactly ONE export of the DataSource instance — the TypeORM migration CLI
// rejects a file that exports the same instance twice (named + default).
