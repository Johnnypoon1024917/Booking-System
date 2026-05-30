import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn,
} from 'typeorm';

// Per-tenant email template. Mirrors v1's notification_template table
// (domain/notification): one row per (tenant, type). Subject and body
// support {{variable}} substitution — see NotificationsService.render for
// the available fields. Body is HTML; a plain-text part is derived from it.
export type NotificationTemplateType = 'confirmation' | 'cancellation' | 'reminder';

export const NOTIFICATION_TEMPLATE_TYPES: NotificationTemplateType[] = [
  'confirmation', 'cancellation', 'reminder',
];

@Entity('notification_templates')
@Index(['tenantId', 'templateType'], { unique: true })
export class NotificationTemplate {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column({ name: 'template_type', type: 'varchar', length: 32 })
  templateType!: NotificationTemplateType;
  @Column() subject!: string;
  @Column({ name: 'body_template', type: 'text' }) bodyTemplate!: string;

  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt!: Date;
}
