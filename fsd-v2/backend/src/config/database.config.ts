import { TypeOrmModuleOptions } from '@nestjs/typeorm';

// All entities are eagerly loaded at module init via TypeORM's
// autoLoadEntities — modules just `forFeature([Entity])` and the
// connection picks them up. Synchronize is true in dev for fast
// iteration. The project ships no migrations, so for production the
// schema is created via a controlled first boot: set DB_SYNCHRONIZE=true
// once to let TypeORM build the schema, then set it back to false (the
// default under NODE_ENV=production) so steady-state boots never mutate
// the live schema. DB_SYNCHRONIZE, when set, wins over the NODE_ENV default.
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
const PASSWORD = process.env.DB_PASS || 'changeme';
const DATABASE = process.env.DB_NAME || 'mrbs_db_v2';

// Read replicas for the active-active diagram's replicated DB Servers. When
// DB_REPLICA_HOSTS is set (comma-separated), TypeORM routes writes + explicit
// transactions to the primary and load-balances SELECTs across the replicas —
// real read-scaling, and the primary stays free for the write path.
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
