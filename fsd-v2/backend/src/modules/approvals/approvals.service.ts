import {
  BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, LessThan, LessThanOrEqual, Repository } from 'typeorm';
import { ApprovalRule, ApprovalLevel, ApprovalScopeType } from './approval-rule.entity';
import { ApprovalStep, ApprovalStepStatus } from './approval-step.entity';
import { Approval } from './approval.entity';
import { Booking } from '../bookings/booking.entity';
import { Resource } from '../resources/resource.entity';
import { User } from '../users/user.entity';
import { Department } from '../departments/department.entity';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { gradeAtLeast } from './grade';
import { NotificationsService } from '../notifications/notifications.service';
import { PermissionsService } from '../permissions/permissions.service';
import { Perm } from '../permissions/permission-catalog';

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
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Department) private readonly departments: Repository<Department>,
    private readonly notifications: NotificationsService,
    private readonly permissions: PermissionsService,
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

    // Resolve dynamic targets (manager / department-head) to concrete user ids
    // ONCE — they're relative to this booking, not the rule. Looked up only if a
    // level actually uses them.
    const managerId = rule.levels.some((l) => l.approver_type === 'manager')
      ? (await this.users.findOne({ where: { id: booking.userId, tenantId: booking.tenantId } }))?.managerId
      : undefined;
    const headUserId = rule.levels.some((l) => l.approver_type === 'department_head') && res.departmentId
      ? (await this.departments.findOne({ where: { id: res.departmentId, tenantId: booking.tenantId } }))?.headUserId
      : undefined;

    const now = Date.now();
    const rows = rule.levels.map((lvl, i) => {
      const { approverIds, approverRole } = this.resolveLevelApprovers(lvl, managerId, headUserId, booking.id);
      return this.steps.create({
        tenantId: booking.tenantId,
        bookingId: booking.id,
        ruleId: rule.id,
        stepIndex: i,
        levelName: lvl.name,
        approverIds,
        approverRole,
        minGrade: lvl.min_grade ?? '',
        status: 'pending' as ApprovalStepStatus,
        dueAt: lvl.auto_after_hours && lvl.auto_after_hours > 0
          ? new Date(now + lvl.auto_after_hours * 3600_000)
          : undefined,
      });
    });
    await this.steps.save(rows);
    return rule.levels.length;
  }

  // Resolve a level's configured approver target to the concrete (ids, role)
  // stored on the step. Dynamic types ('manager'/'department_head') are baked
  // to ids here so the runtime eligibility check stays unchanged. If a dynamic
  // target can't be resolved (no manager / no head), the step is left with no
  // approvers — which makes it System-Admin-decidable (and still auto-approvable
  // by SLA), a safe fallback rather than a hard failure.
  private resolveLevelApprovers(
    lvl: ApprovalLevel, managerId: string | undefined, headUserId: string | undefined, bookingId: string,
  ): { approverIds: string[]; approverRole: string } {
    switch (lvl.approver_type) {
      case 'manager':
        if (!managerId) this.log.warn(`level "${lvl.name}" wants requester's manager but none is set (booking ${bookingId}); falling back to admin`);
        return { approverIds: managerId ? [managerId] : [], approverRole: '' };
      case 'department_head':
        if (!headUserId) this.log.warn(`level "${lvl.name}" wants department head but none is set (booking ${bookingId}); falling back to admin`);
        return { approverIds: headUserId ? [headUserId] : [], approverRole: '' };
      case 'role':
        return { approverIds: [], approverRole: lvl.approver_role ?? '' };
      // 'user' and legacy (undefined) keep the original static behaviour:
      // explicit ids plus an optional role.
      default:
        return { approverIds: lvl.approver_user_ids ?? [], approverRole: lvl.approver_role ?? '' };
    }
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
  // one round-trip. Each booking is enriched with `userName` (the requester)
  // so the approvals UI can render names without pulling the whole directory.
  async listPendingForApprover(
    user: AuthUser,
  ): Promise<Array<Booking & { userName: string | null; delegatedToName: string | null }>> {
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
      if (!byBooking.has(b.id) && this.canDecideLegacy(user, b)) actionableIds.push(b.id);
    }

    if (actionableIds.length === 0) return [];
    const list = await this.bookings.find({
      where: { id: In(actionableIds), tenantId: user.tenantId },
      order: { startTime: 'ASC' },
    });

    // Per booking, figure out who (if anyone) it is currently delegated to:
    // the first pending chain step's delegatedTo, or the legacy booking field.
    // Surfacing this on the inbox is QA #2 — admins can see ownership at a glance
    // instead of digging into a step's reason text.
    const delegateIdByBooking = new Map<string, string>();
    for (const b of list) {
      const steps = byBooking.get(b.id);
      const firstPending = steps?.sort((a, c) => a.stepIndex - c.stepIndex).find((s) => s.status === 'pending');
      const did = firstPending?.delegatedTo ?? b.delegatedTo ?? undefined;
      if (did) delegateIdByBooking.set(b.id, did);
    }

    // Resolve requester + delegate usernames in one batched query and attach
    // them, so the SPA no longer fetches the entire user directory to map ids.
    const nameById = await this.resolveUserNames(
      user.tenantId,
      [...list.map((b) => b.userId), ...delegateIdByBooking.values()],
    );
    return list.map((b) => ({
      ...b,
      userName: nameById.get(b.userId) ?? null,
      delegatedToName: delegateIdByBooking.has(b.id)
        ? nameById.get(delegateIdByBooking.get(b.id)!) ?? null
        : null,
    }));
  }

  // The full chain for a booking, each step enriched with the resolved
  // usernames behind its id references (decidedBy / delegatedTo / delegatedBy)
  // so the approvals timeline can render names — and explicitly show
  // "delegated to X by Y" — without the client pulling the user directory.
  async listChain(tenantId: string, bookingId: string) {
    const steps = await this.steps.find({
      where: { tenantId, bookingId },
      order: { stepIndex: 'ASC' },
    });
    const names = await this.resolveUserNames(tenantId, steps.flatMap((s) =>
      [s.decidedBy, s.delegatedTo, s.delegatedBy].filter((x): x is string => !!x)));
    return steps.map((s) => ({
      ...s,
      decidedByName: s.decidedBy ? names.get(s.decidedBy) ?? null : null,
      delegatedToName: s.delegatedTo ? names.get(s.delegatedTo) ?? null : null,
      delegatedByName: s.delegatedBy ? names.get(s.delegatedBy) ?? null : null,
    }));
  }

  // Batch-resolve a set of user ids → usernames (deduped, one query).
  private async resolveUserNames(tenantId: string, ids: string[]): Promise<Map<string, string>> {
    const unique = Array.from(new Set(ids.filter(Boolean)));
    if (!unique.length) return new Map();
    const rows = await this.users.find({
      where: { id: In(unique), tenantId },
      select: { id: true, username: true },
    });
    return new Map(rows.map((u) => [u.id, u.username]));
  }

  // The first step a booking is currently waiting on, resolved for display:
  // its level name, the role it routes to (if role-based), and the concrete
  // approver name(s) (if it targets specific users). Powers the "waiting on
  // approval from X" line the SPA shows right after a booking is requested.
  // Returns null when there is no materialized chain (legacy single-level
  // bookings) or every step is already decided.
  async firstPendingApprover(
    tenantId: string, bookingId: string,
  ): Promise<{ stepIndex: number; levelName: string; role: string; names: string[] } | null> {
    const steps = await this.steps.find({
      where: { tenantId, bookingId },
      order: { stepIndex: 'ASC' },
    });
    const pending = steps.find((s) => s.status === 'pending');
    if (!pending) return null;
    let names: string[] = [];
    if (pending.approverIds?.length) {
      const us = await this.users.find({
        where: { id: In(pending.approverIds), tenantId },
        select: { id: true, username: true },
      });
      names = us.map((u) => u.username);
    }
    return {
      stepIndex: pending.stepIndex,
      levelName: pending.levelName ?? '',
      role: pending.approverRole ?? '',
      names,
    };
  }

  // ---- decide ----

  // Routes the decision through the chain if one is materialized,
  // otherwise falls back to a single-level approve/reject on the booking.
  //
  // The whole read→evaluate→write runs inside ONE transaction with the step
  // rows (or the booking row, for legacy) locked FOR UPDATE. Without the lock,
  // two approvers in a parallel step clicking at the same instant would both
  // read the chain as "not yet all-done" and neither would flip the booking to
  // Confirmed, stranding it forever (the classic lost-update race).
  async decide(user: AuthUser, bookingId: string, input: DecideInput): Promise<{ status: string; chained: boolean }> {
    if (input.status !== 'approved' && input.status !== 'rejected') {
      throw new BadRequestException('status must be approved or rejected');
    }
    if (input.status === 'rejected' && !(input.reason ?? '').trim()) {
      throw new BadRequestException('reason required for rejection');
    }

    const outcome = await this.bookings.manager.transaction(async (m) => {
      const steps = await this.lockChain(m, user.tenantId, bookingId);

      if (steps.length === 0) {
        await this.decideLegacyTx(m, user, bookingId, input);
        await this.recordApprovalAudit(m, user.tenantId, bookingId, user.id, input);
        return { status: input.status, chained: false, notify: input.status === 'approved' ? 'BOOKING_APPROVED' : 'BOOKING_REJECTED' };
      }

      const rule = steps[0].ruleId
        ? await m.getRepository(ApprovalRule).findOne({ where: { id: steps[0].ruleId } }).catch(() => null)
        : null;
      if (steps[0].ruleId && !rule) {
        this.log.warn(`rule ${steps[0].ruleId} missing for booking ${bookingId}; degrading to linear chain`);
      }

      const idx = this.firstActionableIndex(steps, rule, user);
      if (idx < 0) throw new ForbiddenException('no actionable approval step for this user');

      const { confirmed, rejected } = await this.commitStepDecision(m, user.tenantId, bookingId, steps, steps[idx], input, user.id);
      await this.recordApprovalAudit(m, user.tenantId, bookingId, user.id, input);
      return {
        status: input.status, chained: true,
        // Only email the owner once the whole chain clears (confirm) or it is
        // rejected — intermediate step approvals don't change booking status.
        notify: rejected ? 'BOOKING_REJECTED' : confirmed ? 'BOOKING_APPROVED' : null,
      };
    });

    if (outcome.notify) await this.notifyDecision(user.tenantId, bookingId, outcome.notify);
    return { status: outcome.status, chained: outcome.chained };
  }

  // Lock and load the full chain for a booking in step order (SELECT … FOR
  // UPDATE). Must be called inside a transaction.
  private lockChain(m: EntityManager, tenantId: string, bookingId: string): Promise<ApprovalStep[]> {
    return m.getRepository(ApprovalStep).createQueryBuilder('s')
      .setLock('pessimistic_write')
      .where('s.tenant_id = :t AND s.booking_id = :b', { t: tenantId, b: bookingId })
      .orderBy('s.step_index', 'ASC')
      .getMany();
  }

  // Apply a single approver's decision to one already-locked step and, if the
  // chain is now complete, flip the booking. Shared by decide() and the
  // auto-approval sweep so both go through the identical confirm logic.
  // `actorId` is null for system/auto decisions.
  private async commitStepDecision(
    m: EntityManager, tenantId: string, bookingId: string,
    steps: ApprovalStep[], step: ApprovalStep, input: DecideInput, actorId: string | null,
  ): Promise<{ confirmed: boolean; rejected: boolean }> {
    step.status = input.status;
    step.decidedBy = actorId ?? undefined;
    step.decisionAt = new Date();
    step.reason = input.reason ?? '';
    await m.getRepository(ApprovalStep).save(step);

    if (input.status === 'rejected') {
      await m.getRepository(Booking).update(
        { id: bookingId, tenantId },
        { status: 'Cancelled', exceptionNotes: `Rejected at ${step.levelName}: ${input.reason ?? ''}` },
      );
      return { confirmed: false, rejected: true };
    }

    // Approved — confirm the booking only when every step is approved/skipped.
    // `steps` is the locked snapshot; `step` was just mutated in place.
    const allDone = steps.every((s) =>
      s.id === step.id || s.status === 'approved' || s.status === 'skipped',
    );
    if (allDone) {
      await m.getRepository(Booking).update({ id: bookingId, tenantId }, { status: 'Confirmed' });
    }
    return { confirmed: allDone, rejected: false };
  }

  // ---- auto-approval sweep (cron-driven) ----

  // Approve every pending step whose SLA (dueAt) has elapsed. Called from the
  // ApprovalsCron every few minutes. Each step is handled in its own locked
  // transaction so one tenant's bad row can't abort the rest of the sweep, and
  // so it interleaves safely with live approver clicks. Returns the count
  // actually approved.
  async runDueAutoApprovals(now: Date = new Date()): Promise<number> {
    const due = await this.steps.find({
      where: { status: 'pending', dueAt: LessThanOrEqual(now) },
      order: { createdAt: 'ASC' },
    });
    let approved = 0;
    for (const s of due) {
      try {
        const did = await this.autoApproveStep(s.tenantId, s.bookingId, s.id, now);
        if (did) approved++;
      } catch (err) {
        this.log.warn(`auto-approve failed for step ${s.id} (booking ${s.bookingId}): ${(err as Error).message}`);
      }
    }
    if (approved) this.log.log(`auto-approved ${approved} overdue approval step(s)`);
    return approved;
  }

  // Auto-approve one overdue step under a row lock. Re-checks status/dueAt
  // inside the transaction so a step a human just actioned (or that was already
  // swept) is skipped rather than double-decided. Returns true if it acted.
  private async autoApproveStep(tenantId: string, bookingId: string, stepId: string, now: Date): Promise<boolean> {
    const input: DecideInput = { status: 'approved', reason: 'Auto-approved by system policy' };
    const confirmed = await this.bookings.manager.transaction(async (m) => {
      const steps = await this.lockChain(m, tenantId, bookingId);
      const step = steps.find((s) => s.id === stepId);
      if (!step || step.status !== 'pending') return null;           // already decided/swept
      if (!step.dueAt || step.dueAt.getTime() > now.getTime()) return null; // no longer overdue
      const res = await this.commitStepDecision(m, tenantId, bookingId, steps, step, input, null);
      await this.recordApprovalAudit(m, tenantId, bookingId, null, input);
      return res.confirmed;
    });
    if (confirmed === null) return false;
    if (confirmed) await this.notifyDecision(tenantId, bookingId, 'BOOKING_APPROVED');
    return true;
  }

  // ---- stale-approval sweep (cron-driven) ----

  // Auto-reject bookings stuck in Pending Approval whose start time has already
  // passed. If the approver goes on vacation (or simply never acts) the request
  // would otherwise sit Pending Approval forever — permanently blocking the room
  // from anyone else and clogging the approver's inbox. We flip each to the same
  // terminal state a human rejection uses (Cancelled), clear any still-pending
  // chain steps so it leaves every approver's inbox, release the room, and email
  // the requester that the meeting was aborted. Each booking is handled in its
  // own conditional transaction so a live approve/reject in the same tick wins
  // the race instead of being clobbered. Returns the count actually rejected.
  async sweepStaleApprovals(now: Date = new Date()): Promise<number> {
    const stale = await this.bookings.find({
      where: { status: 'Pending Approval', startTime: LessThan(now) },
      order: { startTime: 'ASC' },
      take: 1000,
    });
    let rejected = 0;
    for (const b of stale) {
      try {
        if (await this.autoRejectStale(b.tenantId, b.id, now)) rejected++;
      } catch (err) {
        this.log.warn(`stale-approval auto-reject failed for booking ${b.id}: ${(err as Error).message}`);
      }
    }
    if (rejected) this.log.log(`auto-rejected ${rejected} stale pending-approval booking(s)`);
    return rejected;
  }

  // Reject one stale booking under a conditional write. The booking row is only
  // flipped while it is STILL Pending Approval, so an approver/auto-approval that
  // confirmed it microseconds earlier is left untouched (affected === 0 → no-op).
  private async autoRejectStale(tenantId: string, bookingId: string, now: Date): Promise<boolean> {
    const note = 'Auto-rejected: approver did not act before the meeting start time';
    const acted = await this.bookings.manager.transaction(async (m) => {
      const res = await m.getRepository(Booking).update(
        { id: bookingId, tenantId, status: 'Pending Approval' },
        { status: 'Cancelled', exceptionNotes: note },
      );
      if (!res.affected) return false;
      // The approver inbox is driven off pending STEP rows, not booking status,
      // so a chained booking would linger there unless we also close its steps.
      await m.getRepository(ApprovalStep).update(
        { tenantId, bookingId, status: 'pending' as ApprovalStepStatus },
        { status: 'rejected' as ApprovalStepStatus, reason: note, decisionAt: now },
      );
      return true;
    });
    if (acted) await this.notifyDecision(tenantId, bookingId, 'BOOKING_REJECTED');
    return acted;
  }

  // Reassign approval to another user. For a materialized chain we re-point
  // the first pending step; for a LEGACY (single-level, no chain) booking
  // there is no step to reassign, so we hand off via Booking.delegatedTo
  // instead of 404-ing. Recorded on the step reason / booking notes so the
  // timeline surfaces it.
  async delegate(user: AuthUser, bookingId: string, toUserId: string, reason: string) {
    if (!toUserId) throw new BadRequestException('to_user_id required');
    // Eligibility (QA #1): a delegation is only meaningful if the recipient can
    // actually act on it. Reject targets who lack approval.decide — otherwise the
    // booking lands with someone who has no way to review or approve it, and the
    // request stalls. Resolved against the tenant permission matrix (the same
    // source the approve/reject guard reads), so the picker filter and this
    // server check can never disagree.
    await this.assertEligibleDelegate(user.tenantId, toUserId);
    const steps = await this.steps.find({
      where: { tenantId: user.tenantId, bookingId },
      order: { stepIndex: 'ASC' },
    });

    const pending = steps.find((s) => s.status === 'pending');
    if (pending) {
      // Authorization (the "approval hijack" fix): only the approver currently
      // assigned to this step — or an admin — may hand it off. Without this
      // gate any authenticated user could POST /delegate, re-point the step to
      // themselves, then approve their own restricted booking. canDecideStep
      // covers the assigned approver (and an admin standing in for an
      // unassigned step); isAdmin additionally lets an admin reassign a step
      // that already targets specific approvers.
      if (!this.canDecideStep(pending, user) && !this.isAdmin(user)) {
        throw new ForbiddenException('You are not authorized to delegate this step.');
      }
      // Enterprise behaviour (QA #2/#3): record the delegate as a structured
      // field and ADD them to the approver set rather than REPLACING it. The
      // original approver (and any role-based approvers) therefore keep the
      // booking in view — it never silently vanishes from a multi-step chain —
      // while the delegate gains the ability to act. Ownership is explicit via
      // delegatedTo/delegatedBy so the UI can render "delegated to X by Y".
      pending.delegatedTo = toUserId;
      pending.delegatedBy = user.id;
      pending.delegatedAt = new Date();
      if (!pending.approverIds?.includes(toUserId)) {
        pending.approverIds = [...(pending.approverIds ?? []), toUserId];
      }
      const note = `Delegated ${user.id} → ${toUserId}${reason ? ` (${reason})` : ''}`;
      pending.reason = pending.reason ? `${pending.reason} · ${note}` : note;
      await this.steps.save(pending);
      return;
    }

    // Legacy single-level fallback: no chain rows exist. Verify the booking is
    // genuinely a pending legacy booking, then record the hand-off on it.
    if (steps.length > 0) throw new BadRequestException('approval chain is already decided');
    const b = await this.bookings.findOne({ where: { id: bookingId, tenantId: user.tenantId } });
    if (!b) throw new NotFoundException('booking not found');
    if (b.status !== 'Pending Approval') {
      throw new BadRequestException('booking is not pending approval');
    }
    // Same hijack gate for the legacy path: only an existing approver (an admin
    // role, or whoever it was already delegated to) may re-delegate it.
    if (!this.canDecideLegacy(user, b)) {
      throw new ForbiddenException('You are not authorized to delegate this booking.');
    }
    const note = `Delegated ${user.id} → ${toUserId}${reason ? ` (${reason})` : ''}`;
    await this.bookings.update(
      { id: bookingId, tenantId: user.tenantId },
      { delegatedTo: toUserId, exceptionNotes: b.exceptionNotes ? `${b.exceptionNotes} · ${note}` : note },
    );
  }

  // Throw unless `toUserId` is an active user in the tenant whose role holds
  // approval.decide. Shared by the delegate endpoint; the directory typeahead
  // applies the same filter so an ineligible user never appears as an option.
  private async assertEligibleDelegate(tenantId: string, toUserId: string) {
    const target = await this.users.findOne({
      where: { id: toUserId, tenantId },
      select: { id: true, role: true, isActive: true },
    });
    if (!target || !target.isActive) {
      throw new BadRequestException('Selected user is not an active member of this tenant.');
    }
    const canApprove = await this.permissions.hasPermission(tenantId, target.role, Perm.ApprovalDecide);
    if (!canApprove) {
      throw new BadRequestException(
        'Selected user cannot approve bookings (their role has no approval permission). Pick an eligible approver.',
      );
    }
  }

  // Filter a directory search down to users who can actually approve, so the
  // delegate picker only ever offers eligible approvers. Permission lookups are
  // memoised per distinct role (a few roles cover any result page).
  async filterEligibleApprovers<T extends { role: string }>(tenantId: string, list: T[]): Promise<T[]> {
    const byRole = new Map<string, boolean>();
    const out: T[] = [];
    for (const u of list) {
      let ok = byRole.get(u.role);
      if (ok === undefined) {
        ok = await this.permissions.hasPermission(tenantId, u.role, Perm.ApprovalDecide);
        byRole.set(u.role, ok);
      }
      if (ok) out.push(u);
    }
    return out;
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

  // A user may decide a legacy booking if they hold an approver role, OR the
  // booking was explicitly delegated to them (even if they're a plain user).
  private canDecideLegacy(user: AuthUser, booking?: Booking): boolean {
    if (booking?.delegatedTo && booking.delegatedTo === user.id) return true;
    return this.isAdmin(user);
  }

  // Holds one of the approver-capable admin roles. Used as the override that
  // lets an admin delegate/decide a step they aren't the named approver for.
  private isAdmin(user: AuthUser): boolean {
    return [Roles.SystemAdmin, Roles.SecurityAdmin, Roles.RoomAdmin, Roles.Secretary].includes(user.role as any);
  }

  // Legacy single-level: flip Pending Approval → Confirmed/Cancelled when no
  // chain exists. Runs inside the caller's transaction with the booking row
  // locked FOR UPDATE so concurrent legacy decisions can't race.
  private async decideLegacyTx(m: EntityManager, user: AuthUser, bookingId: string, input: DecideInput) {
    const b = await m.getRepository(Booking).createQueryBuilder('b')
      .setLock('pessimistic_write')
      .where('b.id = :id AND b.tenant_id = :t', { id: bookingId, t: user.tenantId })
      .getOne();
    if (!b) throw new NotFoundException('booking not found');
    if (!this.canDecideLegacy(user, b)) throw new ForbiddenException();
    if (b.status !== 'Pending Approval' && b.status !== 'Confirmed') {
      throw new BadRequestException('booking is not pending approval');
    }
    if (input.status === 'approved') {
      if (b.status === 'Pending Approval') {
        await m.getRepository(Booking).update({ id: b.id }, { status: 'Confirmed' });
      }
    } else {
      await m.getRepository(Booking).update({ id: b.id }, {
        status: 'Cancelled',
        exceptionNotes: `Rejected: ${input.reason ?? ''}`,
      });
    }
  }

  // Append an immutable decision row. `approverId` is null for system/auto
  // decisions. Uses the supplied transactional manager so the audit commits
  // atomically with the decision.
  private async recordApprovalAudit(
    m: EntityManager, tenantId: string, bookingId: string, approverId: string | null, input: DecideInput,
  ) {
    await m.getRepository(Approval).insert({
      tenantId,
      bookingId,
      approverId: approverId ?? undefined,
      decision: input.status,
      reason: input.reason ?? '',
    });
  }
}
