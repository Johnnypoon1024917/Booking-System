import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn,
} from 'typeorm';

// One row per (tenant, holiday date, region). `scope` distinguishes
// manually added holidays from those imported by the gov.hk sync — useful
// for "Re-sync without trashing my custom entries" later. `region` scopes
// the closure: '' (the default) blocks the whole tenant, while a specific
// region only blocks resources in that region. The unique index includes
// region so the same date can carry both a tenant-wide row and one or more
// region-specific rows (e.g. a Singapore-only closure).
@Entity('holidays')
@Index(['tenantId', 'holidayDate', 'region'], { unique: true })
export class Holiday {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column({ name: 'holiday_date', type: 'date' }) holidayDate!: string;
  @Column({ default: '' }) name!: string;
  // 'manual' | 'govhk' | 'imported-ics'
  @Column({ default: 'manual' }) scope!: string;
  // Region this closure applies to. '' = tenant-wide (blocks every resource);
  // otherwise must match Resource.region for a booking to be blocked.
  @Column({ default: '' }) region!: string;
  // Whether the day blocks new bookings.
  @Column({ name: 'is_blocker', default: true }) isBlocker!: boolean;
  @Column({ name: 'created_by', type: 'uuid', nullable: true }) createdBy?: string;
  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
}
