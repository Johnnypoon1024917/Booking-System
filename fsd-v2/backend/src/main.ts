import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger, RequestMethod } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { isProduction } from './common/env';

async function bootstrap() {
  // CORS (AUD-011): do not reflect arbitrary origins. In production the SPA is
  // served same-origin via nginx, so default to no cross-origin access unless an
  // explicit allow-list is provided via CORS_ORIGINS (comma-separated). Dev
  // keeps the permissive default so the Vite dev server on another port works.
  const corsOrigins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const corsConfig = isProduction()
    ? { origin: corsOrigins.length ? corsOrigins : false, credentials: true }
    : true;
  const app = await NestFactory.create(AppModule, { cors: corsConfig });

  // Trust the reverse proxy (nginx) so req.ip / X-Forwarded-For are resolved
  // from the controlled proxy hop rather than spoofable client input — see the
  // trusted-proxy handling in RateLimitGuard (AUD-012).
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  // The SAML ACS endpoint receives x-www-form-urlencoded SAMLResponse,
  // so make sure express parses it (NestJS enables JSON by default).
  const expressApp: any = app.getHttpAdapter().getInstance();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  expressApp.use(require('express').urlencoded({ extended: true, limit: '2mb' }));

  // Helmet sets the same security headers the Go version writes by
  // hand in securityHeaders middleware. Note: img-src 'https:' is
  // intentionally permitted so tenant-configured logos work — see
  // the comment in v1's main.go for the threat-model rationale.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
          fontSrc: ["'self'", 'data:'],
          connectSrc: ["'self'", 'ws:', 'wss:'],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          objectSrc: ["'none'"],
          upgradeInsecureRequests: [],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

  // class-validator runs on every DTO. transform: true converts
  // primitives (string → number, etc.) so controller params arrive
  // typed. whitelist: true silently strips unknown fields — protects
  // against mass-assignment of fields the DTO doesn't declare.
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: false,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.setGlobalPrefix('api/v1', {
    // SCIM lives at its standard /scim/v2 path per RFC 7644; health
    // and root bypass the API prefix too.
    exclude: [
      { path: '', method: RequestMethod.ALL },
      { path: 'health', method: RequestMethod.ALL },
      { path: 'health/ready', method: RequestMethod.ALL },
      { path: 'scim/v2/*', method: RequestMethod.ALL },
    ],
  });

  // Swagger (AUD-022): the API docs expose the full route inventory and DTO
  // shapes. Keep them off in production unless explicitly opted in via
  // ENABLE_SWAGGER=true (e.g. behind a VPN/admin gate).
  const swaggerEnabled = !isProduction() || process.env.ENABLE_SWAGGER === 'true';
  if (swaggerEnabled) {
    const swagger = new DocumentBuilder()
      .setTitle('FSD MRBS API v2')
      .setDescription('Multi-tenant resource booking platform')
      .setVersion('2.0.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, swagger);
    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: { persistAuthorization: true },
    });
  }

  // Graceful shutdown (AUD-015): let Nest run onModuleDestroy/beforeApplicationShutdown
  // hooks (drain DB pool, stop cron, flush outbox) on SIGTERM/SIGINT.
  app.enableShutdownHooks();

  const port = parseInt(process.env.PORT || '3000', 10);
  await app.listen(port);
  Logger.log(`FSD MRBS v2 listening on :${port}${swaggerEnabled ? ' — Swagger at /api/docs' : ''}`, 'Bootstrap');
}
bootstrap();
