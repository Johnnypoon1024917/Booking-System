import { test, expect } from '@playwright/test';
import { ENV, login, UUID_RE, createBooking, isoDate } from './helpers';

/**
 * My Bookings page regressions:
 *   #7   the card heading must be a resource name, never a raw UUID
 *   #11  Cancelled / No-Show bookings must not count toward "Upcoming"
 */
test.beforeEach(async ({ page }) => {
  test.skip(!ENV.user.password, 'E2E_USER_PASSWORD not set — see e2e/README.md');
  await login(page, ENV.user.email, ENV.user.password);
  await page.goto('/my');
  await expect(page.getByRole('heading', { name: /my bookings/i })).toBeVisible();
});

test('#7 booking headings are resource names, not raw UUIDs', async ({ page }) => {
  const headings = await page.locator('article h3, .my-card h3').allInnerTexts();
  for (const h of headings) {
    expect(h.trim(), `heading "${h}" looks like a raw resource UUID`).not.toMatch(UUID_RE);
  }
});

test('#11 Upcoming count excludes Cancelled / No-Show bookings', async ({ page }) => {
  // Read the "Upcoming" stat value.
  const upcomingStat = page.locator('.stat:has(small:text-matches("Upcoming", "i")) b').first();
  if (!(await upcomingStat.count())) test.skip(true, 'no bookings present to assert against');
  const upcomingCount = parseInt((await upcomingStat.innerText()).trim() || '0', 10);

  // Open the Upcoming tab and count cards that are Cancelled/No-Show.
  await page.getByRole('button', { name: /upcoming/i }).first().click();
  const cards = page.locator('article, .my-card');
  const n = await cards.count();
  let cancelledInUpcoming = 0;
  for (let i = 0; i < n; i++) {
    const txt = (await cards.nth(i).innerText()).toLowerCase();
    if (txt.includes('cancelled') || txt.includes('no show') || txt.includes('no-show')) cancelledInUpcoming++;
  }
  expect(cancelledInUpcoming, 'cancelled/no-show bookings must not appear in the Upcoming tab').toBe(0);

  // And the number of cards shown in the Upcoming tab matches the stat.
  expect(n).toBe(upcomingCount);
});

test('Booking requiring approval appears in Pending tab', async ({ page }) => {
  const bookingTitle = `E2E-Pending-Test-${Date.now()}`;
  await createBooking(page, {
    title: bookingTitle,
    resourceName: 'FSD Conf Room', // Assumes this room requires approval
    date: isoDate(7),
    start: '12:00',
  });

  await page.goto('/my');
  await page.getByRole('button', { name: /pending/i }).first().click();
  const pendingCard = page.locator(`article:has-text("${bookingTitle}")`).first();
  await expect(pendingCard).toBeVisible();
  await expect(pendingCard.getByText(/pending/i)).toBeVisible();
});
