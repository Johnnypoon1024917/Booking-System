import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn,
} from 'typeorm';

// OutlookSyncRecord maps a v2 booking to its Graph event id so updates
// PATCH instead of POSTing duplicates. iCalUId is stored for cross-tenant
// reconciliation.
@Entity('outlook_sync_records')
@Index(['bookingId'], { unique: true })
export class OutlookSyncRecord {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'booking_id', type: 'uuid' }) bookingId!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column({ name: 'mailbox_upn', type: 'varchar', length: 255 }) mailboxUPN!: string;
  @Column({ name: 'graph_id', type: 'varchar', length: 256 }) graphId!: string;
  @Column({ name: 'ical_uid', type: 'varchar', length: 256, default: '' }) iCalUID!: string;
  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt!: Date;
}
