import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn,
} from 'typeorm';

// Webhook is an admin-registered HTTP target. Events is a JSONB array of
// event names the target wants to receive (e.g. "booking.created"). The
// secret is generated server-side and returned ONCE on POST — the
// dispatcher uses it to HMAC-sign every body.
@Entity('webhook_subscriptions')
@Index(['tenantId'])
export class Webhook {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column({ name: 'target_url', type: 'varchar', length: 512 }) targetURL!: string;
  // Stored plaintext — these are HMAC-SHA256 keys, not access tokens.
  // Treated as sensitive by the API (never echoed) but no envelope.
  @Column({ type: 'varchar', length: 128 }) secret!: string;
  @Column({ type: 'jsonb', default: () => `'[]'::jsonb` }) events!: string[];
  @Column({ name: 'is_active', default: true }) isActive!: boolean;
  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt!: Date;
}

// WebhookDelivery is the outbox row written by domain events. The
// EVERY_MINUTE cron drains it. Status field semantics:
//   - pending: waiting for next attempt
//   - sent:    delivered, terminal
//   - failed:  exhausted retries, terminal
@Entity('webhook_deliveries')
@Index(['tenantId', 'createdAt'])
@Index(['status', 'nextAttemptAt'])
export class WebhookDelivery {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column({ name: 'subscription_id', type: 'uuid' }) subscriptionId!: string;
  @Column({ type: 'varchar', length: 64 }) event!: string;
  @Column({ type: 'jsonb' }) payload!: Record<string, any>;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: 'pending' | 'sent' | 'failed';
  @Column({ name: 'attempt_count', type: 'int', default: 0 })
  attemptCount!: number;
  @Column({ name: 'last_status', type: 'int', nullable: true })
  lastStatus?: number | null;
  @Column({ name: 'last_error', type: 'text', default: '' })
  lastError!: string;

  // Exponential backoff schedule lives here so the cron can use a single
  // indexed lookup rather than computing eligibility per row.
  @Column({ name: 'next_attempt_at', type: 'timestamptz' })
  nextAttemptAt!: Date;
  @Column({ name: 'delivered_at', type: 'timestamptz', nullable: true })
  deliveredAt?: Date | null;

  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt!: Date;
}
