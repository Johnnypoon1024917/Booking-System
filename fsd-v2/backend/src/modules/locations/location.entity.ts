import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn,
} from 'typeorm';

// Mirrors v1 domain/location/location.go. First-class admin-managed
// location (tower, floor, station). The address JSONB is a freeform
// blob the SPA owns — street/city/postal/etc — kept loose so we can
// extend without migrations.
@Entity('locations')
@Index(['tenantId', 'name'])
export class Location {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column() name!: string;
  @Column({ nullable: true }) region?: string;
  @Column({ type: 'jsonb', nullable: true, default: () => "'{}'" }) address?: Record<string, unknown>;
  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt!: Date;
}
