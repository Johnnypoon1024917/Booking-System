import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn,
} from 'typeorm';

// Durable calendar-sync outbox. Previously calendar push (Outlook/Google) was
// fire-and-forget from the booking write path: if Graph/Google was down for a
// few seconds during a create, the event was lost forever — no retry, no
// dead-letter, no reconciliation. A row is now written when a booking changes
// and an EVERY_MINUTE cron drains it with exponential backoff, mirroring the
// notification + webhook outboxes. The booking transaction still never blocks
// on the remote calendar (enqueue is a single local insert).
export type SyncOutboxStatus = 'pending' | 'sent' | 'failed';

@Entity('calendar_sync_outbox')
@Index(['status', 'nextAttemptAt'])
export class SyncOutbox {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column({ name: 'booking_id', type: 'uuid' }) bookingId!: string;

  // Domain event name: BOOKING_CREATED / BOOKING_UPDATED / BOOKING_CANCELLED.
  // Passed straight through to the per-provider sync adapters.
  @Column() event!: string;

  @Column({ type: 'varchar', length: 16, default: 'pending' }) status!: SyncOutboxStatus;
  @Column({ name: 'attempt_count', default: 0 }) attemptCount!: number;
  @Column({ name: 'next_attempt_at', type: 'timestamptz' }) nextAttemptAt!: Date;
  @Column({ name: 'sent_at', type: 'timestamptz', nullable: true }) sentAt?: Date;
  @Column({ name: 'last_error', type: 'text', nullable: true }) lastError?: string;

  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt!: Date;
}
