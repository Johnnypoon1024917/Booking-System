import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ApprovalsService } from './approvals.service';

// Drives the auto-approval SLA. Without this sweep the `dueAt` an admin
// configures via a level's `auto_after_hours` is written but never acted on,
// so "auto-approve after N hours" silently never fires. Every 5 minutes we
// approve any pending step whose dueAt has elapsed (see
// ApprovalsService.runDueAutoApprovals, which locks each step transactionally
// so it interleaves safely with live approver clicks). Mirrors holidays.cron.
@Injectable()
export class ApprovalsCron {
  private readonly log = new Logger(ApprovalsCron.name);

  constructor(private readonly approvals: ApprovalsService) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async sweepAutoApprovals() {
    try {
      await this.approvals.runDueAutoApprovals();
    } catch (err) {
      this.log.error(`auto-approval sweep failed: ${(err as Error).message}`);
    }
  }
}
