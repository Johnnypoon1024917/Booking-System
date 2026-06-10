import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { prodSecret } from '../common/env';

// All entities are eagerly loaded at module init via TypeORM's
// autoLoadEntities — modules just `forFeature([Entity])` and the
// connection picks them up. Synchronize is true in dev for fast iteration.
//
// PRODUCTION uses MIGRATIONS, not synchronize: a committed baseline (and the
// booking-overlap constraint) lives under src/migrations and is compiled to
// dist/migrations. Set DB_MIGRATIONS_RUN=true (the prod compose default) to
// apply pending migrations on boot. Keep DB_SYNCHRONIZE=false in every shared
// environment so steady-state boots never mutate the live schema. DB_SYNCHRONIZE,
// when set, still wins over the NODE_ENV default for the rare break-glass case.
const resolveSynchronize = (): boolean =>
  process.env.DB_SYNCHRONIZE !== undefined
    ? process.env.DB_SYNCHRONIZE === 'true'
    : process.env.NODE_ENV !== 'production';

const int = (v: string | undefined, fallback: number): number => {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

const PORT = int(process.env.DB_PORT, 5432);
const USERNAME = process.env.DB_USER || 'mrbs_admin';
// In production a missing DB_PASS throws at boot rather than silently connecting
// (or failing) with the well-known 'changeme' default.
const PASSWORD = prodSecret('DB_PASS', 'changeme');
const DATABASE = process.env.DB_NAME || 'mrbs_db_v2';

// Read replicas for the active-active diagram's replicated DB Servers. When
// DB_REPLICA_HOSTS is set (comma-separated), TypeORM opens a connection pool to
// each replica in addition to the primary.
//
// IMPORTANT — current routing behaviour: every authenticated request runs inside
// the per-request tenant transaction (TenantTxInterceptor), which is pinned to
// the PRIMARY because the tenant GUC (SET LOCAL) and read-your-writes
// consistency must hold within that transaction. So application reads do NOT yet
// fan out to the replicas — the replica pools are used by the readiness probe
// (health.controller probes a 'slave' runner) and stand ready as warm
// standbys/failover targets. True read-scaling would require routing read-only
// handlers onto a 'slave' runner OUTSIDE the tenant transaction, with care for
// read-your-writes on post-write confirmation reads — a deliberate follow-up,
// not wired here. Physical primary failover is handled by the HA layer (see the
// replication block below + the Patroni/VIP note).
const replicaHosts = (process.env.DB_REPLICA_HOSTS || '')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);

// Per-connection pool + timeout tuning (node-postgres). connectionTimeoutMillis
// is the key HA knob: a short cap means a dead primary fails fast and the next
// query reconnects (to the new primary promoted by the HA layer) instead of
// hanging the request thread.
const poolExtra = {
  max: int(process.env.DB_POOL_MAX, 20),
  idleTimeoutMillis: int(process.env.DB_IDLE_TIMEOUT_MS, 30000),
  connectionTimeoutMillis: int(process.env.DB_CONNECT_TIMEOUT_MS, 5000),
};

const nodeFor = (host: string) => ({ host, port: PORT, username: USERNAME, password: PASSWORD, database: DATABASE });

export const databaseConfig = (): TypeOrmModuleOptions => {
  const common: TypeOrmModuleOptions = {
    type: 'postgres',
    autoLoadEntities: true,
    synchronize: resolveSynchronize(),
    // Migrations (AUD-002): once a baseline migration exists under dist/migrations,
    // run pending migrations automatically on boot when DB_MIGRATIONS_RUN=true.
    // This is the production-safe alternative to synchronize. Disabled by default
    // so a misconfigured env can't unexpectedly mutate schema.
    migrations: ['dist/migrations/*.js'],
    migrationsTableName: 'typeorm_migrations',
    migrationsRun: process.env.DB_MIGRATIONS_RUN === 'true',
    logging: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
    // Connection-level failover: ride out a primary promotion / VIP swing at boot
    // by retrying the initial connection instead of crash-looping. At runtime the
    // pool transparently reconnects on the next query after a dropped connection.
    retryAttempts: int(process.env.DB_RETRY_ATTEMPTS, 10),
    retryDelay: int(process.env.DB_RETRY_DELAY_MS, 3000),
  };

  if (replicaHosts.length) {
    // Read/write split across primary + replicas. The HA layer (Patroni / repmgr
    // / a managed Postgres with a failover VIP) is responsible for PROMOTING a
    // replica to primary; the app reconnects to DB_HOST, which the HA layer keeps
    // pointed at the current primary. canRetry + the pool's reconnect handle the
    // brief unavailability during a swing.
    return {
      ...common,
      replication: {
        master: nodeFor(process.env.DB_HOST || 'localhost'),
        slaves: replicaHosts.map(nodeFor),
        // Don't let a single dead replica fail a read — fall through to another
        // node / the primary.
        removeNodeErrorCount: 5,
        restoreNodeTimeout: 5000,
        canRetry: true,
      },
      extra: poolExtra,
    };
  }

  // Single-endpoint mode (default). Point DB_HOST at the primary directly, or at
  // an HA proxy / VIP that fronts the primary so runtime failover is transparent.
  return {
    ...common,
    host: process.env.DB_HOST || 'localhost',
    port: PORT,
    username: USERNAME,
    password: PASSWORD,
    database: DATABASE,
    // Pool tuned for the same workload as the Go pgxpool defaults.
    extra: poolExtra,
  };
};
