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

export const databaseConfig = (): TypeOrmModuleOptions => ({
  type: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  username: process.env.DB_USER || 'mrbs_admin',
  password: process.env.DB_PASS || 'changeme',
  database: process.env.DB_NAME || 'mrbs_db_v2',
  autoLoadEntities: true,
  synchronize: resolveSynchronize(),
  logging: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  // Pool tuned for the same workload as the Go pgxpool defaults.
  extra: { max: 20, idleTimeoutMillis: 30000 },
});
