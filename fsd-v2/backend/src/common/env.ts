// Centralized environment helpers.
//
// The codebase previously re-implemented `process.env.NODE_ENV !== 'production'`
// style checks inline at every call site, which is exactly how several public
// endpoints ended up failing OPEN in production (kiosk token, Teams webhook,
// Swagger). Funnel those decisions through one place so "is this a real,
// non-local deployment" is decided consistently.

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

export function isTest(): boolean {
  return process.env.NODE_ENV === 'test';
}

// True only when the operator has explicitly opted into insecure local
// behaviour. A missing shared secret is tolerated ONLY in local development
// AND only when this flag is set — never silently in production.
export function allowInsecureLocal(): boolean {
  return !isProduction() && process.env.ALLOW_INSECURE_LOCAL === 'true';
}

// Resolve a credential/secret that MUST be set in production. In production a
// missing value throws at boot (fail loud, never connect with a known default);
// outside production it falls back to the supplied dev default so local setup
// stays frictionless. Funnel every "insecure default" through here so prod can
// never silently run with `changeme` / a known JWT secret.
export function prodSecret(name: string, devDefault: string): string {
  const v = process.env[name];
  if (v) return v;
  if (isProduction()) {
    throw new Error(`${name} must be set in production (no insecure default is permitted)`);
  }
  return devDefault;
}
