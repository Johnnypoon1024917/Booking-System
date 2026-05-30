import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ObjectLiteral, Repository, SelectQueryBuilder } from 'typeorm';
import { Booking } from '../bookings/booking.entity';
import { AuditEntry } from '../audit/audit.entity';
import { ReportTable, ReportType, normalizeReportType } from './report.types';

// reportTZ resolves the IANA timezone the report formatters should
// localise into. Matches v1 ReportRepo.reportTZ() — REPORT_TIMEZONE
// overrides the Asia/Hong_Kong default for non-HK deployments.
function reportTZ(): string {
  const tz = (process.env.REPORT_TIMEZONE ?? '').trim();
  return tz || 'Asia/Hong_Kong';
}

// fmtDateTime / fmtDate / fmtTime emit the same SQL snippets as v1's
// report_repo.go helpers so columns localise consistently. The shape
// is `column AT TIME ZONE 'UTC' AT TIME ZONE '<tz>'` because the v1
// bookings table is `timestamp without time zone` storing UTC clock
// values; the v2 schema is `timestamptz` but the AT TIME ZONE chain
// still works because the first conversion is a no-op for tz-aware
// columns and the second pins display to reportTZ().
const fmtDateTime = (col: string) =>
  `TO_CHAR(${col} AT TIME ZONE 'UTC' AT TIME ZONE '${reportTZ()}', 'YYYY-MM-DD HH24:MI')`;
const fmtDate = (col: string) =>
  `TO_CHAR(${col} AT TIME ZONE 'UTC' AT TIME ZONE '${reportTZ()}', 'YYYY-MM-DD')`;
const fmtTime = (col: string) =>
  `TO_CHAR(${col} AT TIME ZONE 'UTC' AT TIME ZONE '${reportTZ()}', 'HH24:MI')`;

// dateInTZ buckets a timestamptz to a *calendar date in reportTZ()* for range
// filtering. A bare `col::date` casts in the DB's zone (UTC), so a 07:00
// Hong Kong booking — 23:00 UTC the previous day — lands on the wrong date and
// silently shifts into the prior period's tally. AT TIME ZONE pins it to the
// report zone first, matching what fmtDate displays so filtered rows and the
// dates shown for them always agree.
const dateInTZ = (col: string) =>
  `(${col} AT TIME ZONE 'UTC' AT TIME ZONE '${reportTZ()}')::date`;

export type DashboardScope = 'all' | 'region' | 'mine';

export interface DashboardFilter {
  scope: DashboardScope;
  userId?: string;
  regions?: string[];
}

@Injectable()
export class ReportsService {
  constructor(
    @InjectRepository(Booking) private readonly bookings: Repository<Booking>,
    @InjectRepository(AuditEntry) private readonly audits: Repository<AuditEntry>,
  ) {}

  // ---------------------------------------------------------------
  // Dashboard — four small aggregate queries, scope-aware, mirrors
  // v1 ReportRepo.GetDashboard.
  // ---------------------------------------------------------------
  async dashboard(
    tenantId: string, start: string, end: string, filter: DashboardFilter,
    region?: string, location?: string,
  ) {
    // Optional explicit region/location filter (dashboard dropdowns). Applied
    // on top of the role-derived scope.
    const reg = (region || '').trim();
    const loc = (location || '').trim();
    const applyScope = <T extends ObjectLiteral>(qb: SelectQueryBuilder<T>): SelectQueryBuilder<T> => {
      qb.where('b.tenant_id = :t', { t: tenantId })
        // NOTE: do NOT exclude Cancelled here. The Stat Box headline counts
        // every booking in the period, so the utilisation charts must too —
        // otherwise the chart totals (active only) didn't match the headline
        // total and looked broken (e.g. 60 vs 71). The Cancelled % tile shows
        // the cancelled share.
        .andWhere(`${dateInTZ('b.start_time')} >= :s::date AND ${dateInTZ('b.start_time')} <= :e::date`, { s: start, e: end });
      if (filter.scope === 'mine' && filter.userId) {
        qb.andWhere('b.user_id = :u', { u: filter.userId });
      } else if (filter.scope === 'region' && filter.regions?.length) {
        qb.andWhere('r.region = ANY(:rg)', { rg: filter.regions });
      }
      if (reg) qb.andWhere('r.region = :reg', { reg });
      if (loc) qb.andWhere('r.location = :loc', { loc });
      return qb;
    };

    // 1) Room utilisation — every room with a booking in the period (no cap;
    // the SPA renders a scrollable chart and offers region/location filters).
    const roomRows = await applyScope(
      this.bookings.createQueryBuilder('b')
        .innerJoin('resources', 'r', 'r.id = b.resource_id')
        .select('r.name', 'name')
        .addSelect('COUNT(b.id)', 'count'),
    ).groupBy('r.name').orderBy('count', 'DESC').getRawMany();

    // 2) By department rollup. The chart is titled "Utilization by Dept" and
    // resources carry a real department_id → departments.name, so group by the
    // department (LEFT JOIN — department_id is nullable) rather than r.region,
    // which had been masquerading as the department. Rooms with no department
    // fall into "Unassigned".
    const deptRows = await applyScope(
      this.bookings.createQueryBuilder('b')
        .innerJoin('resources', 'r', 'r.id = b.resource_id')
        .leftJoin('departments', 'd', 'd.id = r.department_id')
        .select(`COALESCE(NULLIF(d.name,''),'Unassigned')`, 'name')
        .addSelect('COUNT(b.id)', 'count'),
    )
      // Group by the department EXPRESSION, not the output alias "name":
      // Postgres resolves an unqualified `GROUP BY name` to the resources.name
      // *column* (which exists), leaving d.name ungrouped and throwing
      // "column d.name must appear in the GROUP BY clause" — which 500'd the
      // whole dashboard once real data was present.
      .groupBy(`COALESCE(NULLIF(d.name,''),'Unassigned')`)
      .orderBy('count', 'DESC').getRawMany();

    // 3) Stats — single query, multiple FILTER aggregates. Don't
    // filter out Cancelled here because we report cancel %.
    const statsQB = this.bookings.createQueryBuilder('b')
      .innerJoin('resources', 'r', 'r.id = b.resource_id')
      .select('COUNT(*)::int', 'total')
      .addSelect('COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (b.end_time - b.start_time))/60)),0)::int', 'avg_min')
      .addSelect(`COUNT(*) FILTER (WHERE b.status = 'Checked In' OR b.checked_in_at IS NOT NULL)::int`, 'checked_in')
      .addSelect(`COUNT(*) FILTER (WHERE b.status = 'Cancelled')::int`, 'cancelled')
      .addSelect(`COUNT(*) FILTER (WHERE b.status = 'No Show')::int`, 'no_show')
      .addSelect(`COUNT(*) FILTER (WHERE EXTRACT(HOUR FROM b.start_time) < 9 OR EXTRACT(HOUR FROM b.start_time) >= 18)::int`, 'non_office')
      .addSelect(`COUNT(*) FILTER (WHERE b.start_time - b.created_at <= INTERVAL '5 minutes')::int`, 'walk_in')
      .where('b.tenant_id = :t', { t: tenantId })
      .andWhere(`${dateInTZ('b.start_time')} >= :s::date AND ${dateInTZ('b.start_time')} <= :e::date`, { s: start, e: end });
    if (filter.scope === 'mine' && filter.userId) {
      statsQB.andWhere('b.user_id = :u', { u: filter.userId });
    } else if (filter.scope === 'region' && filter.regions?.length) {
      statsQB.andWhere('r.region = ANY(:rg)', { rg: filter.regions });
    }
    if (reg) statsQB.andWhere('r.region = :reg', { reg });
    if (loc) statsQB.andWhere('r.location = :loc', { loc });
    const statsRaw = (await statsQB.getRawOne()) ?? {};
    const total = Number(statsRaw.total ?? 0);
    const checkedIn = Number(statsRaw.checked_in ?? 0);
    const cancelled = Number(statsRaw.cancelled ?? 0);
    const noShow = Number(statsRaw.no_show ?? 0);
    // Check-in / Cancelled / No-Show are the three terminal OUTCOMES of a
    // booking, so the segmented bar normalises them against each other to a
    // true 100% breakdown (they previously each divided by the period total —
    // which also counts upcoming/confirmed bookings — so they never summed to
    // 100%). The remainder is folded into No-Show so rounding still totals 100.
    const outcomeTotal = checkedIn + cancelled + noShow;
    const checkInPct = outcomeTotal ? Math.round((checkedIn / outcomeTotal) * 100) : 0;
    const cancelPct = outcomeTotal ? Math.round((cancelled / outcomeTotal) * 100) : 0;
    const noShowPct = outcomeTotal ? Math.max(0, 100 - checkInPct - cancelPct) : 0;

    // 4) No-show recent table.
    const nsRows = await applyScope(
      this.bookings.createQueryBuilder('b')
        .innerJoin('resources', 'r', 'r.id = b.resource_id')
        .leftJoin('departments', 'd', 'd.id = r.department_id')
        .innerJoin('users', 'u', 'u.id = b.user_id')
        .select('u.username', 'name')
        // The "Department" column must show the room's department, not its
        // region (which had stood in for it). LEFT JOIN: department_id is null
        // for unassigned rooms.
        .addSelect(`COALESCE(NULLIF(d.name,''),'-')`, 'dept')
        .addSelect('r.name', 'room')
        .addSelect(`${fmtDateTime('b.start_time')}`, 'when'),
    )
      // Override the Cancelled-exclusion from applyScope: no-show panel
      // needs status='No Show' specifically.
      .andWhere(`b.status = 'No Show'`)
      .orderBy('b.start_time', 'DESC').limit(12).getRawMany();

    return {
      scope: filter.scope,
      roomUtilisation: roomRows.map((r: any) => ({ name: r.name, count: +r.count })),
      byDepartment: deptRows.map((r: any) => ({ name: r.name, count: +r.count })),
      stats: {
        total,
        avgMin: Number(statsRaw.avg_min ?? 0),
        checkInPct,
        cancelPct,
        noShowPct,
        // Counts behind the percentages, in case the SPA wants tooltips.
        checkedIn, cancelled, noShow, outcomeTotal,
      },
      noShow: nsRows.map((r: any) => ({
        name: r.name, dept: r.dept, room: r.room, when: r.when,
      })),
    };
  }

  // ---------------------------------------------------------------
  // Tabular reports — one method, dispatches on report type. Each
  // branch uses a TypeORM query builder against the tenant-scoped
  // tables. Headers / column ordering mirror v1 GetReportTable.
  // ---------------------------------------------------------------
  async table(tenantId: string, rawType: string, start: string, end: string): Promise<ReportTable> {
    const type = normalizeReportType(rawType);
    const base: Omit<ReportTable, 'headers' | 'rows'> = {
      type,
      generatedAt: new Date().toISOString(),
      start, end,
    };

    switch (type) {
      case 'audit': {
        const headers = ['Date', 'User', 'Action', 'Target', 'Target ID'];
        const rows = await this.audits.createQueryBuilder('a')
          .leftJoin('users', 'u', 'u.id = a.user_id')
          .select(fmtDateTime('a.created_at'), 'd')
          .addSelect(`COALESCE(u.username,'system')`, 'user')
          .addSelect('a.action', 'action')
          .addSelect(`COALESCE(a.target_entity,'')`, 'tgt')
          .addSelect(`COALESCE(a.target_id,'')`, 'tid')
          .where('a.tenant_id = :t', { t: tenantId })
          .andWhere(`${dateInTZ('a.created_at')} >= :s::date AND ${dateInTZ('a.created_at')} <= :e::date`, { s: start, e: end })
          .orderBy('a.created_at', 'DESC')
          .limit(1000)
          .getRawMany();
        return { ...base, headers, rows: rows.map((r: any) => [r.d, r.user, r.action, r.tgt, r.tid]) };
      }

      case 'staff': {
        const headers = ['Booked By', 'Bookings', 'Total Hours'];
        const rows = await this.bookings.createQueryBuilder('b')
          .innerJoin('users', 'u', 'u.id = b.user_id')
          .select('u.username', 'username')
          .addSelect('COUNT(b.id)::text', 'cnt')
          .addSelect(
            `TO_CHAR(COALESCE(SUM(EXTRACT(EPOCH FROM (b.end_time-b.start_time))/3600),0),'FM999990.0')`,
            'hrs',
          )
          .where('b.tenant_id = :t', { t: tenantId })
          .andWhere(`b.status <> 'Cancelled'`)
          .andWhere(`${dateInTZ('b.start_time')} >= :s::date AND ${dateInTZ('b.start_time')} <= :e::date`, { s: start, e: end })
          .groupBy('u.username')
          .orderBy('COUNT(b.id)', 'DESC')
          .limit(1000)
          .getRawMany();
        const totalHours = rows.reduce((sum, r: any) => sum + Number(r.hrs || 0), 0);
        return {
          ...base, headers,
          rows: rows.map((r: any) => [r.username, r.cnt, r.hrs]),
          totalHours,
        };
      }

      case 'usage': {
        const headers = ['Room', 'Location', 'Bookings', 'Total Hours'];
        const rows = await this.bookings.createQueryBuilder('b')
          .innerJoin('resources', 'r', 'r.id = b.resource_id')
          .select('r.name', 'name')
          .addSelect(`COALESCE(r.location,'')`, 'loc')
          .addSelect('COUNT(b.id)::text', 'cnt')
          .addSelect(
            `TO_CHAR(COALESCE(SUM(EXTRACT(EPOCH FROM (b.end_time-b.start_time))/3600),0),'FM999990.0')`,
            'hrs',
          )
          .where('b.tenant_id = :t', { t: tenantId })
          .andWhere(`b.status <> 'Cancelled'`)
          .andWhere(`${dateInTZ('b.start_time')} >= :s::date AND ${dateInTZ('b.start_time')} <= :e::date`, { s: start, e: end })
          .groupBy('r.name').addGroupBy('r.location')
          .orderBy('COUNT(b.id)', 'DESC')
          .limit(1000)
          .getRawMany();
        const totalHours = rows.reduce((sum, r: any) => sum + Number(r.hrs || 0), 0);
        return {
          ...base, headers,
          rows: rows.map((r: any) => [r.name, r.loc, r.cnt, r.hrs]),
          totalHours,
        };
      }

      case 'addl': {
        const headers = ['Booking Date', 'Room', 'Booked By', 'Status'];
        const rows = await this.bookings.createQueryBuilder('b')
          .innerJoin('resources', 'r', 'r.id = b.resource_id')
          .innerJoin('users', 'u', 'u.id = b.user_id')
          .select(fmtDate('b.start_time'), 'd')
          .addSelect('r.name', 'room')
          .addSelect('u.username', 'username')
          .addSelect('b.status', 'status')
          .where('b.tenant_id = :t', { t: tenantId })
          .andWhere(`${dateInTZ('b.start_time')} >= :s::date AND ${dateInTZ('b.start_time')} <= :e::date`, { s: start, e: end })
          .orderBy('b.start_time', 'DESC')
          .limit(1000)
          .getRawMany();
        return { ...base, headers, rows: rows.map((r: any) => [r.d, r.room, r.username, r.status]) };
      }

      case 'noshow': {
        const headers = ['Booking Date', 'Time', 'Location', 'Room', 'Booked By'];
        const rows = await this.bookings.createQueryBuilder('b')
          .innerJoin('resources', 'r', 'r.id = b.resource_id')
          .innerJoin('users', 'u', 'u.id = b.user_id')
          .select(fmtDate('b.start_time'), 'd')
          .addSelect(fmtTime('b.start_time'), 't')
          .addSelect(`COALESCE(r.location,'')`, 'loc')
          .addSelect('r.name', 'room')
          .addSelect('u.username', 'username')
          .where('b.tenant_id = :t', { t: tenantId })
          .andWhere(`b.status = 'No Show'`)
          .andWhere(`${dateInTZ('b.start_time')} >= :s::date AND ${dateInTZ('b.start_time')} <= :e::date`, { s: start, e: end })
          .orderBy('b.start_time', 'DESC')
          .limit(1000)
          .getRawMany();
        return { ...base, headers, rows: rows.map((r: any) => [r.d, r.t, r.loc, r.room, r.username]) };
      }

      // summary, medical, and anything otherwise legal → booking summary
      default: {
        // Title (the meeting subject) was missing from the export, leaving no
        // way to tell what each booking was for (QA #9). Surface it between
        // Room and Booked By.
        const headers = ['Booking Date', 'Time', 'Location', 'Room', 'Title', 'Booked By', 'Status'];
        const rows = await this.bookings.createQueryBuilder('b')
          .innerJoin('resources', 'r', 'r.id = b.resource_id')
          .innerJoin('users', 'u', 'u.id = b.user_id')
          .select(fmtDate('b.start_time'), 'd')
          .addSelect(fmtTime('b.start_time'), 't')
          .addSelect(`COALESCE(r.location,'')`, 'loc')
          .addSelect('r.name', 'room')
          .addSelect(`COALESCE(NULLIF(b.title, ''), '—')`, 'title')
          .addSelect('u.username', 'username')
          .addSelect('b.status', 'status')
          .where('b.tenant_id = :t', { t: tenantId })
          .andWhere(`${dateInTZ('b.start_time')} >= :s::date AND ${dateInTZ('b.start_time')} <= :e::date`, { s: start, e: end })
          .orderBy('b.start_time', 'DESC')
          .limit(1000)
          .getRawMany();
        return {
          ...base, headers,
          rows: rows.map((r: any) => [r.d, r.t, r.loc, r.room, r.title, r.username, r.status]),
        };
      }
    }
  }
}
