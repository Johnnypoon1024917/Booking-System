import {
  BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ApprovalRule, ApprovalLevel, ApprovalScopeType } from './approval-rule.entity';
import { ApprovalStep, ApprovalStepStatus } from './approval-step.entity';
import { Approval } from './approval.entity';
import { Booking } from '../bookings/booking.entity';
import { Resource } from '../resources/resource.entity';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { gradeAtLeast } from './grade';
import { NotificationsService } from '../notifications/notifications.service';

export interface DecideInput {
  status: 'approved' | 'rejected';
  reason?: string;
}

@Injectable()
export class ApprovalsService {
  private readonly log = new Logger(ApprovalsService.name);

  constructor(
    @InjectRepository(ApprovalRule) private readonly rules: Repository<ApprovalRule>,
    @InjectRepository(ApprovalStep) private readonly steps: Repository<ApprovalStep>,
    @InjectRepository(Approval) private readonly approvals: Repository<Approval>,
    @InjectRepository(Booking) private readonly bookings: Repository<Booking>,
    @InjectRepository(Resource) private readonly resources: Repository<Resource>,
    private readonly notifications: NotificationsService,
  ) {}

  // Load the (post-update) booking and enqueue an approval-outcome email.
  // Fire-and-forget: a notification failure must not fail the decision.
  private async notifyDecision(tenantId: string, bookingId: string, event: string) {
    const b = await this.bookings.findOne({ where: { id: bookingId, tenantId } });
    if (b) void this.notifications.enqueue(tenantId, event, b);
  }

  // ---- rule CRUD (admin) ----

  listRules(tenantId: string) {
    return this.rules.find({ where: { tenantId }, order: { priority: 'ASC' } });
  }

  async saveRule(tenantId: string, payload: Partial<ApprovalRule> & { id?: string }) {
    const incoming = this.rules.create({
      ...payload,
      tenantId,
      priority: payload.priority && payload.priority > 0 ? payload.priority : 100,
      levels: payload.levels ?? [],
      isActive: payload.isActive ?? true,
    });
    if (payload.id) incoming.id = payload.id;
    return this.rules.save(incoming);
  }

  async deleteRule(tenantId: string, id: string) {
    const r = await this.rules.findOne({ where: { id, tenantId } });
    if (!r) throw new NotFoundException('rule not found');
    await this.rules.delete(id);
  }

  // ---- chain construction ----

  // Materialize is called from booking creation after the row is saved.
  // Returns chain length (0 = no chain; single-level fallback handled by
  // booking.requiresApproval).
  async materialize(booking: Booking): Promise<number> {
    const res = await this.resources.findOne({ where: { id: booking.resourceId, tenantId: booking.tenantId } });
    if (!res) return 0;
    const rule = await this.matchRule(booking.tenantId, res);
    if (!rule || rule.levels.length === 0) return 0;

    const now = Date.now();
    const rows = rule.levels.map((lvl, i) =>
      this.steps.create({
        tenantId: booking.tenantId,
        bookingId: booking.id,
        ruleId: rule.id,
        stepIndex: i,
        levelName: lvl.name,
        approverIds: lvl.approver_user_ids ?? [],
        approverRole: lvl.approver_role ?? '',
        minGrade: lvl.min_grade ?? '',
        status: 'pending' as ApprovalStepStatus,
        dueAt: lvl.auto_after_hours && lvl.auto_after_hours > 0
          ? new Date(now + lvl.auto_after_hours * 3600_000)
          : undefined,
      }),
    );
    await this.steps.save(rows);
    return rule.levels.length;
  }

  // First-match by priority: resource > asset_type > department > tenant.
  // Inactive rules are skipped; if nothing matches we return null and
  // the caller falls back to the legacy single-level check.
  private async matchRule(tenantId: string, res: Resource): Promise<ApprovalRule | null> {
    const all = await this.rules.find({
      where: { tenantId, isActive: true },
      order: { priority: 'ASC' },
    });
    for (const r of all) {
      if (this.scopeMatches(r.scopeType, r.scopeValue, res)) return r;
    }
    return null;
  }

  private scopeMatches(type: ApprovalScopeType, value: string, res: Resource): boolean {
    switch (type) {
      case 'resource':   return res.id === value;
      case 'asset_type': return res.assetType === value;
      case 'department': return (res.departmentId ?? '') === value;
      case 'tenant':     return value === '';
    }
  }

  // ---- approver view ----

  // Lists bookings the user can act on right now. We walk pending steps,
  // collect the first-actionable per booking, and load the bookings in
  // one round-trip.
  async listPendingForApprover(user: AuthUser): Promise<Booking[]> {
    const pending = await this.steps.find({
      where: { tenantId: user.tenantId, status: 'pending' },
      order: { createdAt: 'ASC' },
    });

    // Group by booking so we can apply dependency / first-pending rules.
    // Need every step (not just pending) to evaluate dependencies, so a
    // second fetch loads the full chain for each booking we care about.
    const byBooking = new Map<string, ApprovalStep[]>();
    const bookingIds = Array.from(new Set(pending.map((p) => p.bookingId)));
    const fullChains = bookingIds.length
      ? await this.steps.find({
          where: { tenantId: user.tenantId, bookingId: In(bookingIds) },
        })
      : [];
    for (const s of fullChains) {
      const arr = byBooking.get(s.bookingId) ?? [];
      arr.push(s);
      byBooking.set(s.bookingId, arr);
    }

    const actionableIds: string[] = [];
    for (const [bookingId, steps] of byBooking) {
      steps.sort((a, b) => a.stepIndex - b.stepIndex);
      const rule = steps[0]?.ruleId
        ? await this.rules.findOne({ where: { id: steps[0].ruleId } })
        : null;
      const idx = this.firstActionableIndex(steps, rule, user);
      if (idx >= 0) actionableIds.push(bookingId);
    }

    // Single-level (legacy) bookings: status = Pending Approval, no chain.
    const legacyPending = await this.bookings.find({
      where: { tenantId: user.tenantId, status: 'Pending Approval' },
    });
    for (const b of legacyPending) {
      if (!byBooking.has(b.id) && this.canDecideLegacy(user)) actionableIds.push(b.id);
    }

    if (actionableIds.length === 0) return [];
    return this.bookings.find({
      where: { id: In(actionableIds), tenantId: user.tenantId },
      order: { startTime: 'ASC' },
    });
  }

  listChain(tenantId: string, bookingId: string) {
    return this.steps.find({
      where: { tenantId, bookingId },
      order: { stepIndex: 'ASC' },
    });
  }

  // ---- decide ----

  // Routes the decision through the chain if one is materialized,
  // otherwise falls back to a single-level approve/reject on the booking.
  async decide(user: AuthUser, bookingId: string, input: DecideInput): Promise<{ status: string; chained: boolean }> {
    if (input.status !== 'approved' && input.status !== 'rejected') {
      throw new BadRequestException('status must be approved or rejected');
    }
    if (input.status === 'rejected' && !(input.reason ?? '').trim()) {
      throw new BadRequestException('reason required for rejection');
    }

    const steps = await this.steps.find({
      where: { tenantId: user.tenantId, bookingId },
      order: { stepIndex: 'ASC' },
    });

    if (steps.length === 0) {
      await this.decideLegacy(user, bookingId, input);
      await this.recordApprovalAudit(user, bookingId, input);
      await this.notifyDecision(user.tenantId, bookingId,
        input.status === 'approved' ? 'BOOKING_APPROVED' : 'BOOKING_REJECTED');
      return { status: input.status, chained: false };
    }

    const rule = steps[0].ruleId
      ? await this.rules.findOne({ where: { id: steps[0].ruleId } }).catch(() => null)
      : null;
    if (steps[0].ruleId && !rule) {
      this.log.warn(`rule ${steps[0].ruleId} missing for booking ${bookingId}; degrading to linear chain`);
    }

    const idx = this.firstActionableIndex(steps, rule, user);
    if (idx < 0) throw new ForbiddenException('no actionable approval step for this user');

    const step = steps[idx];
    step.status = input.status;
    step.decidedBy = user.id;
    step.decisionAt = new Date();
    step.reason = input.reason ?? '';
    await this.steps.save(step);

    await this.recordApprovalAudit(user, bookingId, input);

    if (input.status === 'rejected') {
      await this.bookings.update(
        { id: bookingId, tenantId: user.tenantId },
        { status: 'Cancelled', exceptionNotes: `Rejected at ${step.levelName}: ${input.reason ?? ''}` },
      );
      await this.notifyDecision(user.tenantId, bookingId, 'BOOKING_REJECTED');
      return { status: 'rejected', chained: true };
    }

    // Approved — if all remaining steps are done (approved/skipped), confirm.
    const allDone = steps.every((s) =>
      s.id === step.id || s.status === 'approved' || s.status === 'skipped',
    );
    if (allDone) {
      await this.bookings.update(
        { id: bookingId, tenantId: user.tenantId },
        { status: 'Confirmed' },
      );
      // Only email the owner once the whole chain clears and the booking is
      // actually confirmed — intermediate step approvals don't change the
      // booking's status, so they stay silent.
      await this.notifyDecision(user.tenantId, bookingId, 'BOOKING_APPROVED');
    }
    return { status: 'approved', chained: true };
  }

  // Reassign the first pending step to another approver. Recorded on the
  // step's reason field (the timeline surfaces it) so it isn't a silent
  // reassignment.
  async delegate(user: AuthUser, bookingId: string, toUserId: string, reason: string) {
    if (!toUserId) throw new BadRequestException('to_user_id required');
    const steps = await this.steps.find({
      where: { tenantId: user.tenantId, bookingId },
      order: { stepIndex: 'ASC' },
    });
    const pending = steps.find((s) => s.status === 'pending');
    if (!pending) throw new NotFoundException('no pending approval step to delegate');

    pending.approverIds = [toUserId];
    pending.approverRole = '';
    const note = `Delegated ${user.id} → ${toUserId}${reason ? ` (${reason})` : ''}`;
    pending.reason = pending.reason ? `${pending.reason} · ${note}` : note;
    await this.steps.save(pending);
  }

  // ---- helpers ----

  private firstActionableIndex(
    steps: ApprovalStep[],
    rule: ApprovalRule | null,
    user: AuthUser,
  ): number {
    const depsOf = (i: number): number[] => {
      if (rule && rule.levels[i]?.dependencies?.length) return rule.levels[i].dependencies!;
      return i === 0 ? [] : [i - 1];
    };
    const isDone = (s: ApprovalStep) => s.status === 'approved' || s.status === 'skipped';

    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (s.status !== 'pending') continue;
      const deps = depsOf(i);
      if (!deps.every((d) => steps[d] && isDone(steps[d]))) continue;
      if (!this.canDecideStep(s, user)) continue;
      return i;
    }
    return -1;
  }

  // Eligibility: explicit user id list (with grade gate), OR matching role
  // (with grade gate), OR System Admin when the step has no specific
  // approvers and no role at all.
  private canDecideStep(step: ApprovalStep, user: AuthUser): boolean {
    if (step.approverIds?.includes(user.id)) return gradeAtLeast(user.grade, step.minGrade);
    if (step.approverRole && step.approverRole.toLowerCase() === user.role.toLowerCase()) {
      return gradeAtLeast(user.grade, step.minGrade);
    }
    if (user.role === Roles.SystemAdmin && (!step.approverIds || step.approverIds.length === 0) && !step.approverRole) {
      return true;
    }
    return false;
  }

  private canDecideLegacy(user: AuthUser): boolean {
    return [Roles.SystemAdmin, Roles.SecurityAdmin, Roles.RoomAdmin, Roles.Secretary].includes(user.role as any);
  }

  // Legacy single-level: flip Pending Approval → Confirmed/Cancelled
  // when no chain exists for the booking.
  private async decideLegacy(user: AuthUser, bookingId: string, input: DecideInput) {
    const b = await this.bookings.findOne({ where: { id: bookingId, tenantId: user.tenantId } });
    if (!b) throw new NotFoundException('booking not found');
    if (!this.canDecideLegacy(user)) throw new ForbiddenException();
    if (b.status !== 'Pending Approval' && b.status !== 'Confirmed') {
      throw new BadRequestException('booking is not pending approval');
    }
    if (input.status === 'approved') {
      if (b.status === 'Pending Approval') {
        await this.bookings.update({ id: b.id }, { status: 'Confirmed' });
      }
    } else {
      await this.bookings.update({ id: b.id }, {
        status: 'Cancelled',
        exceptionNotes: `Rejected: ${input.reason ?? ''}`,
      });
    }
  }

  private async recordApprovalAudit(user: AuthUser, bookingId: string, input: DecideInput) {
    await this.approvals.insert({
      tenantId: user.tenantId,
      bookingId,
      approverId: user.id,
      decision: input.status,
      reason: input.reason ?? '',
    });
  }
}
