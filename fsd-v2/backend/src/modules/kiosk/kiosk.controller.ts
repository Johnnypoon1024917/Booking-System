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

// Kiosk endpoints bypass JWT — devices authenticate with an X-Kiosk-Token
// header. The token is validated against the token configured for the TENANT
// that owns the target resource (KIOSK_TOKENS), so a device token can only act
// on its own tenant's resources — never cross-tenant.
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
    return this.svc.state(resourceId, token);
  }

  @Public()
  @Post(':resourceId/quick-book')
  quickBook(
    @Param('resourceId') resourceId: string,
    @Headers('x-kiosk-token') token: string | undefined,
    @Body() dto: QuickBookDto,
  ) {
    return this.svc.quickBook(resourceId, dto.durationMinutes ?? 30, dto.title ?? 'Walk-in', token);
  }
}
