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

  // Per-resource overrides of the tenant-wide workflow rules. Any key left
  // absent (or null) falls back to the tenant customization default, so an
  // empty/missing object means "inherit everything". Persisted as jsonb so
  // the override set can grow without a migration. See BookingValidatorService
  // (duration/horizon) and BookingsService (approval) for the merge, and
  // AutoReleaseService for graceMinutes.
  @Column({ name: 'rule_overrides', type: 'jsonb', nullable: true })
  ruleOverrides?: {
    minDurationMinutes?: number;
    maxDurationMinutes?: number;
    bookingHorizonDays?: number;
    graceMinutes?: number;
    requiresApproval?: boolean;
  } | null;

  // Default chargeback / cost-center code billed for bookings of this
  // resource. A booking may override it at create time; null = no default
  // (the booker must pick one when the tenant has configured codes).
  @Column({ name: 'cost_center_code', type: 'varchar', nullable: true })
  costCenterCode?: string | null;

  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt!: Date;
}
