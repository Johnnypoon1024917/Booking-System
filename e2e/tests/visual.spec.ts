import { test, expect } from '@playwright/test';
import { ALL_ROUTES, gotoSettled } from './helpers';

/**
 * Visual regression — a pixel baseline per page. The SPA is light-theme only
 * (the theme store pins data-theme="light"), so we baseline that single theme
 * rather than a phantom dark variant. Volatile regions (live clock, weather
 * chip, scrolling broadcast banner) are masked so baselines stay stable across
 * runs and machines.
 *
 * First run creates baselines:   npm run visual:update
 * Subsequent runs compare:       npm run visual
 */
const MASK = (page: import('@playwright/test').Page) => [
  page.locator('.fsd-clock'),
  page.locator('.wx-chip'),
  page.locator('.bc-banner'),
];

const SNAP = {
  fullPage: true,
  animations: 'disabled' as const,
  // Allow a tiny ratio of antialiasing/text-rendering noise across machines.
  maxDiffPixelRatio: 0.02,
};

for (const route of ALL_ROUTES) {
  test(`visual: ${route.name}`, async ({ page }) => {
    await gotoSettled(page, route.path);
    await expect(page).toHaveScreenshot(`${snap(route.path)}.png`, { ...SNAP, mask: MASK(page) });
  });
}

/** Stable file-name fragment from a route path. */
function snap(path: string): string {
  return path === '/' ? 'dashboard' : path.replace(/^\//, '').replace(/\//g, '-');
}
