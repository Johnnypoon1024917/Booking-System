import { isProduction, isTest, allowInsecureLocal } from './env';

// Focused tests for the fail-closed env helpers (AUD-004/005/020). These gate
// several public endpoints, so their behaviour must be unambiguous.
describe('env helpers', () => {
  const original = { ...process.env };
  afterEach(() => { process.env = { ...original }; });

  it('isProduction true only when NODE_ENV=production', () => {
    process.env.NODE_ENV = 'production';
    expect(isProduction()).toBe(true);
    process.env.NODE_ENV = 'development';
    expect(isProduction()).toBe(false);
  });

  it('isTest true only when NODE_ENV=test', () => {
    process.env.NODE_ENV = 'test';
    expect(isTest()).toBe(true);
    process.env.NODE_ENV = 'production';
    expect(isTest()).toBe(false);
  });

  it('allowInsecureLocal requires the flag AND a non-production env', () => {
    process.env.NODE_ENV = 'production';
    process.env.ALLOW_INSECURE_LOCAL = 'true';
    expect(allowInsecureLocal()).toBe(false); // never in prod, even with the flag

    process.env.NODE_ENV = 'development';
    process.env.ALLOW_INSECURE_LOCAL = 'true';
    expect(allowInsecureLocal()).toBe(true);

    process.env.ALLOW_INSECURE_LOCAL = 'false';
    expect(allowInsecureLocal()).toBe(false);

    delete process.env.ALLOW_INSECURE_LOCAL;
    expect(allowInsecureLocal()).toBe(false);
  });
});
