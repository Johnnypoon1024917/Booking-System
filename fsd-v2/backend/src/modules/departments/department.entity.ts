import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('departments')
@Index(['tenantId', 'name'], { unique: true })
export class Department {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column() name!: string;
  @Column({ nullable: true }) code?: string;
  @Column({ name: 'parent_id', type: 'uuid', nullable: true }) parentId?: string;
  // Department head — drives dynamic approval routing (approver_type
  // 'department_head' routes to the head of the booked resource's department).
  // Nullable until an admin assigns one. Maintained via the department admin form.
  @Column({ name: 'head_user_id', type: 'uuid', nullable: true }) headUserId?: string;
  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt!: Date;
}
