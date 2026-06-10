import { Controller, Get, Header } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../decorators/public.decorator';
import { MetricsService } from './metrics.service';

// Prometheus scrape endpoint. @Public + excluded from the API prefix in main.ts
// so it sits at /metrics. In production restrict it to the monitoring network at
// the reverse proxy (it exposes route inventory + traffic shape).
@ApiTags('metrics')
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Public()
  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4')
  async scrape(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}
