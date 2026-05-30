import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique,
} from 'typeorm';

// W3C Push API subscription. UNIQUE(user_id, endpoint) so re-subscribing
// the same browser updates the existing row instead of accumulating
// duplicates each time the SP rotates the endpoint.
@Entity('push_subscriptions')
@Unique(['userId', 'endpoint'])
@Index(['tenantId'])
export class PushSubscription {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column({ name: 'user_id', type: 'uuid' }) userId!: string;
  // Push endpoints can be long (>500 chars) — use TEXT so PG never truncates.
  @Column({ type: 'text' }) endpoint!: string;
  @Column() p256dh!: string;
  @Column() auth!: string;
  @Column({ name: 'user_agent', default: '' }) userAgent!: string;
  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
  @Column({ name: 'last_used_at', type: 'timestamptz', nullable: true })
  lastUsedAt?: Date | null;
}
