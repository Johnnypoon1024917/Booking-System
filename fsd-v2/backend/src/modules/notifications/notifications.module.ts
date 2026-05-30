import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationOutbox } from './notification-outbox.entity';
import { NotificationTemplate } from './notification-template.entity';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { SmtpService } from './smtp.service';
import { Booking } from '../bookings/booking.entity';
import { User } from '../users/user.entity';
import { Resource } from '../resources/resource.entity';
import { AuditModule } from '../audit/audit.module';
import { PushModule } from '../push/push.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([NotificationOutbox, NotificationTemplate, Booking, User, Resource]),
    AuditModule,
    PushModule,
  ],
  controllers: [NotificationsController],
  providers: [NotificationsService, SmtpService],
  // Exported so BookingsService / ApprovalsService can enqueue notifications.
  exports: [NotificationsService],
})
export class NotificationsModule {}
