import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { MetricsService } from './metrics.service';

// Times every HTTP request and records it on the Prometheus histogram. Uses the
// matched route path (e.g. /bookings/:id) NOT the raw URL, so per-id paths don't
// explode cardinality.
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const http = context.switchToHttp();
    const req = http.getRequest();
    // Skip the scrape + health endpoints so monitoring traffic doesn't dominate.
    const path = req?.route?.path ?? req?.path ?? '';
    if (path === '/metrics' || path === '/health' || path === '/health/ready') {
      return next.handle();
    }
    const start = process.hrtime.bigint();
    const record = () => {
      const res = http.getResponse();
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      const route = req?.route?.path ?? 'unmatched';
      this.metrics.observeHttp(req?.method ?? 'UNKNOWN', route, res?.statusCode ?? 0, seconds);
    };
    return next.handle().pipe(tap({ next: record, error: record }));
  }
}
