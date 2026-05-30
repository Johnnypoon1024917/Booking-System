import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn,
} from 'typeorm';

// Mirrors v1 domain/locationgroup. "Room Privilege Setup by Org
// Hierarchy": named group granting users (resolved by filterBy) access
// to a set of locations with optional approver routing. JSONB blobs are
// owned by the SPA — kept loose on purpose to dodge migrations.
@Entity('location_groups')
@Index(['tenantId', 'name'])
export class LocationGroup {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column() name!: string;
  // Whitelist | Channel | Department
  @Column({ name: 'filter_by', default: 'Whitelist' }) filterBy!: string;
  @Column({ type: 'jsonb', default: () => "'[]'" }) approvers!: unknown[];
  @Column({ type: 'jsonb', default: () => "'[]'" }) locations!: unknown[];
  @Column({ name: 'member_ids', type: 'jsonb', default: () => "'[]'" }) memberIds!: unknown[];
  @Column({ default: 'Active' }) status!: string;
  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt!: Date;
}
