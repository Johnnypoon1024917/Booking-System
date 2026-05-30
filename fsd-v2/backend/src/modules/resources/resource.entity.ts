import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn,
} from 'typeorm';
import { OperatingHours } from '../../common/operating-hours';

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

  // Booking model: 'exclusive' (one booking per slot — the default) or
  // 'shared' (pods — up to sharedCapacity independent bookings may overlap).
  @Column({ name: 'booking_mode', default: 'exclusive' })
  bookingMode!: string;
  @Column({ name: 'shared_capacity', type: 'int', default: 1 })
  sharedCapacity!: number;

  // Local operating-hours schedule, enforced at booking time. null = open 24h.
  // Per-weekday windows in the tenant's timezone: { days: { "0".."6":
  // { open:'HH:mm', close:'HH:mm' } | null } } where 0=Sun..6=Sat and null =
  // closed that day. Legacy { open, close } rows are still read. See
  // common/operating-hours.ts.
  @Column({ name: 'operating_hours', type: 'jsonb', nullable: true })
  operatingHours?: OperatingHours | null;

  // Free-form equipment tags (e.g. ['Projector','Whiteboard']) and the
  // per-resource custom booking-form questions. Both surface in the booking
  // flow; persisted as jsonb so the shape can evolve without a migration.
  @Column({ name: 'equipment', type: 'jsonb', nullable: true })
  equipment?: string[] | null;
  @Column({ name: 'custom_fields', type: 'jsonb', nullable: true })
  customFields?: Array<{
    key: string; label?: string; type?: string;
    required?: boolean; options?: string[];
  }> | null;

  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt!: Date;
}
