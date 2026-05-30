import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn,
} from 'typeorm';

// Recurrence pattern values mirror v1's booking.PatternDaily / Weekly /
// BiWeekly / Monthly. 'custom' covers an arbitrary RFC 5545 RRULE that
// the recurrence service expands directly.
export type RecurrencePattern = 'daily' | 'weekly' | 'bi-weekly' | 'monthly' | 'custom';
export type RecurrenceStatus = 'Active' | 'Cancelled' | 'Completed';

@Entity('recurrences')
@Index(['tenantId'])
export class Recurrence {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column({ name: 'created_by', type: 'uuid' }) createdBy!: string;
  @Column({ name: 'resource_id', type: 'uuid' }) resourceId!: string;

  @Column({ type: 'varchar', length: 16 }) pattern!: RecurrencePattern;
  @Column({ type: 'int', default: 1 }) interval!: number;
  @Column({ type: 'int', nullable: true }) count?: number;
  @Column({ type: 'timestamptz', nullable: true }) until?: Date;

  // Weekly: array of weekday ints, 0=Sun..6=Sat. Monthly: array of
  // month-day ints 1..31. Stored as int[] for both — interpretation
  // depends on `pattern`.
  @Column({ type: 'int', array: true, default: () => "'{}'" }) byday!: number[];
  @Column({ type: 'int', array: true, default: () => "'{}'" }) bymonth!: number[];

  // Optional raw RFC 5545 string. When set, expansion uses this and
  // ignores pattern/interval/byday/bymonth.
  @Column({ type: 'text', default: '' }) rrule!: string;

  @Column({ type: 'varchar', length: 16, default: 'Active' }) status!: RecurrenceStatus;

  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
}
