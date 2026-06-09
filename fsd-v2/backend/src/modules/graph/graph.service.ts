import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as crypto from 'crypto';
import { Client } from '@microsoft/microsoft-graph-client';
import { GraphSubscription } from './graph-subscription.entity';
import { CredentialService } from '../integrations/credential.service';
import { RedisService } from '../../common/redis/redis.service';

// Microsoft Graph OAuth + change-notification glue.
//
// We use the OAuth2 client_credentials flow against
// https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token with the
// .default scope. The `@microsoft/microsoft-graph-client` SDK gives us
// the REST shape; we supply our own AuthenticationProvider so token
// caching stays on this side.
//
// Subscriptions are issued for /users/{upn}/events with a 70.5h max
// lifetime — the hourly cron renews anything within 12h of expiry.

const AZURE_TOKEN_URL = (tenant: string) =>
  `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
const DEFAULT_SCOPE = 'https://graph.microsoft.com/.default';
const GRAPH_NOTIFICATION_LIFETIME_HOURS = 70;

interface TokenCacheEntry {
  value: string;
  expiresAt: number; // epoch ms
}

@Injectable()
export class GraphService {
  private readonly log = new Logger(GraphService.name);
  private readonly tokenCache = new Map<string, TokenCacheEntry>();

  constructor(
    @InjectRepository(GraphSubscription)
    private readonly subs: Repository<GraphSubscription>,
    private readonly creds: CredentialService,
    private readonly redis: RedisService,
  ) {}

  // --- OAuth --------------------------------------------------------------

  // Acquire (and cache) an app-only Graph token. Two cache layers:
  //   - local Map: avoids any network on the hot path within a pod;
  //   - Redis (when enabled): SHARED across pods so a fleet of api instances
  //     reuses one token per (tenant,client) instead of each minting its own —
  //     fewer calls to the Azure token endpoint, which is throttled. The token
  //     is a bearer secret; it lives only in the internal Redis, TTL'd to its
  //     own expiry so it can't outlive validity.
  async token(azureTenant: string, clientId: string, clientSecret: string): Promise<string> {
    const key = `${azureTenant}/${clientId}`;
    const now = Date.now();

    const local = this.tokenCache.get(key);
    if (local && local.expiresAt - now > 60_000) return local.value;

    if (this.redis.enabled && this.redis.cmd) {
      try {
        const raw = await this.redis.cmd.get(`graph:token:${key}`);
        if (raw) {
          const shared = JSON.parse(raw) as TokenCacheEntry;
          if (shared.expiresAt - now > 60_000) {
            this.tokenCache.set(key, shared); // warm the local layer
            return shared.value;
          }
        }
      } catch (e) {
        this.log.warn(`graph token shared-cache read failed, fetching fresh: ${(e as Error).message}`);
      }
    }

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: DEFAULT_SCOPE,
    }).toString();

    const resp = await fetch(AZURE_TOKEN_URL(azureTenant), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`token endpoint ${resp.status}: ${text}`);
    const j = JSON.parse(text);
    if (j.error) throw new Error(`${j.error}: ${j.error_description}`);
    const entry: TokenCacheEntry = {
      value: j.access_token,
      expiresAt: now + (j.expires_in - 30) * 1000,
    };
    this.tokenCache.set(key, entry);
    if (this.redis.enabled && this.redis.cmd) {
      try {
        const ttlMs = Math.max(1, entry.expiresAt - now);
        await this.redis.cmd.set(`graph:token:${key}`, JSON.stringify(entry), 'PX', ttlMs);
      } catch (e) {
        this.log.warn(`graph token shared-cache write failed: ${(e as Error).message}`);
      }
    }
    return entry.value;
  }

  // testConnection is what the admin "Test" button calls. A 401/403 here
  // almost always means the app is missing Calendars.ReadWrite or
  // User.Read.All admin consent.
  async testConnection(azureTenant: string, clientId: string, clientSecret: string) {
    const tok = await this.token(azureTenant, clientId, clientSecret);
    const resp = await fetch('https://graph.microsoft.com/v1.0/users?$top=1', {
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (resp.status === 401 || resp.status === 403) {
      const body = await resp.text();
      throw new Error(
        `graph rejected token (${resp.status}): grant Calendars.ReadWrite / User.Read.All — ${body}`,
      );
    }
    if (!resp.ok) throw new Error(`graph ${resp.status}: ${await resp.text()}`);
  }

  // SDK client bound to a pre-acquired token.
  private clientFor(token: string): Client {
    return Client.init({
      authProvider: (done) => done(null, token),
    });
  }

  // --- Event upsert (used by outlook-sync) -------------------------------

  async upsertEvent(
    azureTenant: string, clientId: string, clientSecret: string,
    mailboxUPN: string, existingGraphId: string | null, event: Record<string, any>,
  ): Promise<{ id: string; iCalUId?: string }> {
    const tok = await this.token(azureTenant, clientId, clientSecret);
    const client = this.clientFor(tok);
    if (existingGraphId) {
      try {
        await client.api(`/users/${mailboxUPN}/events/${existingGraphId}`).patch(event);
        return { id: existingGraphId };
      } catch (e: any) {
        // Only recreate when the event is genuinely gone (deleted in
        // Outlook). On a transient failure (429/503/timeout/auth) we MUST
        // rethrow rather than POST a new event: recreating would leave the
        // original event orphaned on the room calendar and repoint our sync
        // record at a duplicate. Let the caller's retry path handle transients.
        const status = e?.statusCode ?? e?.status;
        if (status !== 404 && status !== 410) {
          throw e;
        }
        this.log.warn(`graph event ${existingGraphId} gone (${status}), recreating`);
      }
    }
    const created = await client.api(`/users/${mailboxUPN}/events`).post(event);
    return { id: created.id, iCalUId: created.iCalUId };
  }

  async cancelEvent(
    azureTenant: string, clientId: string, clientSecret: string,
    mailboxUPN: string, graphId: string,
  ): Promise<void> {
    const tok = await this.token(azureTenant, clientId, clientSecret);
    const client = this.clientFor(tok);
    try {
      await client.api(`/users/${mailboxUPN}/events/${graphId}`).delete();
    } catch (e: any) {
      if (e?.statusCode === 404) return; // idempotent
      throw e;
    }
  }

  // --- Subscription lifecycle --------------------------------------------

  // ensureSubscription is idempotent. Called when a mailbox is mapped
  // and also from the hourly cron when an existing sub nears expiry.
  async ensureSubscription(tenantId: string, mailboxUPN: string): Promise<void> {
    const notifyUrl = process.env.GRAPH_NOTIFY_URL;
    if (!notifyUrl) {
      this.log.warn('GRAPH_NOTIFY_URL not set — skipping subscription ensure');
      return;
    }
    const cred = await this.creds.getDecrypted(tenantId, 'microsoft');
    if (!cred) return; // not configured yet
    const tok = await this.token(cred.azureTenantID, cred.clientID, cred.clientSecret);
    const client = this.clientFor(tok);

    const existing = await this.subs.findOne({ where: { tenantId, mailboxUPN } });
    if (existing) {
      if (existing.expiresAt.getTime() - Date.now() > 12 * 3600 * 1000) return;
      const renewedExpiry = new Date(Date.now() + GRAPH_NOTIFICATION_LIFETIME_HOURS * 3600 * 1000);
      await client.api(`/subscriptions/${existing.graphSubscriptionID}`).patch({
        expirationDateTime: renewedExpiry.toISOString(),
      });
      await this.subs.update({ id: existing.id }, { expiresAt: renewedExpiry });
      return;
    }

    const clientState = crypto.randomBytes(24).toString('hex');
    const expirationDateTime = new Date(Date.now() + GRAPH_NOTIFICATION_LIFETIME_HOURS * 3600 * 1000);
    const created = await client.api('/subscriptions').post({
      changeType: 'created,updated,deleted',
      notificationUrl: notifyUrl,
      resource: `/users/${mailboxUPN}/events`,
      expirationDateTime: expirationDateTime.toISOString(),
      clientState,
    });
    await this.subs.save(
      this.subs.create({
        tenantId,
        mailboxUPN,
        graphSubscriptionID: created.id,
        clientState,
        expiresAt: new Date(created.expirationDateTime || expirationDateTime),
      }),
    );
  }

  async removeSubscription(tenantId: string, mailboxUPN: string): Promise<void> {
    const existing = await this.subs.findOne({ where: { tenantId, mailboxUPN } });
    if (!existing) return;
    const cred = await this.creds.getDecrypted(tenantId, 'microsoft');
    if (cred) {
      try {
        const tok = await this.token(cred.azureTenantID, cred.clientID, cred.clientSecret);
        await this.clientFor(tok).api(`/subscriptions/${existing.graphSubscriptionID}`).delete();
      } catch (e) {
        this.log.warn(`graph delete subscription ${existing.graphSubscriptionID}: ${(e as Error).message}`);
      }
    }
    await this.subs.delete({ id: existing.id });
  }

  // Hourly cron — renews anything inside the 12h danger window.
  @Cron(CronExpression.EVERY_HOUR)
  async renewExpiring(): Promise<void> {
    const cutoff = new Date(Date.now() + 12 * 3600 * 1000);
    const due = await this.subs.find({ where: { expiresAt: LessThan(cutoff) } });
    for (const s of due) {
      try {
        await this.ensureSubscription(s.tenantId, s.mailboxUPN);
      } catch (e) {
        this.log.warn(`renew ${s.graphSubscriptionID}: ${(e as Error).message}`);
      }
    }
  }

  // Lookup by graph id — used by the notifications controller to verify
  // an inbound batch's clientState.
  findByGraphId(graphSubscriptionID: string) {
    return this.subs.findOne({ where: { graphSubscriptionID } });
  }
}
