import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Public } from './decorators/public.decorator';
import { RedisService } from './redis/redis.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  // Only probe a replica when read replicas are actually configured.
  private readonly replicasConfigured = !!(process.env.DB_REPLICA_HOSTS || '').trim();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly redis: RedisService,
  ) {}

  // Liveness: process is up and serving. Cheap, no dependencies — safe for an
  // orchestrator's frequent liveness probe.
  @Public()
  @Get()
  check() {
    return { status: 'ok', service: 'fsd-mrbs-api', version: '2.0.0' };
  }

  // Readiness (AUD-015): only report ready when the database is actually
  // reachable, so an orchestrator / load balancer stops routing traffic to an
  // instance whose DB connection is down rather than serving 500s. Returns 503
  // on failure. When replicas are configured we also probe a replica via the
  // 'slave' query runner, so a node whose read path is broken is pulled out of
  // rotation even if the primary is fine.
  @Public()
  @Get('ready')
  async ready() {
    try {
      await this.dataSource.query('SELECT 1');
    } catch (e) {
      throw new ServiceUnavailableException({ status: 'unavailable', db: 'down', error: (e as Error).message });
    }

    // When Redis is enabled it backs realtime, rate-limiting and broadcast
    // dedup — a node that can't reach it is degraded, so report not-ready and
    // let the load balancer route around it. ping() returns true when Redis is
    // disabled, so single-node deployments are unaffected.
    if (!(await this.redis.ping())) {
      throw new ServiceUnavailableException({ status: 'unavailable', db: 'up', redis: 'down' });
    }

    if (this.replicasConfigured) {
      const runner = this.dataSource.createQueryRunner('slave');
      try {
        await runner.connect();
        await runner.query('SELECT 1');
      } catch (e) {
        throw new ServiceUnavailableException({ status: 'unavailable', db: 'up', replica: 'down', error: (e as Error).message });
      } finally {
        await runner.release();
      }
      return { status: 'ready', db: 'up', replica: 'up', redis: this.redis.enabled ? 'up' : 'disabled' };
    }

    return { status: 'ready', db: 'up', redis: this.redis.enabled ? 'up' : 'disabled' };
  }
}
