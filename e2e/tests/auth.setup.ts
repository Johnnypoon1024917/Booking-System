import { test as setup, expect } from '@playwright/test';
import { ENV, ADMIN_STATE, login } from './helpers';

/**
 * Authenticates once as the admin and writes the storage state that every
 * UI/UX spec reuses (Playwright "authentication setup project" pattern).
 * This keeps the suite fast: ~25 routes are audited without re-logging in.
 */
setup('authenticate as admin', async ({ page }) => {
  setup.skip(!ENV.admin.password, 'E2E_ADMIN_PASSWORD not set — see e2e/README.md');
  await login(page, ENV.admin.email, ENV.admin.password);
  // Confirm we really have a session before persisting it.
  await expect(page).not.toHaveURL(/\/login/i);
  await page.context().storageState({ path: ADMIN_STATE });
});
