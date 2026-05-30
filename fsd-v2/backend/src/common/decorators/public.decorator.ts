import { SetMetadata } from '@nestjs/common';

// Marker for routes that should bypass the global JwtAuthGuard.
// Used on /auth/login, /health, and the Swagger UI.
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
