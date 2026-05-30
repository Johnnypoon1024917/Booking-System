import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn,
} from 'typeorm';

// Mirrors v1 domain/resourcetype. Admin-extensible asset-type catalog
// (Gym, Studio, Drone, Parking...). Built-ins remain present in code
// as a floor; this table supplements them per-tenant.
@Entity('resource_types')
@Index(['tenantId', 'key'], { unique: true })
export class ResourceType {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column() key!: string;
  @Column() label!: string;
  @Column({ default: 'box' }) icon!: string;
  @Column({ default: '#3b82f6' }) color!: string;
  @Column({ name: 'default_capacity', default: 0 }) defaultCapacity!: number;
  // "exclusive" | "shared"
  @Column({ name: 'default_booking_mode', default: 'exclusive' }) defaultBookingMode!: string;
  @Column({ name: 'default_requires_approval', default: false }) defaultRequiresApproval!: boolean;
  @Column({ name: 'display_order', default: 0 }) displayOrder!: number;
  @Column({ name: 'is_builtin', default: false }) isBuiltin!: boolean;
  @Column({ name: 'is_active', default: true }) isActive!: boolean;
  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt!: Date;
}
