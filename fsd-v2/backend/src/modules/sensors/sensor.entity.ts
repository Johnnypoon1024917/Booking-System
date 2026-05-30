import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn,
} from 'typeorm';

// Per-device IoT registration. The plaintext secret is never stored —
// only a SHA-256 hash. The device is shown its secret once at enrol time
// and then must store it locally (matches v1 sensor enrolment behavior).
@Entity('sensors')
@Index(['tenantId', 'deviceId'], { unique: true })
export class Sensor {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column({ name: 'device_id' }) deviceId!: string;
  @Column({ name: 'resource_id', type: 'uuid', nullable: true }) resourceId?: string;
  @Column({ default: '' }) label!: string;
  @Column({ name: 'secret_hash', default: '' }) secretHash!: string;
  @Column({ name: 'last_seen_at', type: 'timestamptz', nullable: true }) lastSeenAt?: Date;
  @Column({ name: 'is_active', default: true }) isActive!: boolean;
  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt!: Date;
}

// One row per observed reading. Occupancy is the canonical scalar field
// (0/1 for presence, %-full for headcount). The extra JSONB holds CO2,
// lux, temperature etc without per-metric columns.
@Entity('sensor_readings')
@Index(['tenantId', 'resourceId', 'observedAt'])
export class SensorReading {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column({ name: 'sensor_id', type: 'uuid' }) sensorId!: string;
  @Column({ name: 'device_id' }) deviceId!: string;
  @Column({ name: 'resource_id', type: 'uuid', nullable: true }) resourceId?: string;
  // 0..1 fractional occupancy, or 0/1 presence — whatever the device emits.
  @Column({ type: 'float', default: 0 }) occupancy!: number;
  @Column({ type: 'jsonb', nullable: true }) extra?: Record<string, unknown>;
  @Column({ name: 'observed_at', type: 'timestamptz' }) observedAt!: Date;
  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
}
