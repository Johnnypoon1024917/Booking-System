import {
  Body, Controller, Get, Headers, Param, Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';
import { KioskService } from './kiosk.service';
import { Public } from '../../common/decorators/public.decorator';

class QuickBookDto {
  @IsOptional() @IsInt() @Min(5) durationMinutes?: number;
  @IsOptional() @IsString() title?: string;
}

// Kiosk endpoints bypass JWT — devices authenticate with a shared
// X-Kiosk-Token header validated against KIOSK_TOKEN env. Tenant
// scoping is implicit through the resource id (UUID, unguessable).
@ApiTags('kiosk')
@Controller('kiosk')
export class KioskController {
  constructor(private readonly svc: KioskService) {}

  @Public()
  @Get(':resourceId/state')
  state(
    @Param('resourceId') resourceId: string,
    @Headers('x-kiosk-token') token?: string,
  ) {
    this.svc.assertToken(token);
    return this.svc.state(resourceId);
  }

  @Public()
  @Post(':resourceId/quick-book')
  quickBook(
    @Param('resourceId') resourceId: string,
    @Headers('x-kiosk-token') token: string | undefined,
    @Body() dto: QuickBookDto,
  ) {
    this.svc.assertToken(token);
    return this.svc.quickBook(resourceId, dto.durationMinutes ?? 30, dto.title ?? 'Walk-in');
  }
}
