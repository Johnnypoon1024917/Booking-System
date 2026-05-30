import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn,
} from 'typeorm';

// Charge-back invoice. One row per (tenant, department, period). Lines
// are a JSONB array of { bookingId, description, qty, unitCents, lineCents }.
// totalCents is materialised for cheap list pages.
export type InvoiceStatus = 'Draft' | 'Issued' | 'Paid' | 'Cancelled';

@Entity('invoices')
// Composite index covers both the (tenant, period) list query and the
// (tenant, dept, period) rollup-replace query — dept is the trailing
// column so prefix scans still hit it.
@Index(['tenantId', 'departmentId', 'period'])
export class Invoice {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column({ name: 'department_id', type: 'uuid', nullable: true }) departmentId?: string;
  // Period is the rollup window, stored as YYYY-MM for monthly invoices.
  @Column() period!: string;
  @Column({ type: 'jsonb', default: () => "'[]'" }) lines!: unknown[];
  @Column({ name: 'subtotal_cents', type: 'int', default: 0 }) subtotalCents!: number;
  @Column({ name: 'tax_cents', type: 'int', default: 0 }) taxCents!: number;
  @Column({ name: 'total_cents', type: 'int', default: 0 }) totalCents!: number;
  @Column({ default: 'Draft' }) status!: InvoiceStatus;
  @Column({ name: 'issued_at', type: 'timestamptz', nullable: true }) issuedAt?: Date;
  @Column({ name: 'paid_at', type: 'timestamptz', nullable: true }) paidAt?: Date;
  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt!: Date;
}
