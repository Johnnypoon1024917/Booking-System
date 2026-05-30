import { defineConfig, devices } from '@playwright/test';
import { ADMIN_STATE } from './tests/helpers';

/**
 * Playwright config for the FSD Booking System E2E + UI/UX quality suite.
 *
 * Stack-agnostic — point it at whichever SPA is running via E2E_BASE_URL:
 *   - Node stack (React, docker):  http://localhost:5173  (frontend container)
 *   - Go stack (Vue, binary):      http://localhost:8080
 *   - Vite dev server (either):    http://localhost:5173
 *
 * Auth is established ONCE by the `setup` project and cached to disk; all other
 * projects reuse that admin session (fast, no per-test login). Credentials and
 * targets come from env (see .env.example / README) — nothing is hard-coded.
 */
export default defineConfig({
  testDir: './tests',
  // Exclude the nested Node/React project from test discovery.
  testIgnore: '**/fsd-v2/**',
  // UI/UX checks are read-only and independent → safe to parallelise. The
  // stateful booking flows still pin themselves to workers:1 where needed.
  fullyParallel: true,
  workers: process.env.CI ? 2 : undefined,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  timeout: 60_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.02, animations: 'disabled' },
  },
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
  },
  projects: [
    // 1. Authenticate once, persist storage state.
    { name: 'setup', testMatch: /auth\.setup\.ts/ },

    // 2. UI/UX quality suite — reuses the cached admin session.
    {
      name: 'chromium',
      testMatch: ['**/*.spec.ts'],
      use: { ...devices['Desktop Chrome'], storageState: ADMIN_STATE },
      dependencies: ['setup'],
    },
  ],
});
