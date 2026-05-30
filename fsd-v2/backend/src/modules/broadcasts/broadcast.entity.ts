import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn,
} from 'typeorm';

// R13 broadcast banner — urgent, department-wide announcements
// (e.g. a Typhoon No.8 facility-closure alert). One row per posted
// message; the SPA polls /api/v1/broadcasts to get the active ones.
//
// `filters` is JSONB so admins can scope a broadcast to a location,
// a set of rooms, or future audience attributes without a migration.
@Entity('broadcasts')
@Index(['tenantId', 'startsAt'])
export class Broadcast {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;

  @Column() title!: string;
  @Column({ type: 'text' }) content!: string;

  // 'urgent' | 'warning' | 'info' — drives the banner colour fallback.
  @Column({ default: 'info' }) severity!: string;

  // Optional admin-chosen colour. Empty string means "use severity default".
  @Column({ default: '' }) color!: string;

  @Column({ name: 'image_url', default: '' }) imageUrl!: string;

  @Column({ name: 'starts_at', type: 'timestamptz' }) startsAt!: Date;
  @Column({ name: 'ends_at', type: 'timestamptz' }) endsAt!: Date;

  // JSONB: { location?, resources?, severity?, color? }
  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` }) filters!: Record<string, any>;

  @Column({ name: 'created_by', type: 'uuid', nullable: true }) createdBy?: string;

  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt!: Date;
}
