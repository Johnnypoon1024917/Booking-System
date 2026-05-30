import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn,
} from 'typeorm';

// Add-on services bookable alongside a room (catering, AV setup,
// equipment hire). Mirrors v1 domain/booking/service.go. Price is in
// cents to dodge float drift; the SPA formats per locale.
@Entity('services')
@Index(['tenantId', 'name'])
export class Service {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column({ name: 'category_id', type: 'uuid', nullable: true }) categoryId?: string;
  @Column() name!: string;
  @Column({ default: '' }) description!: string;
  // Stored as integer cents to avoid float drift.
  @Column({ name: 'price_cents', type: 'int', default: 0 }) priceCents!: number;
  @Column({ name: 'is_active', default: true }) isActive!: boolean;
  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt!: Date;
}

// Many-to-many between bookings and services. Quantity + frozen price
// so a service price change later doesn't restate historical invoices.
@Entity('booking_services')
@Index(['bookingId'])
export class BookingService {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column({ name: 'booking_id', type: 'uuid' }) bookingId!: string;
  @Column({ name: 'service_id', type: 'uuid' }) serviceId!: string;
  @Column({ type: 'int', default: 1 }) quantity!: number;
  @Column({ name: 'unit_price_cents', type: 'int', default: 0 }) unitPriceCents!: number;
  @Column({ default: '' }) note!: string;
  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
}
