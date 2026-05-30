import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn,
} from 'typeorm';

// GoogleSyncRecord maps a booking to its remote Google Calendar event id
// so future updates PATCH instead of POSTing duplicates. calendarId is
// either the host user's "primary" calendar or a tenant-configured
// shared calendar.
@Entity('google_sync_records')
@Index(['bookingId'], { unique: true })
export class GoogleSyncRecord {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'booking_id', type: 'uuid' }) bookingId!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column({ name: 'calendar_id', type: 'varchar', length: 255 }) calendarId!: string;
  @Column({ name: 'event_id', type: 'varchar', length: 256 }) eventId!: string;
  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt!: Date;
}
