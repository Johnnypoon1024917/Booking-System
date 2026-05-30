import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn,
} from 'typeorm';

// One row per (tenant, holiday date). `scope` distinguishes manually
// added holidays from those imported by the gov.hk sync — useful for
// "Re-sync without trashing my custom entries" later.
@Entity('holidays')
@Index(['tenantId', 'holidayDate'], { unique: true })
export class Holiday {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column({ name: 'holiday_date', type: 'date' }) holidayDate!: string;
  @Column({ default: '' }) name!: string;
  // 'manual' | 'govhk' | 'imported-ics'
  @Column({ default: 'manual' }) scope!: string;
  // Whether the day blocks new bookings.
  @Column({ name: 'is_blocker', default: true }) isBlocker!: boolean;
  @Column({ name: 'created_by', type: 'uuid', nullable: true }) createdBy?: string;
  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
}
