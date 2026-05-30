import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn,
} from 'typeorm';

// GraphSubscription tracks a single Microsoft Graph change-notification
// subscription. One row per (tenant, mailbox). expiresAt is the absolute
// deadline Graph enforces — we renew when within 12h of it.
@Entity('graph_subscriptions')
@Index(['tenantId', 'mailboxUPN'], { unique: true })
@Index(['expiresAt'])
export class GraphSubscription {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column({ name: 'mailbox_upn', type: 'varchar', length: 255 }) mailboxUPN!: string;

  // The id Microsoft assigns. Used for RENEW + DELETE calls.
  @Column({ name: 'graph_subscription_id', type: 'varchar', length: 64 })
  graphSubscriptionID!: string;

  // Random per-subscription secret. Echoed back on every notification —
  // we constant-time-compare to fail spoofed payloads closed.
  @Column({ name: 'client_state', type: 'varchar', length: 128 })
  clientState!: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt!: Date;
}
