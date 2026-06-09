import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  DataSource,
  EntitySubscriberInterface,
  EventSubscriber,
  InsertEvent,
  ObjectLiteral,
  RemoveEvent,
  UpdateEvent,
} from 'typeorm';
import { ColumnMetadata } from 'typeorm/metadata/ColumnMetadata';
import { AuditEntry } from './audit.entity';
import { clientIp, reqPath } from './audit.service';
import { tenantContext } from '../../common/tenant-context';

// Field-level audit subscriber.
//
// The global AuditInterceptor records THAT a mutation happened (who / when /
// IP / verb+path / outcome). This subscriber records WHAT CHANGED, down to the
// individual column: a per-field { before, after } diff written into the same
// audit_log row's `previous` / `next` JSONB. Together they give the
// government-grade trail: every persisted create / update / delete carries the
// exact old and new value of every field that moved.
//
// Design notes:
//   - It writes on the request's OWN transaction (event.manager), so the audit
//     row commits or rolls back atomically WITH the change it describes — the
//     log can never claim a change that didn't actually land, and vice-versa.
//     (Denied / failed actions never reach an entity write; those are caught by
//     the interceptor's out-of-band write instead.)
//   - It only fires inside an authenticated REQUEST context. Boot seeders,
//     crons and other system writes are deterministic setup, not governed user
//     actions, and would otherwise bury the signal — they are skipped.
//   - Secrets (password hashes, MFA/TOTP secrets, tokens, keys) are REDACTED to
//     '[redacted]': the FACT a secret field changed is logged, never its value.
//   - The audit_log table itself is skipped to avoid an infinite recursion.
//
// Coverage caveat: subscribers fire for the entity-object write paths
// (repo.save(entity), repo.remove(entity)) — which is how this codebase mutates
// data. Bulk/criteria writes that bypass the ORM object lifecycle
// (repo.update(criteria, …), repo.delete(criteria), QueryBuilder .update()/
// .delete(), raw SQL) do NOT raise these events, so they get no field-level
// diff — the interceptor still records that the request mutated something.
@Injectable()
@EventSubscriber()
export class AuditSubscriber implements EntitySubscriberInterface {
  private readonly log = new Logger(AuditSubscriber.name);

  // Never audit the audit trail itself (would recurse on every write below).
  private static readonly SKIP_TABLES = new Set(['audit_log']);

  // Any column whose property OR db name matches this is a secret: log that it
  // changed, but store a placeholder instead of the value. Deliberately broad —
  // over-redacting a non-secret is harmless; leaking one into a government log
  // is not.
  private static readonly SECRET = /pass|secret|token|hash|public_key|private_key|publickey|privatekey|credential|mfa|otp|recovery|backup|salt/i;
  private static readonly REDACTED = '[redacted]';

  constructor(@InjectDataSource() dataSource: DataSource) {
    // Register ourselves on the connection. (Nest discovers the provider, but
    // TypeORM only invokes subscribers present in dataSource.subscribers.)
    dataSource.subscribers.push(this);
  }

  // --- lifecycle hooks (all run AFTER the SQL, inside the same transaction) ---

  async afterInsert(event: InsertEvent<ObjectLiteral>): Promise<void> {
    if (this.shouldSkip(event)) return;
    const next = this.snapshot(event, event.entity);
    if (!next || !Object.keys(next).length) return;
    await this.record(event, 'CREATED', 'info', event.entity, undefined, next);
  }

  async afterUpdate(event: UpdateEvent<ObjectLiteral>): Promise<void> {
    if (this.shouldSkip(event)) return;
    const subject = (event.entity ?? event.databaseEntity) as ObjectLiteral | undefined;
    if (!subject) return;
    const { previous, next } = this.diff(event);
    // A no-op save (no column actually moved) is noise — don't log it.
    if (!Object.keys(next).length) return;
    await this.record(event, 'UPDATED', 'info', subject, previous, next);
  }

  async afterRemove(event: RemoveEvent<ObjectLiteral>): Promise<void> {
    if (this.shouldSkip(event)) return;
    const subject = (event.databaseEntity ?? event.entity) as ObjectLiteral | undefined;
    if (!subject) return;
    // Capture the deleted row's state as `previous` so the trail shows what was
    // destroyed.
    const previous = this.snapshot(event, subject);
    await this.record(event, 'DELETED', 'warning', subject, previous, undefined);
  }

  // --- helpers ---------------------------------------------------------------

  private shouldSkip(event: { metadata: { tableName: string } }): boolean {
    if (AuditSubscriber.SKIP_TABLES.has(event.metadata.tableName)) return true;
    // Only audit real user actions — require an authenticated request context.
    return !tenantContext.getStore()?.req?.user;
  }

  // Full redacted snapshot of an entity's own columns (for create/delete).
  private snapshot(
    event: { metadata: { columns: ColumnMetadata[] } },
    entity: ObjectLiteral,
  ): Record<string, any> {
    const out: Record<string, any> = {};
    for (const col of event.metadata.columns) {
      const p = col.propertyName;
      if (!Object.prototype.hasOwnProperty.call(entity, p)) continue;
      const v = entity[p];
      if (v === undefined) continue;
      out[p] = this.clean(col, v);
    }
    return out;
  }

  // Per-field diff for an update: only columns whose value actually moved.
  private diff(event: UpdateEvent<ObjectLiteral>): {
    previous: Record<string, any>;
    next: Record<string, any>;
  } {
    const previous: Record<string, any> = {};
    const next: Record<string, any> = {};
    const before = event.databaseEntity as ObjectLiteral | undefined;
    const after = (event.entity ?? {}) as ObjectLiteral;

    for (const col of event.metadata.columns) {
      const p = col.propertyName;
      // Only consider a column the caller actually supplied on this save, so a
      // partial save({ id, x }) doesn't read every other column as "→ undefined".
      if (!Object.prototype.hasOwnProperty.call(after, p)) continue;
      const a = before ? before[p] : undefined;
      const b = after[p];
      if (this.eq(a, b)) continue;
      previous[p] = this.clean(col, a);
      next[p] = this.clean(col, b);
    }
    return { previous, next };
  }

  // Redact secrets; pass everything else through untouched.
  private clean(col: ColumnMetadata, value: any): any {
    if (value === undefined || value === null) return value ?? null;
    if (
      AuditSubscriber.SECRET.test(col.propertyName) ||
      AuditSubscriber.SECRET.test(col.databaseName)
    ) {
      return AuditSubscriber.REDACTED;
    }
    return value;
  }

  private eq(a: any, b: any): boolean {
    if (a === b) return true;
    if (a == null && b == null) return true;
    if (a == null || b == null) return false;
    if (a instanceof Date || b instanceof Date) {
      const ta = a instanceof Date ? a.getTime() : new Date(a).getTime();
      const tb = b instanceof Date ? b.getTime() : new Date(b).getTime();
      return ta === tb;
    }
    if (typeof a === 'object' && typeof b === 'object') {
      try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
    }
    return false;
  }

  private primaryId(
    event: { metadata: { primaryColumns: ColumnMetadata[] } },
    entity: ObjectLiteral,
  ): string | undefined {
    for (const pk of event.metadata.primaryColumns) {
      const v = entity[pk.propertyName];
      if (v !== undefined && v !== null) return String(v).slice(0, 128);
    }
    const fallback = (entity as any).id;
    return fallback != null ? String(fallback).slice(0, 128) : undefined;
  }

  // Write the field-level entry on the request's transaction. Best-effort: a
  // failed audit insert must never break the user's action, so it's caught and
  // logged rather than rethrown.
  private async record(
    event: { manager: any; metadata: { name: string; tableName: string; primaryColumns: ColumnMetadata[] } },
    verb: 'CREATED' | 'UPDATED' | 'DELETED',
    severity: 'info' | 'warning',
    subject: ObjectLiteral,
    previous?: Record<string, any>,
    next?: Record<string, any>,
  ): Promise<void> {
    const req = tenantContext.getStore()?.req;
    const user = req?.user;
    try {
      await event.manager.insert(AuditEntry, {
        tenantId: (subject as any).tenantId ?? user?.tenantId,
        userId: user?.id,
        username: user?.username || 'system',
        action: `${event.metadata.name}.${verb}`.slice(0, 128),
        severity,
        outcome: 'success',
        targetEntity: event.metadata.tableName.slice(0, 64),
        targetId: this.primaryId(event, subject),
        method: req?.method,
        path: req ? reqPath(req) : undefined,
        ip: req ? clientIp(req) : undefined,
        userAgent: req ? String(req.headers?.['user-agent'] ?? '').slice(0, 512) : undefined,
        previous: previous && Object.keys(previous).length ? previous : undefined,
        next: next && Object.keys(next).length ? next : undefined,
      });
    } catch (err) {
      this.log.warn(`field-level audit insert failed (${event.metadata.name}.${verb}): ${(err as Error).message}`);
    }
  }
}
