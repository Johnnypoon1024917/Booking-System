import {
  BadRequestException, Controller, Get, Query, Res, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { stringify as csvStringify } from 'csv-stringify/sync';
import ExcelJS from 'exceljs';

import { ReportsService, DashboardFilter, DashboardScope } from './reports.service';
import { normalizeReportType } from './report.types';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { AdminRoles, Roles, RequireRoles, Role } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AuditService } from '../audit/audit.service';

// reportRange defaults the date window to the last 30 days when the
// caller omits either param — matches v1 report_handler.reportRange.
function reportRange(start?: string, end?: string): { start: string; end: string } {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const today = new Date();
  const e = end || iso(today);
  const sDefault = new Date(today); sDefault.setDate(today.getDate() - 30);
  const s = start || iso(sDefault);
  return { start: s, end: e };
}

// Forbid path-traversal characters in the filename component (the
// type goes into Content-Disposition).
function safeStem(type: string) {
  return type.replace(/[^a-z0-9_]/gi, '');
}

@ApiTags('reports')
@ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly svc: ReportsService,
    private readonly audit: AuditService,
  ) {}

  // Dashboard — open to all authenticated users; scope is server-decided.
  @Get('dashboard')
  @ApiQuery({ name: 'start', required: false })
  @ApiQuery({ name: 'end', required: false })
  @ApiQuery({ name: 'region', required: false })
  @ApiQuery({ name: 'location', required: false })
  async dashboard(
    @CurrentUser() u: AuthUser,
    @Query('start') start?: string,
    @Query('end') end?: string,
    @Query('region') region?: string,
    @Query('location') location?: string,
  ) {
    const { start: s, end: e } = reportRange(start, end);
    const filter = this.scopeFor(u);
    return this.svc.dashboard(u.tenantId, s, e, filter, region, location);
  }

  // Tabular preview — admin only.
  @Get('table')
  @UseGuards(RolesGuard)
  @RequireRoles(...AdminRoles)
  @ApiQuery({ name: 'type', required: false })
  @ApiQuery({ name: 'start', required: false })
  @ApiQuery({ name: 'end', required: false })
  async table(
    @CurrentUser() u: AuthUser,
    @Query('type') type?: string,
    @Query('start') start?: string,
    @Query('end') end?: string,
  ) {
    const { start: s, end: e } = reportRange(start, end);
    try {
      return await this.svc.table(u.tenantId, type ?? 'summary', s, e);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  // Export CSV / XLSX — admin only, streamed.
  @Get('export')
  @UseGuards(RolesGuard)
  @RequireRoles(...AdminRoles)
  @ApiQuery({ name: 'type', required: false })
  @ApiQuery({ name: 'format', required: false, enum: ['csv', 'xlsx'] })
  @ApiQuery({ name: 'start', required: false })
  @ApiQuery({ name: 'end', required: false })
  async export(
    @CurrentUser() u: AuthUser,
    @Res() res: Response,
    @Query('type') type?: string,
    @Query('format') format?: string,
    @Query('start') start?: string,
    @Query('end') end?: string,
  ) {
    const fmt = (format || 'csv').toLowerCase();
    const { start: s, end: e } = reportRange(start, end);

    let normType: string;
    try { normType = normalizeReportType(type); } catch { throw new BadRequestException('unknown report type'); }

    const table = await this.svc.table(u.tenantId, normType, s, e);
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const stem = `${safeStem(normType)}_report_${stamp}`;

    // Audit the export. Same shape as v1 — action=DATA_EXPORTED.
    await this.audit.record(u, {
      action: 'DATA_EXPORTED',
      severity: 'warning',
      targetEntity: 'report',
      targetId: normType,
      next: { format: fmt, start: s, end: e, rows: table.rows.length },
    });

    if (fmt === 'xlsx' || fmt === 'excel') {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Report');
      ws.addRow(table.headers).font = { bold: true } as any;
      for (const r of table.rows) ws.addRow(r);
      if (table.totalHours !== undefined) {
        ws.addRow([]);
        const last = ws.addRow(['Total Hours', table.totalHours.toFixed(1)]);
        last.font = { bold: true } as any;
      }
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=${stem}.xlsx`);
      const buf = await wb.xlsx.writeBuffer();
      res.end(Buffer.from(buf));
      return;
    }

    // CSV (default). csv-stringify handles quoting / embedded commas.
    const allRows: (string | number)[][] = [table.headers, ...table.rows];
    if (table.totalHours !== undefined) {
      allRows.push([]);
      allRows.push(['Total Hours', table.totalHours.toFixed(1)]);
    }
    const csv = csvStringify(allRows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=${stem}.csv`);
    res.send(csv);
  }

  // Server-side scope resolution. Mirrors v1 report_handler.Dashboard:
  // admins/secretary see all, room admins see their regions (falling
  // back to mine if no regions assigned), everyone else sees their own.
  private scopeFor(u: AuthUser): DashboardFilter {
    const r: Role = u.role;
    if (r === Roles.SystemAdmin || r === Roles.SecurityAdmin || r === Roles.Secretary) {
      return { scope: 'all' as DashboardScope };
    }
    if (r === Roles.RoomAdmin) {
      const regions = u.regionAccess ?? [];
      if (regions.length) return { scope: 'region', regions };
      return { scope: 'mine', userId: u.id };
    }
    return { scope: 'mine', userId: u.id };
  }
}
