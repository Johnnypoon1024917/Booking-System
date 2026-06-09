import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import IORedis, { Redis } from 'ioredis';

// Shared-state backplane for multi-instance / active-active deployments.
//
// The platform was built single-process: realtime SSE fan-out, the auth
// rate-limit window, and broadcast announcement timers all lived in one Nest
// process's memory. Behind a load balancer with N web servers per site (see the
// "Propose Production Environment" diagram) that breaks: an SSE event published
// on node A never reaches a client connected to node B, the rate-limit window is
// per-pod (so the effective limit is N×), and every pod re-fires the same
// broadcast timer. This service is the one shared store that fixes all three.
//
// It is OPTIONAL. When REDIS_URL is unset the service reports `enabled = false`
// and every consumer falls back to its original in-memory behaviour — so local
// dev and single-node deploys keep working with zero new infrastructure. Set
// REDIS_URL (e.g. redis://redis:6379) to switch the whole platform into the
// distributed, HA-safe code paths.
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly log = new Logger(RedisService.name);
  readonly enabled: boolean;
  private readonly url?: string;
  private client?: Redis; // command + publish connection
  private readonly subscribers: Redis[] = [];

  constructor() {
    this.url = process.env.REDIS_URL?.trim() || undefined;
    this.enabled = !!this.url;
    if (this.enabled) {
      this.client = this.connect('cmd');
      this.log.log('Redis shared-state ENABLED — realtime pub/sub, global rate-limit and broadcast dedup are multi-instance safe');
    } else {
      this.log.warn(
        'REDIS_URL not set — running in single-node mode (in-memory realtime, per-pod rate-limit, no broadcast dedup). ' +
          'NOT safe behind a load balancer with more than one API instance; set REDIS_URL for HA.',
      );
    }
  }

  // The shared command/publish connection. Undefined when Redis is disabled —
  // callers must guard on `enabled` (or a truthy check) and use their fallback.
  get cmd(): Redis | undefined {
    return this.client;
  }

  // Fire-and-forget publish to a channel. No-op when Redis is disabled. Errors
  // are logged, not thrown — a pub/sub blip must not fail the calling request.
  async publish(channel: string, message: string): Promise<void> {
    if (!this.enabled || !this.client) return;
    try {
      await this.client.publish(channel, message);
    } catch (e) {
      this.log.error(`publish to ${channel} failed: ${(e as Error).message}`);
    }
  }

  // Subscribe to a channel with a message handler. ioredis puts a connection
  // into dedicated subscriber mode once it subscribes, so each subscription gets
  // its OWN connection separate from the command client; we track them for
  // teardown. Returns false when Redis is disabled so the caller knows to keep
  // its in-memory-only path.
  subscribe(channel: string, handler: (message: string) => void): boolean {
    if (!this.enabled) return false;
    const sub = this.connect('sub');
    this.subscribers.push(sub);
    sub
      .subscribe(channel)
      .then(() => this.log.log(`subscribed to ${channel}`))
      .catch((e) => this.log.error(`subscribe to ${channel} failed: ${e.message}`));
    sub.on('message', (_ch, msg) => handler(msg));
    return true;
  }

  private connect(role: string): Redis {
    const conn = new IORedis(this.url!, {
      // Reconnect forever with capped backoff: a Redis blip (or failover of a
      // replicated/sentinel Redis) must not permanently wedge the API.
      retryStrategy: (times) => Math.min(times * 200, 2000),
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      connectionName: `fsd-mrbs-${role}`,
    });
    conn.on('error', (e) => this.log.error(`redis ${role} connection error: ${e.message}`));
    conn.on('ready', () => this.log.log(`redis ${role} connection ready`));
    return conn;
  }

  onModuleDestroy() {
    this.client?.disconnect();
    this.subscribers.forEach((s) => s.disconnect());
  }
}
