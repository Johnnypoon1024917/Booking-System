import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { Tenant } from '../modules/tenants/tenant.entity';
import { User } from '../modules/users/user.entity';
import { Resource } from '../modules/resources/resource.entity';
import { ApprovalRule } from '../modules/approvals/approval-rule.entity';
import { Booking } from '../modules/bookings/booking.entity';

// Demo data seeder for manual UI testing in a "real" environment.
//
// Enabled only when SEED_DEMO=true. Idempotent: if the tenant already has a
// populated user table it logs and exits, so restarting the API doesn't keep
// re-seeding. Produces ~500 users, 130+ resources (mixed types, some
// requiring approval / restricted / composite split spaces), several
// approval-chain rules, and a few hundred bookings spread across statuses so
// every screen (dashboard, My Bookings, Approvals, Admin Bookings, Reports)
// has realistic data.
//
//   docker compose up           # ALLOW_DEV_LOGIN=true seeds admin/admin
//   SEED_DEMO=true docker compose up   # also runs this demo seed
//
// All demo accounts share DEMO_PASSWORD (default "password"). Named logins:
//   admin/admin (System Admin, from the base seeder), officer, roomadmin,
//   secretary, secadmin  — each with the demo password.
@Injectable()
export class DemoSeederService implements OnApplicationBootstrap {
  private readonly log = new Logger(DemoSeederService.name);

  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  async onApplicationBootstrap() {
    if (process.env.SEED_DEMO !== 'true') return;
    // Seeding must never crash the API on boot. This runs alongside the base
    // SeederService, and both can attempt to create the `default` tenant on a
    // fresh volume — the loser of that race previously threw a duplicate-key
    // error out of the bootstrap hook and aborted process start, leaving every
    // login 500ing. Swallow any seed failure with a warning; the app boots.
    try {
      await this.seedDemo();
    } catch (e: any) {
      this.log.warn(`demo seed skipped: ${e?.message || e}`);
    }
  }

  private async seedDemo() {
    const tenants = this.ds.getRepository(Tenant);
    const users = this.ds.getRepository(User);
    const resources = this.ds.getRepository(Resource);
    const rules = this.ds.getRepository(ApprovalRule);
    const bookings = this.ds.getRepository(Booking);

    // Resolve-or-create the default tenant, tolerating a concurrent creator:
    // if our insert loses the unique-constraint race, re-read the winner.
    let tenant = await tenants.findOne({ where: { slug: 'default' } });
    if (!tenant) {
      try {
        tenant = await tenants.save(tenants.create({ slug: 'default', name: 'FSD MRBS (Default)', isActive: true }));
      } catch (e: any) {
        if (e?.code !== '23505') throw e; // 23505 = unique_violation
        tenant = await tenants.findOne({ where: { slug: 'default' } });
      }
    }
    if (!tenant) return; // could not resolve — leave for a later boot
    const tenantId = tenant.id;

    const existing = await users.count({ where: { tenantId } });
    if (existing > 50) {
      this.log.log(`demo seed skipped — tenant already has ${existing} users`);
      return;
    }

    const t0 = Date.now();
    this.log.warn('SEED_DEMO=true — generating demo dataset, this runs once…');

    // Deterministic PRNG (mulberry32) with a FIXED seed so the dataset is
    // byte-for-byte identical on every machine and every reseed — the demo
    // must look the same "real data" everywhere, never random per boot.
    // (DB-generated UUIDs still differ, but every user/resource/rule's
    // attributes are reproducible.)
    let _s = 0x5eed5eed >>> 0;
    const rand = () => {
      _s |= 0; _s = (_s + 0x6d2b79f5) | 0;
      let t = Math.imul(_s ^ (_s >>> 15), 1 | _s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const REGIONS = ['Hong Kong', 'Kowloon', 'New Territories'];
    const LOCATIONS: Record<string, string[]> = {
      'Hong Kong': ['Central Tower', 'Admiralty Hub', 'Wan Chai Annex'],
      'Kowloon': ['TST Centre', 'Mong Kok Plaza', 'Kwun Tong Block'],
      'New Territories': ['Sha Tin Campus', 'Tsuen Wan Depot', 'Tai Po Station'],
    };
    const pick = <T>(arr: T[]) => arr[Math.floor(rand() * arr.length)];
    const abbr: Record<string, string> = { 'Hong Kong': 'HK', 'Kowloon': 'KLN', 'New Territories': 'NT' };

    // Hash the shared password ONCE — bcrypt-hashing 500 times would dominate
    // the seed runtime. Every demo user gets the same hash.
    const password = process.env.DEMO_PASSWORD || 'password';
    const passwordHash = await bcrypt.hash(password, 10);

    // ---- Users -------------------------------------------------------------
    const userRows: User[] = [];
    const named: Array<[string, string, string]> = [
      // [username, role, grade]
      ['officer', 'General User', ''],
      ['roomadmin', 'Room Admin', ''],
      ['secretary', 'Secretary', 'SDO'],
      ['secadmin', 'Security Admin', ''],
    ];
    for (const [username, role, grade] of named) {
      if (await users.findOne({ where: { tenantId, username } })) continue;
      userRows.push(users.create({
        tenantId, username, passwordHash, role, grade: grade || undefined,
        isActive: true, regionAccess: [pick(REGIONS)],
      }));
    }
    // 500 generated users with a realistic role mix.
    for (let i = 1; i <= 500; i++) {
      const r = rand();
      let role = 'General User';
      let grade: string | undefined;
      if (r > 0.98) role = 'System Admin';
      else if (r > 0.95) role = 'Security Admin';
      else if (r > 0.91) { role = 'Secretary'; grade = 'SDO'; }
      else if (r > 0.85) role = 'Room Admin';
      userRows.push(users.create({
        tenantId,
        username: `user${String(i).padStart(3, '0')}`,
        email: `user${String(i).padStart(3, '0')}@demo.fsd-mrbs.local`,
        passwordHash, role, grade,
        isActive: rand() > 0.05,
        regionAccess: rand() > 0.5 ? [pick(REGIONS)] : REGIONS.slice(0, 1 + Math.floor(rand() * 3)),
      }));
    }
    const savedUsers = await users.save(userRows, { chunk: 100 });
    this.log.log(`seeded ${savedUsers.length} users`);

    const idsByRole = (role: string) => savedUsers.filter((u) => u.role === role).map((u) => u.id);
    const generalIds = idsByRole('General User');

    // ---- Resources ---------------------------------------------------------
    const resourceRows: Resource[] = [];
    const TYPES: Array<{ type: string; weight: number }> = [
      { type: 'Meeting Room', weight: 0.55 },
      { type: 'Vehicle', weight: 0.18 },
      { type: 'Equipment', weight: 0.17 },
      { type: 'Top Management', weight: 0.10 },
    ];
    const pickType = () => {
      const r = rand(); let acc = 0;
      for (const { type, weight } of TYPES) { acc += weight; if (r <= acc) return type; }
      return 'Meeting Room';
    };
    const perRegion: Record<string, number> = {};
    for (let i = 1; i <= 122; i++) {
      const region = pick(REGIONS);
      const n = (perRegion[region] = (perRegion[region] || 0) + 1);
      const type = pickType();
      const topMgmt = type === 'Top Management';
      resourceRows.push(resources.create({
        tenantId,
        name: `${type} ${abbr[region]}-${String(n).padStart(2, '0')}`,
        region, location: pick(LOCATIONS[region]),
        assetType: type,
        capacity: type === 'Vehicle' ? 4 + Math.floor(rand() * 4)
          : type === 'Equipment' ? 1
          : 2 + Math.floor(rand() * 28),
        isActive: rand() > 0.04,
        // Top Management always needs approval + restricted; others ~30%.
        requiresApproval: topMgmt || rand() < 0.3,
        isRestricted: topMgmt || rand() < 0.1,
        compositeMode: 'standalone',
      }));
    }
    let savedResources = await resources.save(resourceRows, { chunk: 100 });

    // A few composite parents with 3 children each (split spaces) so the
    // Day-grid cross-locking + sub-resource UI has something to show.
    for (let p = 1; p <= 4; p++) {
      const region = pick(REGIONS);
      const parent = await resources.save(resources.create({
        tenantId, name: `Court ${abbr[region]}-P${p}`, region, location: pick(LOCATIONS[region]),
        assetType: 'Meeting Room', capacity: 30, isActive: true,
        requiresApproval: false, isRestricted: false, compositeMode: 'parent',
      }));
      const kids: Resource[] = [];
      for (let c = 1; c <= 3; c++) {
        kids.push(resources.create({
          tenantId, name: `${parent.name} · Bay ${c}`, region, location: parent.location,
          assetType: 'Meeting Room', capacity: 8, isActive: true,
          requiresApproval: false, isRestricted: false,
          compositeMode: 'child', parentResourceId: parent.id,
        }));
      }
      savedResources = savedResources.concat(parent, ...(await resources.save(kids)));
    }
    this.log.log(`seeded ${savedResources.length} resources (incl. composite splits)`);

    // ---- Approval-chain rules ---------------------------------------------
    const ruleRows: ApprovalRule[] = [];
    ruleRows.push(rules.create({
      tenantId, name: 'Tenant default approval', scopeType: 'tenant', scopeValue: '',
      priority: 200, isActive: true,
      levels: [{ name: 'Manager Approval', approver_role: 'Room Admin', auto_after_hours: 72 }],
    }));
    ruleRows.push(rules.create({
      tenantId, name: 'Meeting room — two-step', scopeType: 'asset_type', scopeValue: 'Meeting Room',
      priority: 50, isActive: true,
      levels: [
        { name: 'Room Admin', approver_role: 'Room Admin', auto_after_hours: 48 },
        { name: 'Security review', approver_role: 'Security Admin' },
      ],
    }));
    ruleRows.push(rules.create({
      tenantId, name: 'Vehicle — fleet officers (parallel)', scopeType: 'asset_type', scopeValue: 'Vehicle',
      priority: 50, isActive: true,
      // Role-based (not specific user ids) so the rule is fully deterministic
      // across reseeds — no DB-generated UUIDs embedded in the payload.
      levels: [{ name: 'Fleet officer', approver_role: 'Room Admin', parallel: true }],
    }));
    ruleRows.push(rules.create({
      tenantId, name: 'Top Management — Secretary then Security', scopeType: 'asset_type', scopeValue: 'Top Management',
      priority: 10, isActive: true,
      levels: [
        { name: 'Secretary (SDO)', approver_role: 'Secretary', min_grade: 'SDO' },
        { name: 'Security Admin', approver_role: 'Security Admin' },
      ],
    }));
    // A resource-scoped rule on one specific room.
    const restrictedRoom = savedResources.find((r) => r.requiresApproval && r.compositeMode === 'standalone');
    if (restrictedRoom) {
      ruleRows.push(rules.create({
        tenantId, name: `Resource rule — ${restrictedRoom.name}`, scopeType: 'resource', scopeValue: restrictedRoom.id,
        priority: 20, isActive: true,
        levels: [{ name: 'Approval', approver_role: 'Room Admin' }],
      }));
    }
    await rules.save(ruleRows);
    this.log.log(`seeded ${ruleRows.length} approval-chain rules`);

    // ---- Bookings ----------------------------------------------------------
    const TITLES = ['Team Sync', 'Training', 'Client Call', 'Project Review', '1:1',
      'Workshop', 'Interview', 'Board Meeting', 'Sprint Planning', 'Retro', ''];
    const bookers = generalIds.length ? generalIds : savedUsers.map((u) => u.id);
    const bookableResources = savedResources.filter((r) => r.isActive && r.compositeMode !== 'parent');
    const bookingRows: Booking[] = [];
    const DAY = 86400000;
    for (let i = 0; i < 280; i++) {
      const res = pick(bookableResources);
      const dayOffset = Math.floor(rand() * 28) - 7;      // -7..+20 days
      const startHour = 8 + Math.floor(rand() * 9);        // 08:00..16:00
      const durH = 1 + Math.floor(rand() * 2);             // 1..2h
      const day = new Date(); day.setHours(0, 0, 0, 0);
      const start = new Date(day.getTime() + dayOffset * DAY);
      start.setHours(startHour, 0, 0, 0);
      const end = new Date(start.getTime() + durH * 3600_000);

      // Status distribution:
      //  - future + requiresApproval → mostly Pending Approval
      //  - a slice Cancelled (any time)
      //  - PAST bookings resolve to an outcome: most Checked In (attended),
      //    some No Show. This gives the dashboard a realistic check-in rate
      //    instead of a flat 0% (the check-in feature exists but nothing had
      //    ever been checked in).
      const isPast = end.getTime() < Date.now();
      let status: string = 'Confirmed';
      let checkedInAt: Date | undefined;
      const r = rand();
      if (res.requiresApproval && !isPast && r < 0.6) {
        status = 'Pending Approval';
      } else if (r < 0.12) {
        status = 'Cancelled';
      } else if (isPast) {
        // ~70% attended (Checked In), ~20% No Show, ~10% Confirmed-but-unmarked.
        if (r < 0.66) { status = 'Checked In'; checkedInAt = new Date(start.getTime() + 5 * 60000); }
        else if (r < 0.86) status = 'No Show';
        else status = 'Confirmed';
      }

      bookingRows.push(bookings.create({
        tenantId, resourceId: res.id, userId: pick(bookers),
        startTime: start, endTime: end, status: status as any,
        title: pick(TITLES),
        bookingMode: 'exclusive',
        checkedInAt,
      }));
    }
    await bookings.save(bookingRows, { chunk: 100 });
    this.log.log(`seeded ${bookingRows.length} bookings`);

    this.log.warn(`demo seed complete in ${Math.round((Date.now() - t0) / 1000)}s — ` +
      `login with admin/admin or officer|roomadmin|secretary|secadmin / ${password}`);
  }
}
