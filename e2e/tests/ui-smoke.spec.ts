import { test, expect } from '@playwright/test';
import { ALL_ROUTES, collectHealth, gotoSettled, mainText } from './helpers';

/**
 * UI smoke / health sweep — the baseline every page must pass to be called
 * "product grade". For each authenticated route we assert:
 *   • it does not bounce back to /login (broken auth/route)
 *   • the content area actually renders something (no blank/white screen —
 *     this is the class the "dashboard shows nothing" bug belonged to)
 *   • no uncaught JS errors (pageerror)
 *   • no console errors
 *   • no failed API calls (4xx/5xx) backing the view
 *
 * Runs against the cached admin session so every admin page is reachable.
 */
for (const route of ALL_ROUTES) {
  test(`smoke: ${route.name} (${route.path}) renders cleanly`, async ({ page }) => {
    const health = collectHealth(page);
    await gotoSettled(page, route.path);

    // 1. Did not get kicked to login.
    await expect(page, `${route.path} redirected to /login`).not.toHaveURL(/\/login/i);

    // 2. Not a blank page — the content region has real text.
    const text = await mainText(page);
    expect(text.length, `${route.path} rendered an empty content area (blank screen)`).toBeGreaterThan(20);

    // 3. No uncaught runtime errors.
    expect(health.pageErrors, `${route.path} threw uncaught JS errors`).toEqual([]);

    // 4. No console errors.
    expect(health.consoleErrors, `${route.path} logged console errors`).toEqual([]);

    // 5. No failed network calls backing the page.
    expect(health.failedResponses, `${route.path} had failing API/network calls`).toEqual([]);
  });
}
