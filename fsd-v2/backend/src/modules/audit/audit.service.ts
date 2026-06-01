import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, Repository } from 'typeorm';
import { AuditEntry } from './audit.entity';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { tenantContext } from '../../common/tenant-context';

export interface AuditEvent {
  action: string;
  severity?: 'info' | 'warning' | 'critical';
  outcome?: 'success' | 'failure' | 'denied';
  targetEntity?: string;
  targetId?: string;
  previous?: Record<string, any>;
  next?: Record<string, any>;
}

// A fully-assembled row for the low-level writer. Used by the global
// AuditInterceptor and the auth flow, which log outside a normal
// authenticated handler (no AuthUser, sometimes no tenant).
export interface AuditRow {
  tenantId?: string;
  userId?: string;
  username: string;
  action: string;
  severity?: string;
  outcome?: string;
  targetEntity?: string;
  targetId?: string;
  method?: string;
  path?: string;
  statusCode?: number;
  ip?: string;
  userAgent?: string;
  previous?: Record<string, any>;
  next?: Record<string, any>;
}

export interface AuditQuery {
  action?: string;
  outcome?: string;
  userId?: string;
  q?: string;
  from?: string;
  to?: string;
  limit?: number;
}

@Injectable()
export class AuditService {
  private readonly log = new Logger(AuditService.name);

  constructor(
    @InjectRepository(AuditEntry) private readonly repo: Repository<AuditEntry>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  // Rich, semantic record from inside an instrumented handler. Runs on the
  // request's tenant transaction (commits with the action), and enriches the
  // entry with the caller's IP / user-agent pulled from the request context.
  // It also flags the request so the global AuditInterceptor doesn't write a
  // duplicate generic entry for the same call.
  async record(user: AuthUser, ev: AuditEvent) {
    const req = tenantContext.getStore()?.req;
    if (req) req.__richAudited = true;
    try {
      await this.repo.insert({
        tenantId: user.tenantId,
        userId: user.id,
        username: user.username,
        action: ev.action,
        severity: ev.severity ?? 'info',
        outcome: ev.outcome ?? 'success',
        targetEntity: ev.targetEntity,
        targetId: ev.targetId,
        method: req?.method,
        path: req ? reqPath(req) : undefined,
        ip: req ? clientIp(req) : undefined,
        userAgent: req ? String(req.headers?.['user-agent'] ?? '').slice(0, 512) : undefined,
        previous: ev.previous,
        next: ev.next,
      });
    } catch (err) {
      this.log.warn(`audit insert failed: ${(err as Error).message}`);
    }
  }

  // Best-effort out-of-band write. Opens its OWN connection + transaction
  // (never the request's), so the entry persists even when the request itself
  // rolls back — which is exactly the case we most need to audit: a denied or
  // failed action. Sets the tenant GUC so the row passes the RLS WITH CHECK.
  async write(row: AuditRow) {
    const qr = this.dataSource.createQueryRunner();
    try {
      await qr.connect();
      await qr.startTransaction();
      if (row.tenantId) {
        await qr.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [row.tenantId]);
      }
      await qr.manager.insert(AuditEntry, {
        tenantId: row.tenantId,
        userId: row.userId,
        username: row.username || 'anonymous',
        action: row.action.slice(0, 128),
        severity: row.severity ?? 'info',
        outcome: row.outcome ?? 'success',
        targetEntity: row.targetEntity,
        targetId: row.targetId,
        method: row.method,
        path: row.path?.slice(0, 512),
        statusCode: row.statusCode,
        ip: row.ip?.slice(0, 64),
        userAgent: row.userAgent?.slice(0, 512),
        previous: row.previous,
        next: row.next,
      });
      await qr.commitTransaction();
    } catch (err) {
      try { await qr.rollbackTransaction(); } catch { /* nothing to roll back */ }
      this.log.warn(`audit write failed: ${(err as Error).message}`);
    } finally {
      try { await qr.release(); } catch { /* already released */ }
    }
  }

  list(tenantId: string, query: AuditQuery = {}) {
    const limit = Math.min(query.limit ?? 100, 500);
    const qb = this.repo.createQueryBuilder('a')
      .where('a.tenant_id = :tenantId', { tenantId });

    if (query.action) qb.andWhere('a.action = :action', { action: query.action });
    if (query.outcome) qb.andWhere('a.outcome = :outcome', { outcome: query.outcome });
    if (query.userId) qb.andWhere('a.user_id = :userId', { userId: query.userId });
    if (query.from) qb.andWhere('a.created_at >= :from', { from: query.from });
    if (query.to) qb.andWhere('a.created_at <= :to', { to: query.to });
    if (query.q) {
      qb.andWhere(new Brackets((w) => {
        w.where('a.username ILIKE :q', { q: `%${query.q}%` })
          .orWhere('a.action ILIKE :q', { q: `%${query.q}%` })
          .orWhere('a.path ILIKE :q', { q: `%${query.q}%` })
          .orWhere('a.target_id ILIKE :q', { q: `%${query.q}%` });
      }));
    }

    return qb.orderBy('a.created_at', 'DESC').take(limit).getMany();
  }

  // Distinct action names in this tenant — powers the viewer's action filter
  // dropdown without hard-coding the (growing) vocabulary.
  async actions(tenantId: string): Promise<string[]> {
    const rows: Array<{ action: string }> = await this.repo.createQueryBuilder('a')
      .select('DISTINCT a.action', 'action')
      .where('a.tenant_id = :tenantId', { tenantId })
      .orderBy('a.action', 'ASC')
      .getRawMany();
    return rows.map((r) => r.action);
  }
}

// --- request helpers -------------------------------------------------------

export function clientIp(req: any): string {
  const fwd = req.headers?.['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim().slice(0, 64);
  return String(req.ip || req.socket?.remoteAddress || '').slice(0, 64);
}

export function reqPath(req: any): string {
  return String(req.originalUrl || req.url || '').split('?')[0].slice(0, 512);
}
