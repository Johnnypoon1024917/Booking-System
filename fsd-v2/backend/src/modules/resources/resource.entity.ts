import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn,
} from 'typeorm';

// Mirrors the v1 `resources` table — enough fields to drive search,
// the Day grid, and the booking modal. Composite/split (parent/child)
// is included because the Day-grid cross-locking depends on it.
@Entity('resources')
@Index(['tenantId', 'name'])
export class Resource {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column() name!: string;
  @Column({ nullable: true }) location?: string;
  @Column({ nullable: true }) region?: string;
  @Column({ name: 'asset_type', default: 'Meeting Room' }) assetType!: string;
  @Column({ default: 0 }) capacity!: number;
  @Column({ name: 'is_active', default: true }) isActive!: boolean;
  @Column({ name: 'is_restricted', default: false }) isRestricted!: boolean;
  @Column({ name: 'requires_approval', default: false }) requiresApproval!: boolean;

  @Column({ name: 'parent_resource_id', type: 'uuid', nullable: true })
  parentResourceId?: string;
  // 'standalone' | 'parent' | 'child' — drives the cross-locking rules
  // for split spaces.
  @Column({ name: 'composite_mode', default: 'standalone' })
  compositeMode!: string;

  @Column({ name: 'department_id', type: 'uuid', nullable: true })
  departmentId?: string;

  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt!: Date;
}
