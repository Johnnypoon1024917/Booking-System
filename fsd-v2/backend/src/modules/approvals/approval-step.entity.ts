import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn,
} from 'typeorm';

export type ApprovalStepStatus = 'pending' | 'approved' | 'rejected' | 'skipped';

// One materialized level on a specific booking. Step rows are written
// when the booking is created (chain materialization) and mutated as
// approvers decide.
@Entity('approval_steps')
@Index(['tenantId', 'bookingId'])
@Index(['tenantId', 'status'])
export class ApprovalStep {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column({ name: 'booking_id', type: 'uuid' }) bookingId!: string;
  @Column({ name: 'rule_id', type: 'uuid', nullable: true }) ruleId?: string;
  @Column({ name: 'step_index' }) stepIndex!: number;
  @Column({ name: 'level_name' }) levelName!: string;
  // text[] keeps the resolver simple — we already only filter by
  // membership and never join on it.
  @Column({ name: 'approver_ids', type: 'text', array: true, default: () => "'{}'" })
  approverIds!: string[];
  @Column({ name: 'approver_role', default: '' }) approverRole!: string;
  @Column({ name: 'min_grade', default: '' }) minGrade!: string;
  @Column({ length: 16, default: 'pending' }) status!: ApprovalStepStatus;
  @Column({ name: 'decided_by', type: 'uuid', nullable: true }) decidedBy?: string;
  @Column({ name: 'decision_at', type: 'timestamptz', nullable: true }) decisionAt?: Date;
  @Column({ default: '' }) reason!: string;
  @Column({ name: 'due_at', type: 'timestamptz', nullable: true }) dueAt?: Date;
  // ALL-of levels: every listed approver must sign off before the step flips
  // to 'approved'. `approvedBy` accumulates the distinct ids that have signed
  // so far; the step stays 'pending' until it covers all of `approverIds`.
  @Column({ name: 'require_all', default: false }) requireAll!: boolean;
  @Column({ name: 'approved_by', type: 'text', array: true, default: () => "'{}'" })
  approvedBy!: string[];
  // Delegation tracking. When an approver hands a pending step off to someone
  // else we keep a STRUCTURED record (not just a parsed note in `reason`) so the
  // approvals UI can show "delegated to X by Y" and admins can track ownership.
  // The delegate is ALSO added to `approverIds` so they can act; recording it
  // here is purely for display/audit and lets the original approver keep seeing
  // the booking (it never silently leaves their inbox).
  @Column({ name: 'delegated_to', type: 'uuid', nullable: true }) delegatedTo?: string;
  @Column({ name: 'delegated_by', type: 'uuid', nullable: true }) delegatedBy?: string;
  @Column({ name: 'delegated_at', type: 'timestamptz', nullable: true }) delegatedAt?: Date;
  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
}
