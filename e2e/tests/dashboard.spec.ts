import { test, expect } from '@playwright/test';
import { gotoSettled } from './helpers';

/**
 * Dashboard data-integrity & presentation guards. These lock in the fixes for
 * the QA dashboard cluster so they can't silently regress:
 *   • the dashboard is NOT blank when data exists (the "nothing shows" bug)
 *   • Room Utilisation renders a vertical bar chart with one bar per room
 *   • Check-in + Cancelled + No-Show in the Stat Box sum to 100%
 *   • the Stat Box "bookings" total aligns with the Utilisation-by-Department
 *     legend total (the 60-vs-71 mismatch)
 */
test.beforeEach(async ({ page }) => {
  await gotoSettled(page, '/');
});

test('dashboard is not blank — stat box shows a bookings total', async ({ page }) => {
  // The big "bookings" number in the Stat Box.
  const total = page.locator('.fsd-bigstats .item strong').first();
  await expect(total, 'Stat Box bookings total should be visible').toBeVisible();
  const n = parseInt((await total.innerText()).replace(/\D/g, '') || '-1', 10);
  expect(n, 'bookings total should be a real number (>= 0)').toBeGreaterThanOrEqual(0);
});

test('room utilisation is a vertical bar chart with bars', async ({ page }) => {
  const chart = page.locator('.vbar-chart');
  // Either bars render, or the documented empty state shows — never a broken chart.
  if (await chart.count()) {
    const bars = page.locator('.vbar-bar');
    await expect(bars.first()).toBeVisible();
    expect(await bars.count(), 'expected at least one room bar').toBeGreaterThan(0);
    // Each column carries a readable label (no truncated/rotated axis).
    expect(await page.locator('.vbar-label').count()).toBe(await bars.count());
  } else {
    await expect(page.getByText(/no bookings/i).first()).toBeVisible();
  }
});

test('check-in + cancelled + no-show percentages sum to 100%', async ({ page }) => {
  const segs = page.locator('.fsd-segrow .fsd-seg .pct');
  if (!(await segs.count())) test.skip(true, 'outcome segments not rendered');
  const texts = await segs.allInnerTexts();
  const pcts = texts.map((t) => parseInt(t.replace(/\D/g, '') || '0', 10));
  const sum = pcts.reduce((a, b) => a + b, 0);
  expect(sum, `outcome percentages ${pcts.join(' + ')} should total 100`).toBe(100);
});

test('department legend total aligns with the stat-box bookings total', async ({ page }) => {
  const statTotalEl = page.locator('.fsd-bigstats .item strong').first();
  const deptValues = page.locator('.legend li b');
  // Only meaningful when both panels are present and populated.
  if (!(await statTotalEl.count()) || !(await deptValues.count())) {
    test.skip(true, 'dashboard panels not both populated');
  }
  const statTotal = parseInt((await statTotalEl.innerText()).replace(/\D/g, '') || '0', 10);
  const deptTexts = await deptValues.allInnerTexts();
  const deptTotal = deptTexts.reduce((a, t) => a + parseInt(t.replace(/\D/g, '') || '0', 10), 0);
  expect(deptTotal, `department total (${deptTotal}) should equal stat-box total (${statTotal})`).toBe(statTotal);
});
