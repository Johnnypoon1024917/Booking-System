import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OutlookSyncRecord } from './outlook-sync.entity';
import { Booking } from '../bookings/booking.entity';
import { Resource } from '../resources/resource.entity';
import { CredentialService } from '../integrations/credential.service';
import { GraphService } from '../graph/graph.service';

// OutlookSyncService — push v2 booking lifecycle events into the mapped
// room mailbox's Outlook calendar via Microsoft Graph. Mirrors v1's
// sync_to_outlook.go.
//
// Idempotent:
//   - on create / update: upsert event (PATCH if mapping exists else POST)
//   - on cancel: DELETE event + drop the mapping
//
// Tenants without an active Microsoft credential silently no-op so an
// unconfigured tenant doesn't fail their booking flow.
@Injectable()
export class OutlookSyncService {
  private readonly log = new Logger(OutlookSyncService.name);

  constructor(
    @InjectRepository(OutlookSyncRecord)
    private readonly records: Repository<OutlookSyncRecord>,
    @InjectRepository(Booking) private readonly bookings: Repository<Booking>,
    @InjectRepository(Resource) private readonly resources: Repository<Resource>,
    private readonly creds: CredentialService,
    private readonly graph: GraphService,
  ) {}

  async handleBookingEvent(eventName: string, tenantId: string, bookingId: string): Promise<void> {
    const cred = await this.creds.getDecrypted(tenantId, 'microsoft');
    if (!cred) return;

    switch (eventName) {
      case 'BOOKING_CREATED':
      case 'BOOKING_APPROVED':
      case 'BOOKING_UPDATED':
        await this.upsert(cred, bookingId);
        return;
      case 'BOOKING_CANCELLED':
      case 'BOOKING_REJECTED':
        await this.cancel(cred, bookingId);
        return;
    }
  }

  private async upsert(cred: any, bookingId: string) {
    const booking = await this.bookings.findOne({ where: { id: bookingId } });
    if (!booking) return;
    const mailbox = await this.creds.mailboxForResource(booking.resourceId);
    if (!mailbox || !mailbox.isActive) return;
    const resource = await this.resources.findOne({ where: { id: booking.resourceId } });

    const event = {
      subject: this.subjectFor(resource, booking),
      body: { contentType: 'HTML', content: `Booking ${booking.id} synced from FSD MRBS.` },
      start: { dateTime: booking.startTime.toISOString().replace(/\.\d{3}Z$/, ''), timeZone: 'UTC' },
      end:   { dateTime: booking.endTime.toISOString().replace(/\.\d{3}Z$/, ''),   timeZone: 'UTC' },
      location: { displayName: resource ? `${resource.name} · ${resource.location ?? ''}` : 'Resource' },
    };

    const existing = await this.records.findOne({ where: { bookingId } });
    try {
      const result = await this.graph.upsertEvent(
        cred.azureTenantID, cred.clientID, cred.clientSecret,
        mailbox.mailboxUPN, existing?.graphId || null, event,
      );
      if (existing) {
        await this.records.update({ id: existing.id }, { graphId: result.id });
      } else {
        await this.records.save(this.records.create({
          bookingId, tenantId: booking.tenantId,
          mailboxUPN: mailbox.mailboxUPN, graphId: result.id,
          iCalUID: result.iCalUId ?? '',
        }));
      }
    } catch (e) {
      this.log.warn(`outlook upsert booking ${bookingId}: ${(e as Error).message}`);
    }
  }

  private async cancel(cred: any, bookingId: string) {
    const rec = await this.records.findOne({ where: { bookingId } });
    if (!rec) return;
    try {
      await this.graph.cancelEvent(
        cred.azureTenantID, cred.clientID, cred.clientSecret,
        rec.mailboxUPN, rec.graphId,
      );
    } catch (e) {
      this.log.warn(`outlook cancel ${rec.graphId}: ${(e as Error).message}`);
    }
    await this.records.delete({ id: rec.id });
  }

  private subjectFor(res: Resource | null | undefined, b: Booking): string {
    const name = res?.name ?? 'Booking';
    if (b.status === 'Pending Approval') return `[Pending] ${name}`;
    return b.title || name;
  }
}
