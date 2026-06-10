import {
  Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query,
  BadRequestException, Res, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Min } from 'class-validator';
import type { Response } from 'express';
import { BookingsService } from './bookings.service';
import { RecurrenceService } from './recurrence.service';
import { CheckinService } from './checkin.service';
import { FreeBusyService } from './freebusy.service';
import { IcsService } from './ics.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { AuditService } from '../audit/audit.service';
import { Public } from '../../common/decorators/public.decorator';
import { AdminRoles, RequireRoles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

class CreateBookingDto {
  @IsUUID() resourceId!: string;
  @IsDateString() startTime!: string;
  @IsDateString() endTime!: string;
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() meetingUrl?: string;
  @IsOptional() @IsBoolean() isPrivate?: boolean;
  // Answers to the resource's custom fields, keyed by field key. Shape is
  // resource-defined, so a loose object — the service validates required
  // fields and strips unknown keys.
  @IsOptional() @IsObject() customFieldValues?: Record<string, unknown>;
  // Service add-ons (Catering, IT setup, …). Without this decorator the
  // global whitelist validator strips the array even when the SPA sends it.
  @IsOptional() @IsArray() @IsString({ each: true }) services?: string[];
  // Invited attendees (email addresses), Teams/Outlook-style guest list.
  @IsOptional() @IsArray() @IsString({ each: true }) attendees?: string[];
  // Chargeback code; validated against the tenant's cost_centers in the service.
  @IsOptional() @IsString() costCenterCode?: string;
}
class UpdateBookingDto {
  @IsOptional() @IsDateString() startTime?: string;
  @IsOptional() @IsDateString() endTime?: string;
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() meetingUrl?: string;
  // Move the booking to a different room. Re-runs the same resource
  // validation + conflict check the time path does, against the new room.
  @IsOptional() @IsUUID() resourceId?: string;
  // Service add-ons (Catering, IT setup, …) — editable after creation so a
  // booker can add catering days later without cancelling and re-booking
  // (Outlook parity). An empty array clears them. Without this decorator the
  // global whitelist validator strips the field even when the SPA sends it.
  @IsOptional() @IsArray() @IsString({ each: true }) services?: string[];
  // Invited attendees (email addresses) — editable post-creation; an empty
  // array clears the guest list.
  @IsOptional() @IsArray() @IsString({ each: true }) attendees?: string[];
  // Answers to the resource's custom fields. Merged over the stored answers and
  // re-validated against the resource (required fields stay enforced).
  @IsOptional() @IsObject() customFieldValues?: Record<string, unknown>;
}
class CreateRecurringDtoIn {
  @IsUUID() resourceId!: string;
  @IsDateString() firstStart!: string;
  @IsDateString() firstEnd!: string;
  @IsIn(['daily', 'weekly', 'bi-weekly', 'monthly', 'custom']) pattern!: any;
  @IsOptional() @IsInt() @Min(1) interval?: number;
  @IsOptional() @IsInt() @Min(1) count?: number;
  @IsOptional() @IsDateString() until?: string;
  @IsOptional() @IsArray() byday?: number[];
  @IsOptional() @IsArray() bymonth?: number[];
  @IsOptional() @IsArray() exDates?: string[];
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() meetingUrl?: string;
  @IsOptional() @IsBoolean() isPrivate?: boolean;
  @IsOptional() @IsString() rrule?: string;
  @IsOptional() @IsObject() customFieldValues?: Record<string, unknown>;
  // Service add-ons applied to every occurrence in the series.
  @IsOptional() @IsArray() @IsString({ each: true }) services?: string[];
  // Invited attendees (email addresses) applied to every occurrence in the series.
  @IsOptional() @IsArray() @IsString({ each: true }) attendees?: string[];
  @IsOptional() @IsString() costCenterCode?: string;
}

// validateRange clamps at 366 days, fails closed on malformed input —
// mirrors v1's validateBookingDateRange. Used by /bookings and /bookings/busy.
function validateRange(start?: string, end?: string): { s: Date; e: Date } {
  if (!start || !end) throw new BadRequestException('start and end are required');
  const s = new Date(start), e = new Date(end);
  if (isNaN(+s) || isNaN(+e)) throw new BadRequestException('start/end must be ISO dates');
  if (e < s) throw new BadRequestException('end must be on or after start');
  if ((+e - +s) / 86400000 > 366) throw new BadRequestException('range exceeds 366 days');
  return { s, e };
}

@ApiTags('bookings')
@ApiBearerAuth()
@Controller('bookings')
export class BookingsController {
  constructor(
    private readonly svc: BookingsService,
    private readonly recurrence: RecurrenceService,
    private readonly checkin: CheckinService,
    private readonly freebusy: FreeBusyService,
    private readonly ics: IcsService,
    private readonly audit: AuditService,
  ) {}

  @Get('mine')
  mine(@CurrentUser() u: AuthUser) {
    return this.svc.listMine(u.tenantId, u.id);
  }

  // /api/v1/bookings/busy — PII-free overlap list. Same range guard
  // as the main list. Returns only resourceId/start/end/status so we
  // can hand the result to external calendar pickers without leaking
  // titles or attendee names.
  @Get('busy')
  async busy(
    @CurrentUser() u: AuthUser,
    @Query('start') start?: string,
    @Query('end') end?: string,
    @Query('resourceIds') resourceIds?: string,
  ) {
    const { s, e } = validateRange(start, end);
    const ids = resourceIds ? resourceIds.split(',').filter(Boolean) : undefined;
    return this.freebusy.list(u.tenantId, s, e, ids);
  }

  // /api/v1/bookings/ics-token — returns the caller's opaque feed
  // token so the SPA can render a copyable "Subscribe in Outlook" URL.
  @Get('ics-token')
  async icsToken(@CurrentUser() u: AuthUser) {
    return { token: await this.ics.tokenFor(u.id, u.tenantId) };
  }

  // POST /api/v1/bookings/ics-token/rotate — revoke the current feed URL and
  // issue a new one. Use after a leaked iCal link; old URL stops resolving.
  @Post('ics-token/rotate')
  async rotateIcsToken(@CurrentUser() u: AuthUser) {
    return { token: await this.ics.rotateToken(u.id, u.tenantId) };
  }

  // Admin / shared timeline. Range guard mirrors v1's
  // validateBookingDateRange — clamp at 366 days, fail closed on
  // malformed input.
  @Get()
  async range(@CurrentUser() u: AuthUser, @Query('start') start?: string, @Query('end') end?: string) {
    const { s, e } = validateRange(start, end);
    return this.svc.listAllForRange(u.tenantId, s, e, u.id, u.role);
  }

  @Post()
  async create(@CurrentUser() u: AuthUser, @Body() dto: CreateBookingDto) {
    const created = await this.svc.create(u.tenantId, u.id, dto);
    await this.audit.record(u, {
      action: 'BOOKING_CREATED', severity: 'info',
      targetEntity: 'booking', targetId: created.id,
      next: { resourceId: created.resourceId, status: created.status,
              startTime: created.startTime, endTime: created.endTime },
    });
    return created;
  }

  // POST /api/v1/bookings/recurring — expand the pattern, insert each
  // occurrence, return the recurrence id + skipped clashes.
  @Post('recurring')
  async createRecurring(@CurrentUser() u: AuthUser, @Body() dto: CreateRecurringDtoIn) {
    const result = await this.recurrence.createSeries(u.tenantId, u.id, dto);
    await this.audit.record(u, {
      action: 'BOOKING_SERIES_CREATED', severity: 'info',
      targetEntity: 'recurrence', targetId: result.recurrenceId,
      next: { pattern: dto.pattern, count: result.bookingIds.length, skipped: result.skipped.length },
    });
    return result;
  }

  // DELETE /api/v1/bookings/recurring/:id — cancel the whole series.
  @Delete('recurring/:id') @HttpCode(204)
  async cancelSeries(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('reason') reason?: string) {
    await this.recurrence.cancelSeries(u.tenantId, u.id, u.role, id, reason || '');
    await this.audit.record(u, {
      action: 'BOOKING_SERIES_CANCELLED', severity: 'info',
      targetEntity: 'recurrence', targetId: id, next: { reason },
    });
  }

  @Put(':id')
  async update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: UpdateBookingDto) {
    const updated = await this.svc.update(u.tenantId, u.id, u.role, id, dto);
    await this.audit.record(u, {
      action: 'BOOKING_MODIFIED', severity: 'info',
      targetEntity: 'booking', targetId: id,
      next: { startTime: updated.startTime, endTime: updated.endTime, title: updated.title },
    });
    return updated;
  }

  // PUT /api/v1/bookings/:id/series — apply an edit to the whole recurring
  // series the booking belongs to (Outlook "edit series"). Future, non-settled
  // occurrences are shifted by the same delta the edited instance moved; title,
  // meeting URL and room changes propagate to all. Per-occurrence conflicts are
  // skipped and reported rather than aborting the batch. Falls back to a single
  // update when the booking isn't part of a series.
  @Put(':id/series')
  async updateSeries(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: UpdateBookingDto) {
    const r = await this.svc.updateSeries(u.tenantId, u.id, u.role, id, dto);
    await this.audit.record(u, {
      action: 'BOOKING_MODIFIED', severity: 'info',
      targetEntity: 'booking', targetId: id,
      next: { series: true, updated: r.updated, skipped: r.skipped.length },
    });
    return r;
  }

  @Delete(':id') @HttpCode(204)
  async cancel(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('reason') reason?: string) {
    await this.svc.cancel(u.tenantId, u.id, u.role, id, reason || '');
    await this.audit.record(u, {
      action: 'BOOKING_CANCELLED', severity: 'info',
      targetEntity: 'booking', targetId: id, next: { reason },
    });
  }

  // POST /api/v1/bookings/:id/retry-sync — re-queue a booking whose calendar
  // push permanently failed (the MyBookings "retry to Outlook" action). Owner
  // or admin only; returns the new sync state for an optimistic badge flip.
  @Post(':id/retry-sync')
  async retrySync(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    const out = await this.svc.retrySync(u.tenantId, u.id, u.role, id);
    await this.audit.record(u, {
      action: 'BOOKING_MODIFIED', severity: 'info',
      targetEntity: 'booking', targetId: id, next: { syncRetry: true },
    });
    return out;
  }

  // --- Check-in ---------------------------------------------------

  // POST /api/v1/bookings/:id/checkin — owner or admin flips Confirmed
  // → Checked In. Mirrors v1's booking_checkin_handler.
  @Post(':id/checkin')
  async doCheckin(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    const isAdmin = AdminRoles.includes(u.role);
    const b = await this.checkin.checkinByBooking(u.tenantId, u.id, isAdmin, id);
    await this.audit.record(u, {
      action: 'BOOKING_CHECKED_IN', targetEntity: 'booking', targetId: id,
    });
    return b;
  }

  // POST /api/v1/bookings/:id/no-show — admin marks no-show explicitly.
  // Kept for backwards compatibility; the SPA now calls the role-guarded
  // /api/v1/admin/bookings/:id/no-show on AdminBookingsController.
  @Post(':id/no-show')
  async doNoShow(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body('reason') reason?: string) {
    if (!AdminRoles.includes(u.role)) throw new BadRequestException('admin only');
    const b = await this.checkin.markNoShow(u.tenantId, id, reason);
    await this.audit.record(u, {
      action: 'BOOKING_MARKED_NO_SHOW', severity: 'warning',
      targetEntity: 'booking', targetId: id, next: { reason },
    });
    return b;
  }

  // POST /api/v1/bookings/:id/checkin-token — issue a fresh QR token.
  // Owner or admin only — the token is a redeemable check-in credential.
  @Post(':id/checkin-token')
  issueCheckinToken(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    const isAdmin = AdminRoles.includes(u.role);
    return this.checkin.issueToken(u.tenantId, u.id, isAdmin, id);
  }
}

class NoShowDto { @IsOptional() @IsString() reason?: string; }

// Admin-scoped booking actions. Mounted at /api/v1/admin/bookings and gated
// by RolesGuard + RequireRoles(...AdminRoles) so the role check is declarative
// (and consistent with the other admin controllers) rather than an inline
// `if (!AdminRoles.includes(...))` per handler. The SPA's AdminBookings page
// targets these paths.
@ApiTags('admin / bookings')
@ApiBearerAuth()
@Controller('admin/bookings')
@UseGuards(RolesGuard)
@RequireRoles(...AdminRoles)
export class AdminBookingsController {
  constructor(
    private readonly checkin: CheckinService,
    private readonly audit: AuditService,
  ) {}

  // POST /api/v1/admin/bookings/:id/no-show — flip to No Show with a reason.
  @Post(':id/no-show')
  async noShow(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: NoShowDto) {
    const b = await this.checkin.markNoShow(u.tenantId, id, dto.reason);
    await this.audit.record(u, {
      action: 'BOOKING_MARKED_NO_SHOW', severity: 'warning',
      targetEntity: 'booking', targetId: id, next: { reason: dto.reason },
    });
    return b;
  }

  // POST /api/v1/admin/bookings/:id/attended — post-hoc confirm the meeting
  // happened. Confirmed / Checked In / Pending → Attended.
  @Post(':id/attended')
  async attended(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    const b = await this.checkin.markAttended(u.tenantId, id);
    await this.audit.record(u, {
      action: 'BOOKING_MARKED_ATTENDED', severity: 'info',
      targetEntity: 'booking', targetId: id,
    });
    return b;
  }
}

// Separate controller mounted at /api/v1/checkin so the public token
// path doesn't accidentally get caught by the bookings auth guard.
@ApiTags('checkin')
@Controller('checkin')
export class CheckinPublicController {
  constructor(private readonly checkin: CheckinService) {}

  // POST /api/v1/checkin/:token — kiosk QR redeem. No auth: the token
  // itself is the bearer credential and burns on use.
  @Public()
  @Post(':token')
  redeem(@Param('token') token: string) {
    return this.checkin.redeemToken(token);
  }
}

// Separate controller for the ICS feed so we can mark it @Public.
@ApiTags('ics')
@Controller('ics')
export class IcsController {
  constructor(private readonly ics: IcsService) {}

  // GET /api/v1/ics/feed/:tenantSlug.ics?token=... — public, but token
  // gated. Matches v1's ical_feed_handler URL shape.
  @Public()
  @Get('feed/:tenantFile')
  async feed(
    @Param('tenantFile') tenantFile: string,
    @Query('token') token: string,
    @Res() res: Response,
  ) {
    // Strip the trailing .ics so calendar clients which insist on the
    // extension don't fail to match the route.
    const slug = tenantFile.replace(/\.ics$/i, '');
    const { filename, body } = await this.ics.feedForTenant(slug, token || '');
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(body);
  }
}
