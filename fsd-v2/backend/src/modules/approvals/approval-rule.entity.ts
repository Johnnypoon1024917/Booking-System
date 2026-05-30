import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn,
} from 'typeorm';

// Scope kinds — mirrors v1 domain/approval/rule.go constants so payloads
// round-trip across stacks during cut-over.
export type ApprovalScopeType = 'asset_type' | 'resource' | 'department' | 'tenant';

// How a level's approver set is resolved. 'user'/'role' are the static forms
// (explicit ids or a role + min_grade). 'manager' and 'department_head' are
// RELATIVE to the booking and resolved to concrete user ids at materialization
// time, so admins never have to re-point rules when people move teams.
// Absent ⇒ legacy static behaviour (ids/role), so old rules keep working.
export type ApproverType = 'user' | 'role' | 'manager' | 'department_head';

// One level in the chain. At runtime resolved to a concrete approver set
// via (specific user ids) OR (role + min_grade) OR a dynamic target.
// Dependencies allow fan-in; empty deps default to the legacy linear
// "previous must be done".
export interface ApprovalLevel {
  name: string;
  approver_type?: ApproverType;
  approver_user_ids?: string[];
  approver_role?: string;
  min_grade?: string;
  auto_after_hours?: number;
  dependencies?: number[];
  parallel?: boolean;
  // When true (and the level has >1 specific approver) every listed approver
  // must approve. Default/false keeps the historical "any one approver" rule.
  require_all?: boolean;
}

@Entity('approval_rules')
@Index(['tenantId', 'priority'])
export class ApprovalRule {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column() name!: string;
  @Column({ name: 'scope_type', length: 32 }) scopeType!: ApprovalScopeType;
  @Column({ name: 'scope_value', default: '' }) scopeValue!: string;
  @Column({ default: 100 }) priority!: number;
  // jsonb so we can store the variable-shape level array without a
  // separate join table — admin edits are atomic and we never query
  // levels in isolation.
  @Column({ type: 'jsonb', default: () => "'[]'" }) levels!: ApprovalLevel[];
  @Column({ name: 'is_active', default: true }) isActive!: boolean;

  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt!: Date;
}
