import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

// Central Prometheus registry + the app's custom metrics. Scraped at GET /metrics
// (see MetricsController). Default process/runtime metrics (event-loop lag, heap,
// GC, fd count) plus HTTP latency and live SSE connection count — the signals an
// operator needs to see a node saturate, a failover stall, or streams pile up.
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  readonly httpErrors = new Counter({
    name: 'http_requests_errors_total',
    help: 'Total HTTP responses with status >= 500',
    labelNames: ['method', 'route'] as const,
    registers: [this.registry],
  });

  readonly sseConnections = new Gauge({
    name: 'sse_active_connections',
    help: 'Currently open server-sent-event streams',
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: 'fsd_' });
  }

  observeHttp(method: string, route: string, status: number, seconds: number) {
    this.httpDuration.observe({ method, route, status: String(status) }, seconds);
    if (status >= 500) this.httpErrors.inc({ method, route });
  }

  sseInc() { this.sseConnections.inc(); }
  sseDec() { this.sseConnections.dec(); }
}
