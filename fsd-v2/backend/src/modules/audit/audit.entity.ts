import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('audit_log')
@Index(['tenantId', 'createdAt'])
@Index(['tenantId', 'action'])
@Index(['tenantId', 'userId'])
@Index(['tenantId', 'outcome'])
export class AuditEntry {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid', nullable: true }) tenantId?: string;
  @Column({ name: 'user_id', type: 'uuid', nullable: true }) userId?: string;
  @Column() username!: string;
  // Semantic action name (BOOKING_CREATED) for instrumented handlers, or a
  // generic "POST /api/v1/resources" verb+path for the auto-captured net.
  // 128 chars accommodates the latter.
  @Column({ length: 128 }) action!: string;
  @Column({ length: 16, default: 'info' }) severity!: string;
  @Column({ length: 16, default: 'success' }) outcome!: string;
  @Column({ name: 'target_entity', length: 64, nullable: true }) targetEntity?: string;
  @Column({ name: 'target_id', length: 128, nullable: true }) targetId?: string;
  // Request envelope — the "where / how" of the action, captured for every
  // entry by the global AuditInterceptor so admins can trace behaviour back to
  // a device/IP, not just a user id.
  @Column({ length: 8, nullable: true }) method?: string;
  @Column({ length: 512, nullable: true }) path?: string;
  @Column({ name: 'status_code', type: 'int', nullable: true }) statusCode?: number;
  @Column({ length: 64, nullable: true }) ip?: string;
  @Column({ name: 'user_agent', length: 512, nullable: true }) userAgent?: string;
  @Column({ type: 'jsonb', nullable: true }) previous?: Record<string, any>;
  @Column({ type: 'jsonb', nullable: true }) next?: Record<string, any>;
  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
}
