import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { WeatherService } from './weather.service';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { CustomizationService } from '../customization/customization.service';

@ApiTags('weather')
@ApiBearerAuth()
@Controller('weather')
export class WeatherController {
  constructor(
    private readonly svc: WeatherService,
    private readonly customization: CustomizationService,
  ) {}

  // Returns the cached HKO snapshot. When the tenant has disabled the HKO
  // integration (customization.hko_weather_enabled === false) we short-
  // circuit with a zeroed payload so the SPA can hide the widget without
  // a separate feature-flag round-trip.
  @Get()
  async current(@CurrentUser() u: AuthUser) {
    const cz = await this.customization.get(u.tenantId);
    if (!cz.hko_weather_enabled) {
      return { tempC: 0, signals: [], updatedAt: new Date().toISOString(), enabled: false };
    }
    const rep = await this.svc.current();
    return { ...rep, enabled: true };
  }
}
