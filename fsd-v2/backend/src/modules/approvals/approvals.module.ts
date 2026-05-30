import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Approval } from './approval.entity';
import { ApprovalRule } from './approval-rule.entity';
import { ApprovalStep } from './approval-step.entity';
import { ApprovalsService } from './approvals.service';
import { ApprovalsController, AdminApprovalRulesController } from './approvals.controller';
import { BookingsModule } from '../bookings/bookings.module';
import { ResourcesModule } from '../resources/resources.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { Booking } from '../bookings/booking.entity';
import { Resource } from '../resources/resource.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Approval, ApprovalRule, ApprovalStep, Booking, Resource]),
    BookingsModule,
    ResourcesModule,
    NotificationsModule,
  ],
  controllers: [ApprovalsController, AdminApprovalRulesController],
  providers: [ApprovalsService],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
