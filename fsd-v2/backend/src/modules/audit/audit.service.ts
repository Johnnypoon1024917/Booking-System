import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditEntry } from './audit.entity';
import { AuthUser } from '../../common/decorators/current-user.decorator';

export interface AuditEvent {
  action: string;
  severity?: 'info' | 'warning' | 'critical';
  outcome?: 'success' | 'failure' | 'denied';
  targetEntity?: string;
  targetId?: string;
  previous?: Record<string, any>;
  next?: Record<string, any>;
}

@Injectable()
export class AuditService {
  private readonly log = new Logger(AuditService.name);

  constructor(@InjectRepository(AuditEntry) private readonly repo: Repository<AuditEntry>) {}

  // Best-effort write: a failed audit insert must never break the
  // primary action. The SHA-256 hash chain from v1 is a nice-to-have
  // upgrade later — same shape, just add a previous_hash column.
  async record(user: AuthUser, ev: AuditEvent) {
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
        previous: ev.previous,
        next: ev.next,
      });
    } catch (err) {
      this.log.warn(`audit insert failed: ${(err as Error).message}`);
    }
  }

  list(tenantId: string, limit = 100) {
    return this.repo.find({
      where: { tenantId },
      order: { createdAt: 'DESC' },
      take: Math.min(limit, 500),
    });
  }
}
