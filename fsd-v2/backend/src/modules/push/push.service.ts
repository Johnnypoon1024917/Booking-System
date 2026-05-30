import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const webpush = require('web-push');
import { PushSubscription } from './push-subscription.entity';

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  icon?: string;
}

// VAPID keys come from env. We expose the public key to the SPA so it
// can call pushManager.subscribe({ applicationServerKey }); the private
// key is used here to sign the JWT in the Authorization header that the
// Push Service requires (RFC 8292).
@Injectable()
export class PushService implements OnModuleInit {
  private readonly log = new Logger(PushService.name);
  private configured = false;
  readonly publicKey = process.env.VAPID_PUBLIC_KEY || '';
  private readonly privateKey = process.env.VAPID_PRIVATE_KEY || '';
  private readonly subject = process.env.VAPID_SUBJECT || 'mailto:admin@fsd.local';

  constructor(
    @InjectRepository(PushSubscription) private readonly repo: Repository<PushSubscription>,
  ) {}

  onModuleInit() {
    if (this.publicKey && this.privateKey) {
      webpush.setVapidDetails(this.subject, this.publicKey, this.privateKey);
      this.configured = true;
    } else {
      this.log.warn('VAPID keys not set — push notifications disabled');
    }
  }

  isConfigured() { return this.configured; }

  async subscribe(
    tenantId: string, userId: string,
    endpoint: string, p256dh: string, auth: string, userAgent: string,
  ) {
    // Defensive: only https endpoints. Push services all use HTTPS and
    // accepting http is just an SSRF foothold for the worker.
    if (!endpoint.startsWith('https://')) {
      throw new Error('endpoint must be https');
    }
    const existing = await this.repo.findOne({ where: { userId, endpoint } });
    if (existing) {
      existing.p256dh = p256dh;
      existing.auth = auth;
      existing.userAgent = userAgent;
      existing.lastUsedAt = null;
      return this.repo.save(existing);
    }
    return this.repo.save(this.repo.create({
      tenantId, userId, endpoint, p256dh, auth, userAgent,
    }));
  }

  async unsubscribe(userId: string, endpoint: string) {
    await this.repo.delete({ userId, endpoint });
  }

  listForUser(tenantId: string, userId: string) {
    return this.repo.find({ where: { tenantId, userId } });
  }

  // Best-effort fan-out. A subscription that returns 404/410 is gone for
  // good and we GC it so the table doesn't grow unbounded.
  async sendToUser(tenantId: string, userId: string, payload: PushPayload) {
    if (!this.configured) return { sent: 0, failed: 0 };
    const subs = await this.listForUser(tenantId, userId);
    let sent = 0; let failed = 0;
    for (const s of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload),
        );
        s.lastUsedAt = new Date();
        await this.repo.save(s);
        sent++;
      } catch (err: any) {
        failed++;
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          await this.repo.delete({ id: s.id });
        } else {
          this.log.warn(`push send failed: ${err?.message ?? err}`);
        }
      }
    }
    return { sent, failed };
  }
}
