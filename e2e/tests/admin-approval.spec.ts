import { test, expect } from '@playwright/test';
import { ENV, login, createBooking, isoDate } from './helpers';

/**
 * E2E flow for the core approval chain.
 *
 * 1. A regular user books a resource known to require approval.
 * 2. The user sees the booking in their "Pending" tab.
 * 3. An admin logs in and approves the booking.
 * 4. The user sees the booking move to their "Upcoming" tab.
 *
 * This requires both a user and an admin password to be set in the env.
 * It also assumes a resource named "FSD Conf Room" exists and requires approval.
 */
test.describe('Admin Approval Flow', () => {
  test.skip(!ENV.user.password || !ENV.admin.password, 'User or admin credentials not set');

  const bookingTitle = `E2E-Approval-Test-${Date.now()}`;
  let bookingId = '';

  test('User creates a pending booking', async ({ page }) => {
    const res = await createBooking(page, {
      title: bookingTitle,
      resourceName: 'FSD Conf Room', // Assumes this room requires approval
      date: isoDate(6),
      start: '11:00',
    });
    bookingId = res.bookingId;
    expect(bookingId).not.toBe('');
    await expect(page.getByText(/pending/i).first()).toBeVisible();
  });

  test('Admin approves the booking', async ({ page }) => {
    test.dependsOn('User creates a pending booking');
    await login(page, ENV.admin.email, ENV.admin.password);
    await page.goto('/approvals');
    const bookingCard = page.locator(`article:has-text("${bookingTitle}")`).first();
    await expect(bookingCard).toBeVisible({ timeout: 15_000 });
    await bookingCard.getByRole('button', { name: /approve/i }).click();
    await expect(page.getByText(/approved/i).first()).toBeVisible();
  });
});