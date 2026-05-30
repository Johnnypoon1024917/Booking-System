import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Tenant } from '../modules/tenants/tenant.entity';
import { User } from '../modules/users/user.entity';
import { Booking } from '../modules/bookings/booking.entity';

// Seeds a default tenant + admin user the very first time the
// process starts so the SPA login screen has something to authenticate
// against. Skip if ALLOW_DEV_LOGIN is not 'true' in production.
//
// Also hosts the recurring "stale pending booking" cleanup as an
// example of the batch / scheduler job the client requested. Add more
// @Cron(...) methods here for additional jobs (no-show finaliser,
// holiday sync, etc.) when those features are ported from v1.
@Injectable()
export class SeederService implements OnApplicationBootstrap {
  private readonly log = new Logger(SeederService.name);

  constructor(
    @InjectRepository(Tenant) private readonly tenants: Repository<Tenant>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Booking) private readonly bookings: Repository<Booking>,
  ) {}

  async onApplicationBootstrap() {
    if (process.env.ALLOW_DEV_LOGIN !== 'true') return;

    // Seeding must never crash the API on boot. A failure here (e.g. a
    // duplicate-key race when two workers start against a fresh volume, or a
    // transient DB hiccup) used to propagate out of the bootstrap hook and
    // abort process start — leaving the whole app down and every login 500ing.
    // We now swallow seed errors with a warning; the app boots either way.
    try {
      await this.seedDefaults();
    } catch (e: any) {
      this.log.warn(`default seed skipped: ${e?.message || e}`);
    }
  }

  private async seedDefaults() {
    // Resolve-or-create the default tenant, tolerating a concurrent creator:
    // if the insert loses a unique-constraint race we just re-read the winner.
    let tenant = await this.tenants.findOne({ where: { slug: 'default' } });
    if (!tenant) {
      try {
        tenant = await this.tenants.save(this.tenants.create({
          slug: 'default', name: 'FSD MRBS (Default)', isActive: true,
        }));
        this.log.log(`seeded default tenant ${tenant.id}`);
      } catch (e: any) {
        // 23505 = unique_violation: another starter created it first.
        if (e?.code !== '23505') throw e;
        tenant = await this.tenants.findOne({ where: { slug: 'default' } });
      }
    }
    if (!tenant) return; // could not resolve — leave for a later boot

    const admin = await this.users.findOne({ where: { tenantId: tenant.id, username: 'admin' } });
    if (!admin) {
      try {
        await this.users.save(this.users.create({
          tenantId: tenant.id,
          username: 'admin',
          email: 'admin@fsd-mrbs.local',
          passwordHash: await bcrypt.hash('admin', 10),
          role: 'System Admin',
          isActive: true,
          regionAccess: ['Hong Kong'],
        }));
        this.log.warn(`seeded admin / admin — CHANGE THE PASSWORD before production use`);
      } catch (e: any) {
        if (e?.code !== '23505') throw e; // tolerate concurrent admin creation
      }
    }
  }

  // Hourly housekeeping: any 'Pending Approval' booking older than 7
  // days with no decision is auto-cancelled. Mirrors a similar job
  // from v1's cmd/scheduler/main.go but expressed declaratively here.
  @Cron(CronExpression.EVERY_HOUR)
  async expireStalePending() {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const result = await this.bookings
      .createQueryBuilder()
      .update(Booking)
      .set({ status: 'Cancelled', exceptionNotes: 'auto-cancelled: pending > 7 days' })
      .where(`status = 'Pending Approval' AND created_at < :cutoff`, { cutoff })
      .execute();
    if (result.affected) {
      this.log.log(`scheduler: auto-cancelled ${result.affected} stale pending bookings`);
    }
  }
}
