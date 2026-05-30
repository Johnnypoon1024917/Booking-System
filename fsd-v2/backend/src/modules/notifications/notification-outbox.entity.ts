import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn,
} from 'typeorm';

// Email notification outbox. A row is written synchronously inside the
// booking write path (NotificationsService.enqueue); the EVERY_MINUTE cron
// drains pending rows, renders the template + ICS, and sends via SMTP. This
// mirrors the webhooks outbox so a slow/unreachable mail relay never blocks
// the primary booking transaction and failures retry with backoff.
// 'processing' is a transient claim marker: the drain atomically flips
// 'pending' → 'processing' under a row lock so a concurrent/overrunning cron
// tick can't grab the same row twice (FOR UPDATE SKIP LOCKED). deliverOne
// always moves it on to 'sent', 'failed', or back to 'pending' (retry).
export type OutboxStatus = 'pending' | 'processing' | 'sent' | 'failed';

@Entity('notification_outbox')
@Index(['status', 'nextAttemptAt'])
export class NotificationOutbox {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column({ name: 'booking_id', type: 'uuid', nullable: true }) bookingId?: string;

  // Domain event name, e.g. BOOKING_CREATED / BOOKING_CANCELLED. Drives
  // which template type and ICS method are used.
  @Column() event!: string;
  // Resolved recipient at enqueue time so the drain doesn't have to re-derive
  // it (and so we have an audit trail of where mail was sent).
  @Column({ name: 'recipient_email' }) recipientEmail!: string;
  // Frozen template variables captured at enqueue time. Avoids a second set
  // of joins in the cron and keeps the email accurate to the moment of the
  // event even if the booking is later mutated.
  @Column({ type: 'jsonb' }) vars!: Record<string, any>;

  @Column({ type: 'varchar', length: 16, default: 'pending' }) status!: OutboxStatus;
  @Column({ name: 'attempt_count', default: 0 }) attemptCount!: number;
  @Column({ name: 'next_attempt_at', type: 'timestamptz' }) nextAttemptAt!: Date;
  @Column({ name: 'sent_at', type: 'timestamptz', nullable: true }) sentAt?: Date;
  @Column({ name: 'last_error', type: 'text', nullable: true }) lastError?: string;

  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt!: Date;
}
