import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomBytes, createHash } from 'crypto';
import { Sensor, SensorReading } from './sensor.entity';

@Injectable()
export class SensorsService {
  constructor(
    @InjectRepository(Sensor) private readonly sensors: Repository<Sensor>,
    @InjectRepository(SensorReading) private readonly readings: Repository<SensorReading>,
  ) {}

  list(tenantId: string) {
    return this.sensors.find({ where: { tenantId }, order: { deviceId: 'ASC' } });
  }
  async get(tenantId: string, id: string) {
    const r = await this.sensors.findOne({ where: { id, tenantId } });
    if (!r) throw new NotFoundException('sensor not found');
    return r;
  }

  // Enrol creates the device and returns the plaintext secret EXACTLY
  // once. Server only persists the hash — the SPA is expected to copy
  // the secret immediately and provision the device with it.
  async enrol(tenantId: string, dto: { deviceId: string; resourceId?: string; label?: string }) {
    const secret = randomBytes(24).toString('base64url');
    const secretHash = createHash('sha256').update(secret).digest('hex');
    const saved = await this.sensors.save(this.sensors.create({
      tenantId, deviceId: dto.deviceId, resourceId: dto.resourceId,
      label: dto.label ?? '', secretHash,
    }));
    return { sensor: saved, secret };
  }

  async update(tenantId: string, id: string, dto: Partial<Sensor>) {
    const r = await this.get(tenantId, id);
    // secretHash is never updated through the admin endpoint.
    const { secretHash: _ignored, ...rest } = dto as any;
    Object.assign(r, rest, { id: r.id, tenantId: r.tenantId });
    return this.sensors.save(r);
  }

  async remove(tenantId: string, id: string) {
    const r = await this.sensors.delete({ id, tenantId });
    if (!r.affected) throw new NotFoundException('sensor not found');
  }

  // Ingestion path. Looks up the device by deviceId, verifies the shared
  // secret (constant-time compare), then writes one reading and bumps
  // last_seen_at. No JWT involved — see the controller's @Public guard.
  async ingest(input: {
    deviceId: string; secret: string;
    occupancy: number; observedAt?: Date; extra?: Record<string, unknown>;
  }) {
    const sensor = await this.sensors.findOne({ where: { deviceId: input.deviceId } });
    if (!sensor || !sensor.isActive) throw new UnauthorizedException('unknown device');
    const expected = createHash('sha256').update(input.secret).digest('hex');
    if (sensor.secretHash !== expected) throw new UnauthorizedException('bad secret');

    const observedAt = input.observedAt ?? new Date();
    const reading = await this.readings.save(this.readings.create({
      tenantId: sensor.tenantId, sensorId: sensor.id, deviceId: sensor.deviceId,
      resourceId: sensor.resourceId, occupancy: input.occupancy,
      extra: input.extra, observedAt,
    }));
    await this.sensors.update({ id: sensor.id }, { lastSeenAt: observedAt });
    return { ok: true, id: reading.id };
  }

  // Recent occupancy summary for a resource (what AdminSensors page calls).
  async recent(tenantId: string, resourceId: string, limit = 50) {
    return this.readings.find({
      where: { tenantId, resourceId },
      order: { observedAt: 'DESC' },
      take: limit,
    });
  }
}
