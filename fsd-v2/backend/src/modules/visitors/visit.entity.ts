import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn,
} from 'typeorm';

// Mirrors v1 domain/visitor. Pre-registered guest visit, optionally
// anchored to a booking. Lifecycle:
//   Expected -> Checked In -> Checked Out
//   (any of those) -> Cancelled / No Show
export type VisitStatus = 'Expected' | 'Checked In' | 'Checked Out' | 'No Show' | 'Cancelled';

@Entity('visits')
@Index(['tenantId', 'expectedAt'])
@Index(['tenantId', 'status'])
export class Visit {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column({ name: 'booking_id', type: 'uuid', nullable: true }) bookingId?: string;
  @Column({ name: 'host_user_id', type: 'uuid' }) hostUserId!: string;
  @Column({ name: 'visitor_name' }) visitorName!: string;
  @Column({ name: 'visitor_email', default: '' }) visitorEmail!: string;
  @Column({ name: 'visitor_phone', default: '' }) visitorPhone!: string;
  @Column({ name: 'visitor_company', default: '' }) visitorCompany!: string;
  @Column({ default: '' }) purpose!: string;
  @Column({ name: 'expected_at', type: 'timestamptz' }) expectedAt!: Date;
  @Column({ name: 'expected_until', type: 'timestamptz', nullable: true }) expectedUntil?: Date;
  @Column({ default: 'Expected' }) status!: VisitStatus;
  @Column({ name: 'checked_in_at', type: 'timestamptz', nullable: true }) checkedInAt?: Date;
  @Column({ name: 'checked_out_at', type: 'timestamptz', nullable: true }) checkedOutAt?: Date;
  @Column({ name: 'nda_accepted', default: false }) ndaAccepted!: boolean;
  @Column({ default: '' }) notes!: string;
  @Column({ name: 'created_by', type: 'uuid', nullable: true }) createdBy?: string;
  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt!: Date;
}
