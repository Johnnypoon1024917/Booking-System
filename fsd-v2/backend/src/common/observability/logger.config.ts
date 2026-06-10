import { randomUUID } from 'crypto';
import type { Params } from 'nestjs-pino';
import { isProduction } from '../env';

// Structured (JSON) logging via pino. Every log line carries a request id (taken
// from an inbound X-Request-Id if present, else generated and echoed back) plus
// the resolved tenant/user — so in an N-replica deployment an operator can grep
// one request across pods and tie an error to a tenant. Secrets (auth header,
// cookies, the SSE ?token=) are redacted.
export const loggerConfig = (): Params => ({
  pinoHttp: {
    level: process.env.LOG_LEVEL || (isProduction() ? 'info' : 'debug'),
    genReqId: (req, res) => {
      const incoming = (req.headers['x-request-id'] as string) || randomUUID();
      res.setHeader('x-request-id', incoming);
      return incoming;
    },
    // req.user is populated by the JWT guard before the request completes, so the
    // end-of-request log line is tagged with who/which tenant made it.
    customProps: (req: any) => ({
      tenantId: req.user?.tenantId,
      userId: req.user?.id,
    }),
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'req.query.token', 'req.body.password'],
      remove: true,
    },
    // Health/metrics scrapes are high-frequency noise — don't auto-log them.
    autoLogging: {
      ignore: (req: any) => {
        const url = (req.url || '').split('?')[0];
        return url === '/health' || url === '/health/ready' || url === '/metrics';
      },
    },
  },
});
