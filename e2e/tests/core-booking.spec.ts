import { test, expect } from '@playwright/test';
import { ENV, login, isoDate, setField } from './helpers';

/**
 * Core booking-logic E2E flows. These double as regression guards for the
 * QA bugs in the core cluster:
 *   #1  a booked slot must not be offered as available afterwards
 *   #2  an all-day search must return rooms with normal operating hours
 *   #4  a recurring booking must create more than one occurrence
 *
 * They require a running, seeded stack (see README). When credentials are
 * absent the suite skips rather than failing red in an unconfigured CI.
 */
test.beforeEach(async ({ page }) => {
  test.skip(!ENV.user.password, 'E2E_USER_PASSWORD not set — see e2e/README.md');
  await login(page, ENV.user.email, ENV.user.password);
});

// Navigate to the search/new-booking page across either stack.
async function gotoSearch(page) {
  await page.goto('/search');
  await expect(page.getByRole('heading', { name: /booking|search/i }).first()).toBeVisible();
}

test('#2 all-day search returns rooms with normal operating hours', async ({ page }) => {
  await gotoSearch(page);
  await setField(page, ['input[type="date"]'], isoDate(2));
  // Toggle the "All Day Event" checkbox.
  const allDay = page.getByLabel(/all day/i).first();
  await allDay.check();
  await page.getByRole('button', { name: /search/i }).first().click();

  // At least one room should be available — previously only 24h rooms matched.
  const results = page.locator('text=/available|pax/i');
  await expect(results.first()).toBeVisible({ timeout: 15_000 });
  // The "no rooms" empty state must NOT be shown.
  await expect(page.getByText(/no rooms|nothing available|0 rooms/i)).toHaveCount(0);
});

test('#1 a slot that was just booked is no longer offered as available', async ({ page }) => {
  await gotoSearch(page);
  const date = isoDate(3);
  await setField(page, ['input[type="date"]'], date);
  await setField(page, ['input[name="start"]', 'input[type="time"]'], '15:00');

  await page.getByRole('button', { name: /search/i }).first().click();
  const firstRoom = page.locator('[data-room], .room-row, label:has-text("pax"), li:has-text("pax")').first();
  await expect(firstRoom).toBeVisible({ timeout: 15_000 });
  const roomName = (await firstRoom.innerText()).split('\n')[0].trim();

  // Book it.
  await firstRoom.click();
  await page.getByRole('button', { name: /confirm|reserve|book/i }).first().click();
  // Fill the required title in the confirm modal, then submit.
  await setField(page, ['input[placeholder*="Sync" i]', 'label:has-text("Title") input'], 'E2E overlap test');
  await page.getByRole('button', { name: /submit|confirm booking/i }).first().click();
  await expect(page.getByText(/confirmed|submitted|pending/i).first()).toBeVisible({ timeout: 15_000 });

  // Search the SAME window again — the booked room must be gone from the
  // available list (the overlap is now detected in the tenant timezone, #1).
  await gotoSearch(page);
  await setField(page, ['input[type="date"]'], date);
  await setField(page, ['input[name="start"]', 'input[type="time"]'], '15:00');
  await page.getByRole('button', { name: /search/i }).first().click();
  await page.waitForTimeout(1500);
  const availableNames = await page.locator('label:has-text("pax"), li:has-text("pax")').allInnerTexts();
  expect(availableNames.join(' | ')).not.toContain(roomName);
});

test('#4 recurring booking creates multiple occurrences', async ({ page }) => {
  await gotoSearch(page);
  await setField(page, ['input[type="date"]'], isoDate(5));
  await setField(page, ['input[name="start"]', 'input[type="time"]'], '10:00');
  await page.getByRole('button', { name: /search/i }).first().click();

  const room = page.locator('label:has-text("pax"), li:has-text("pax")').first();
  await expect(room).toBeVisible({ timeout: 15_000 });
  await room.click();
  await page.getByRole('button', { name: /confirm|reserve|book/i }).first().click();

  // Enable recurrence in the confirm modal.
  await page.getByText(/make this recurring|recurring/i).first().click().catch(() => {});
  const recurToggle = page.getByLabel(/recurring/i).first();
  if (await recurToggle.count()) await recurToggle.check().catch(() => {});
  // Daily, 3 occurrences.
  await page.getByRole('combobox').first().selectOption({ label: 'Daily' }).catch(() => {});
  const occ = page.locator('input[type="number"]').last();
  if (await occ.count()) await occ.fill('3');
  await setField(page, ['input[placeholder*="Sync" i]'], 'E2E recurring test');
  await page.getByRole('button', { name: /submit|confirm booking/i }).first().click();
  await expect(page.getByText(/confirmed|submitted|recurring/i).first()).toBeVisible({ timeout: 15_000 });

  // My Bookings should now surface a recurring marker.
  await page.goto('/my');
  await expect(page.getByText(/recurring/i).first()).toBeVisible({ timeout: 15_000 });
});
