import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Approval } from './approval.entity';
import { ApprovalRule } from './approval-rule.entity';
import { ApprovalStep } from './approval-step.entity';
import { ApprovalsService } from './approvals.service';
import { ApprovalsCron } from './approvals.cron';
import { ApprovalsController, AdminApprovalRulesController } from './approvals.controller';
import { BookingsModule } from '../bookings/bookings.module';
import { ResourcesModule } from '../resources/resources.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { UsersModule } from '../users/users.module';
import { Booking } from '../bookings/booking.entity';
import { Resource } from '../resources/resource.entity';
import { User } from '../users/user.entity';
import { Department } from '../departments/department.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Approval, ApprovalRule, ApprovalStep, Booking, Resource, User, Department]),
    forwardRef(() => BookingsModule),
    ResourcesModule,
    NotificationsModule,
    UsersModule,
  ],
  controllers: [ApprovalsController, AdminApprovalRulesController],
  providers: [ApprovalsService, ApprovalsCron],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
