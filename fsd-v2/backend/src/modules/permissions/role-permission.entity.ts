import {
  Column, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn,
} from 'typeorm';

// One row per (tenant, role). Permissions are an inline text[] —
// rebalancing the matrix happens atomically per role and we never
// query by individual permission, so a join table would be overkill.
@Entity('role_permissions')
@Index(['tenantId', 'role'], { unique: true })
export class RolePermission {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column({ length: 64 }) role!: string;
  @Column({ type: 'text', array: true, default: () => "'{}'" }) permissions!: string[];
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt!: Date;
}
