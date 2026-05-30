import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn,
} from 'typeorm';

// Decision audit row — kept alongside ApprovalStep so we have an
// immutable record even after a booking is cancelled or its chain
// rule is deleted.
export type ApprovalDecision = 'approved' | 'rejected';

@Entity('approvals')
@Index(['tenantId', 'bookingId'])
export class Approval {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column({ name: 'booking_id', type: 'uuid' }) bookingId!: string;
  @Column({ name: 'approver_id', type: 'uuid', nullable: true }) approverId?: string;
  @Column({ length: 16 }) decision!: ApprovalDecision;
  @Column({ default: '' }) reason!: string;
  @CreateDateColumn({ name: 'decided_at' }) decidedAt!: Date;
}
