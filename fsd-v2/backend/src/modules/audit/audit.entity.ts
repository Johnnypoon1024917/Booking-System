import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('audit_log')
@Index(['tenantId', 'createdAt'])
@Index(['tenantId', 'action'])
export class AuditEntry {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column({ name: 'user_id', type: 'uuid', nullable: true }) userId?: string;
  @Column() username!: string;
  @Column({ length: 64 }) action!: string;
  @Column({ length: 16, default: 'info' }) severity!: string;
  @Column({ length: 16, default: 'success' }) outcome!: string;
  @Column({ name: 'target_entity', length: 64, nullable: true }) targetEntity?: string;
  @Column({ name: 'target_id', length: 128, nullable: true }) targetId?: string;
  @Column({ type: 'jsonb', nullable: true }) previous?: Record<string, any>;
  @Column({ type: 'jsonb', nullable: true }) next?: Record<string, any>;
  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
}
