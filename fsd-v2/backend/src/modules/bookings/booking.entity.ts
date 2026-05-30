import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn,
} from 'typeorm';

// Status names match v1's StatusConfirmed / StatusPendingApproval /
// StatusCancelled / StatusCheckedIn / StatusNoShow / StatusException
// so cross-stack payloads round-trip cleanly during the cut-over.
export type BookingStatus =
  | 'Confirmed' | 'Pending Approval' | 'Cancelled'
  | 'Checked In' | 'No Show' | 'Attended' | 'Exception';

@Entity('bookings')
@Index(['tenantId', 'startTime'])
@Index(['resourceId', 'startTime'])
export class Booking {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column({ name: 'resource_id', type: 'uuid' }) resourceId!: string;
  @Column({ name: 'user_id', type: 'uuid' }) userId!: string;
  @Column({ name: 'start_time', type: 'timestamptz' }) startTime!: Date;
  @Column({ name: 'end_time', type: 'timestamptz' }) endTime!: Date;
  @Column({ type: 'varchar', length: 32, default: 'Confirmed' }) status!: BookingStatus;

  @Column({ default: '' }) title!: string;
  @Column({ name: 'meeting_url', default: '' }) meetingUrl!: string;
  @Column({ name: 'redirect_url', default: '' }) redirectUrl!: string;
  @Column({ name: 'exception_notes', default: '' }) exceptionNotes!: string;
  @Column({ name: 'booking_mode', default: 'exclusive' }) bookingMode!: string;

  // Answers to the resource's custom booking-form questions, keyed by the
  // custom field `key`. jsonb so the shape follows whatever the resource
  // defines without a migration. Empty/absent when the resource has none.
  @Column({ name: 'custom_field_values', type: 'jsonb', nullable: true })
  customFieldValues?: Record<string, unknown> | null;

  @Column({ name: 'is_private', default: false }) isPrivate!: boolean;
  @Column({ name: 'is_recurring', default: false }) isRecurring!: boolean;
  @Column({ name: 'recurrence_id', type: 'uuid', nullable: true }) recurrenceId?: string;

  @Column({ name: 'checked_in_at', type: 'timestamptz', nullable: true })
  checkedInAt?: Date;
  @Column({ name: 'checkin_token', type: 'varchar', length: 64, nullable: true })
  checkinToken?: string;
  @Column({ name: 'checkin_token_expires_at', type: 'timestamptz', nullable: true })
  checkinTokenExpiresAt?: Date;
  @Column({ default: 0 }) version!: number;

  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt!: Date;
}
