import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { google, calendar_v3 } from 'googleapis';
import { JWT } from 'google-auth-library';
import { GoogleSyncRecord } from './google-sync.entity';
import { Booking } from '../bookings/booking.entity';
import { CredentialService } from '../integrations/credential.service';

// GoogleSyncService — outbound only. v2 MRBS is authoritative; Google
// receives create/update/cancel pushes. Inbound RSVPs are out of scope
// for this revision (mirrors v1's sync_to_google.go comment).
//
// Authentication: the tenant's stored clientSecret is the service-
// account JSON blob, parsed via google-auth-library's JWT helper. Scope
// is the standard https://www.googleapis.com/auth/calendar.events.
//
// Target calendar id comes from env GOOGLE_TARGET_CALENDAR_ID, defaulting
// to "primary" — operators with a tenant-shared calendar override it.
const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/calendar.events'];

@Injectable()
export class GoogleSyncService {
  private readonly log = new Logger(GoogleSyncService.name);

  constructor(
    @InjectRepository(GoogleSyncRecord)
    private readonly records: Repository<GoogleSyncRecord>,
    @InjectRepository(Booking) private readonly bookings: Repository<Booking>,
    private readonly creds: CredentialService,
  ) {}

  async handleBookingEvent(eventName: string, tenantId: string, bookingId: string): Promise<void> {
    const cred = await this.creds.getDecrypted(tenantId, 'google');
    if (!cred || !cred.clientSecret) return; // not configured

    switch (eventName) {
      case 'BOOKING_CREATED':
      case 'BOOKING_APPROVED':
      case 'BOOKING_UPDATED':
        await this.push(cred.clientSecret, tenantId, bookingId);
        return;
      case 'BOOKING_CANCELLED':
      case 'BOOKING_REJECTED':
        await this.cancel(cred.clientSecret, tenantId, bookingId);
        return;
    }
  }

  private async client(serviceAccountJSON: string): Promise<calendar_v3.Calendar> {
    const parsed = JSON.parse(serviceAccountJSON);
    const jwt = new JWT({
      email: parsed.client_email,
      key: parsed.private_key,
      scopes: GOOGLE_SCOPES,
      // subject impersonation is opt-in; without it the service account
      // can only touch calendars it's explicitly shared into.
      subject: process.env.GOOGLE_IMPERSONATE_SUBJECT || undefined,
    });
    return google.calendar({ version: 'v3', auth: jwt });
  }

  private targetCalendarId(): string {
    return process.env.GOOGLE_TARGET_CALENDAR_ID || 'primary';
  }

  private async push(saJSON: string, tenantId: string, bookingId: string): Promise<void> {
    const booking = await this.bookings.findOne({ where: { id: bookingId } });
    if (!booking) return;
    const cal = await this.client(saJSON);
    const calendarId = this.targetCalendarId();

    const body: calendar_v3.Schema$Event = {
      summary: booking.title || 'FSD booking',
      description: booking.meetingUrl ? `Meeting: ${booking.meetingUrl}` : undefined,
      start: { dateTime: booking.startTime.toISOString() },
      end:   { dateTime: booking.endTime.toISOString() },
      status: booking.status === 'Cancelled' ? 'cancelled' : 'confirmed',
    };

    const existing = await this.records.findOne({ where: { bookingId } });
    try {
      if (existing) {
        await cal.events.patch({ calendarId, eventId: existing.eventId, requestBody: body });
        return;
      }
      const created = await cal.events.insert({ calendarId, requestBody: body });
      const eventId = created.data.id;
      if (eventId) {
        await this.records.save(this.records.create({
          bookingId, tenantId, calendarId, eventId,
        }));
      }
    } catch (e) {
      this.log.warn(`google push booking ${bookingId}: ${(e as Error).message}`);
    }
  }

  private async cancel(saJSON: string, _tenantId: string, bookingId: string): Promise<void> {
    const rec = await this.records.findOne({ where: { bookingId } });
    if (!rec) return;
    const cal = await this.client(saJSON);
    try {
      // PATCH to 'cancelled' rather than DELETE so attendees see the
      // strike-through and the row remains for audit (matches v1).
      await cal.events.patch({
        calendarId: rec.calendarId,
        eventId: rec.eventId,
        requestBody: { status: 'cancelled' },
      });
    } catch (e) {
      this.log.warn(`google cancel ${rec.eventId}: ${(e as Error).message}`);
    }
  }
}
