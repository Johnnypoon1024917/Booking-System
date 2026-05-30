import { Page, expect, Response } from '@playwright/test';

/**
 * Shared E2E helpers.
 *
 * Credentials/targets come from env so nothing is hard-coded. Defaults match
 * the dev stack's built-in admin (tenant `default`, admin/admin) so the
 * UI/UX quality suite runs out-of-the-box against `fsd-v2/docker-compose up`.
 * Heavier user-flow booking tests still skip unless E2E_USER_PASSWORD is set.
 */
export const ENV = {
  tenant: process.env.E2E_TENANT || 'default',
  admin: {
    // The base SeederService creates `admin` with password `admin` (NOT the
    // demo password). The demo seed's DEMO_PASSWORD applies to the other named
    // accounts (officer/roomadmin/secretary/secadmin). Override via env.
    email: process.env.E2E_ADMIN_EMAIL || 'admin',
    password: process.env.E2E_ADMIN_PASSWORD ?? 'admin',
  },
  user: {
    // officer (General User) is a demo-seed account → DEMO_PASSWORD ("password").
    email: process.env.E2E_USER_EMAIL || 'officer',
    password: process.env.E2E_USER_PASSWORD || '',
  },
  location: process.env.E2E_LOCATION || 'Hong Kong',
};

/** Where the authenticated admin session is cached by auth.setup.ts. */
export const ADMIN_STATE = 'playwright/.auth/admin.json';

/** UUID v4-ish matcher — used to assert headings are NOT raw resource ids (#7). */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Authenticated routes worth covering for UI/UX quality. `admin` routes need
 * an admin/manager/secretary role (the cached session is admin, so all load).
 */
export type Route = { path: string; name: string; admin?: boolean };

export const USER_ROUTES: Route[] = [
  { path: '/',          name: 'Dashboard' },
  { path: '/search',    name: 'Search' },
  { path: '/calendar',  name: 'Calendar' },
  { path: '/my',        name: 'My Bookings' },
  { path: '/approvals', name: 'Approvals' },
  { path: '/profile',   name: 'Profile' },
  { path: '/settings',  name: 'Settings' },
];

export const ADMIN_ROUTES: Route[] = [
  { path: '/admin/users',          name: 'Admin · Users', admin: true },
  { path: '/admin/resources',      name: 'Admin · Resources', admin: true },
  { path: '/admin/bookings',       name: 'Admin · Bookings', admin: true },
  { path: '/admin/departments',    name: 'Admin · Departments', admin: true },
  { path: '/admin/reports',        name: 'Admin · Reports', admin: true },
  { path: '/admin/approval-chain', name: 'Admin · Approval Chain', admin: true },
  { path: '/admin/permissions',    name: 'Admin · Permissions', admin: true },
  { path: '/admin/broadcasts',     name: 'Admin · Broadcasts', admin: true },
  { path: '/admin/holidays',       name: 'Admin · Holidays', admin: true },
  { path: '/admin/locations',      name: 'Admin · Locations', admin: true },
  { path: '/admin/location-groups',name: 'Admin · Location Groups', admin: true },
  { path: '/admin/resource-types', name: 'Admin · Resource Types', admin: true },
  { path: '/admin/services',       name: 'Admin · Services', admin: true },
  { path: '/admin/studio',         name: 'Admin · Tenant Studio', admin: true },
  { path: '/admin/integrations',   name: 'Admin · Integrations', admin: true },
  { path: '/admin/webhooks',       name: 'Admin · Webhooks', admin: true },
  { path: '/admin/scim',           name: 'Admin · SCIM', admin: true },
  { path: '/admin/floor-plans',    name: 'Admin · Floor Plans', admin: true },
  { path: '/admin/sensors',        name: 'Admin · Sensors', admin: true },
  { path: '/admin/visitors',       name: 'Admin · Visitors', admin: true },
  { path: '/admin/invoices',       name: 'Admin · Invoices', admin: true },
];

export const ALL_ROUTES: Route[] = [...USER_ROUTES, ...ADMIN_ROUTES];

/**
 * Log in via the SPA form. Stack-aware: the Node/React form has tenant +
 * username + password (labels), the Go/Vue form may use email. Fields are
 * found by label/type with positional fallbacks so it survives both.
 */
export async function login(page: Page, username: string, password: string, tenant = ENV.tenant) {
  await page.goto('/login');
  // Already authenticated (cached state) → the app bounces us off /login.
  if (!/\/login/i.test(page.url())) return;

  const tenantField = page.getByLabel(/tenant/i).first();
  if (await tenantField.count()) {
    await tenantField.fill(tenant);
  }

  // Username (React) or email (Vue). Fall back to the first non-password,
  // non-tenant text input in the login card.
  let userField = page.getByLabel(/user ?name|email/i).first();
  if (!(await userField.count())) {
    userField = page.locator(
      '.login-card input:not([type="password"]), form input:not([type="password"])',
    ).nth(await tenantField.count() ? 1 : 0);
  }
  await userField.waitFor({ state: 'visible' });
  await userField.fill(username);

  await page.locator('input[type="password"]').first().fill(password);
  await page.getByRole('button', { name: /sign in|log ?in|continue/i }).first().click();

  // Land on an authenticated view (anything that isn't /login).
  await expect(page, 'login should leave the /login route').not.toHaveURL(/\/login/i, { timeout: 15_000 });
}

/**
 * Creates a booking via the search UI. Assumes user is already logged in.
 * Returns the booking ID from the success message.
 */
export async function createBooking(
  page: Page,
  opts: { title: string; resourceName: string; date: string; start: string },
): Promise<{ bookingId: string }> {
  await page.goto('/search');
  await expect(page.getByRole('heading', { name: /booking|search/i }).first()).toBeVisible();

  await setField(page, ['input[type="date"]'], opts.date);
  await setField(page, ['input[name="start"]', 'input[type="time"]'], opts.start);
  await page.getByRole('button', { name: /search/i }).first().click();

  const roomResult = page.locator(`label:has-text("${opts.resourceName}")`).first();
  await expect(roomResult, `Room "${opts.resourceName}" not found in search results`).toBeVisible({
    timeout: 15_000,
  });

  await roomResult.click();
  await page.getByRole('button', { name: /confirm|reserve|book/i }).first().click();

  // Fill the required title in the confirm modal, then submit.
  await setField(page, ['input[placeholder*="Sync" i]', 'label:has-text("Title") input'], opts.title);
  await page.getByRole('button', { name: /submit|confirm booking/i }).first().click();

  const successToast = page.locator('text=/confirmed|submitted|pending|id=/i').first();
  await expect(successToast).toBeVisible({ timeout: 15_000 });

  // Extract booking ID from toast, e.g., "Booked! id=some-uuid"
  const toastText = await successToast.innerText();
  const idMatch = toastText.match(/id=([a-f0-9-]+)/i);
  return {
    bookingId: idMatch ? idMatch[1] : '',
  };
}

/** YYYY-MM-DD for `daysFromNow` (local), used to drive date inputs. */
export function isoDate(daysFromNow = 1): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

/** Fill a labelled or placeholder-identified text/date/time input if present. */
export async function setField(page: Page, selectors: string[], value: string) {
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if (await el.count()) {
      await el.fill(value);
      return true;
    }
  }
  return false;
}

/* ============================================================================
   UI/UX quality utilities
   ============================================================================ */

/**
 * Console-error / page-error / failed-network collector. Attach BEFORE the
 * navigation you want to audit. Benign noise (favicons, source maps, fonts,
 * ResizeObserver, dev HMR, optional weather endpoint) is filtered out so a
 * failure means a real defect.
 */
export type PageHealth = {
  consoleErrors: string[];
  pageErrors: string[];
  failedResponses: string[];
};

// Browser/dev noise that never indicates a product defect.
const IGNORE_URL_BASE = /favicon|\.map(\?|$)|hot-update|@vite|\/__|fonts?\.|\.woff2?/i;
// Optional, gracefully-degraded backend calls. The tenant store and weather
// widget both wrap these in try/catch and fall back, so a 4xx here does not
// break the page. They are TOLERATED by the health gate but reported in the
// suite README as findings to verify against a fresh build. 5xx on these still
// fails (that's a server crash, not graceful degradation).
const TOLERATED_4XX =
  /\/api\/v1\/weather\b|\/api\/v1\/customization\/effective\b|\/api\/v1\/tenants\/me\/customization\b/i;
const IGNORE_MSG =
  /ResizeObserver loop|favicon|Download the React DevTools|\[vite\]|sourcemap|net::ERR_ABORTED.*\.map/i;

export function collectHealth(page: Page): PageHealth {
  const health: PageHealth = { consoleErrors: [], pageErrors: [], failedResponses: [] };
  page.on('console', (m) => {
    if (m.type() === 'error' && !IGNORE_MSG.test(m.text())) health.consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => {
    if (!IGNORE_MSG.test(e.message)) health.pageErrors.push(e.message);
  });
  page.on('response', (r: Response) => {
    const s = r.status();
    const url = r.url();
    if (s < 400 || IGNORE_URL_BASE.test(url)) return;
    // Tolerate documented optional 4xx; still fail on 5xx (server error).
    if (s < 500 && TOLERATED_4XX.test(url)) return;
    health.failedResponses.push(`${s} ${r.request().method()} ${url}`);
  });
  return health;
}

/** Navigate and wait for the SPA to settle (network quiet + main painted). */
export async function gotoSettled(page: Page, path: string) {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  // Bounded: realtime/SSE pages hold a connection and never reach full idle.
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => { /* expected on live pages */ });
  await page.locator('main, .app-main-col, #root').first().waitFor({ state: 'visible' });
  // Wait for loading skeletons to clear — a half-loaded data grid is often
  // transiently wider than its final layout and produces false overflow.
  await page.locator('.skeleton').first().waitFor({ state: 'detached', timeout: 6_000 }).catch(() => { /* none present */ });
  // Let late renders resolve and fonts settle.
  await page.waitForTimeout(500);
  await page.evaluate(() => document.fonts?.ready).catch(() => undefined);
}

/**
 * Persistence-based horizontal overflow: a real layout defect is overflow that
 * is STILL present after the page has fully settled. We sample twice with a gap
 * and take the minimum, so a transient mid-render wide element doesn't fail the
 * gate while a genuinely overflowing layout still does.
 */
export async function stableOverflow(page: Page): Promise<number> {
  const a = await horizontalOverflow(page);
  if (a <= 4) return a;
  await page.waitForTimeout(600);
  const b = await horizontalOverflow(page);
  return Math.min(a, b);
}

/** Document-level horizontal overflow in px (0 = none). */
export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const de = document.documentElement;
    const w = Math.max(de.scrollWidth, document.body ? document.body.scrollWidth : 0);
    return Math.max(0, w - de.clientWidth);
  });
}

/** Elements whose right edge spills past the viewport — the usual culprits. */
export async function overflowingElements(page: Page, tolerance = 2) {
  return page.evaluate((tol) => {
    const vw = document.documentElement.clientWidth;
    const out: { tag: string; cls: string; right: number; text: string }[] = [];
    document.querySelectorAll('body *').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.right > vw + tol && getComputedStyle(el).position !== 'fixed') {
        out.push({
          tag: el.tagName.toLowerCase(),
          cls: (typeof el.className === 'string' ? el.className : '').slice(0, 70),
          right: Math.round(r.right),
          text: (el.textContent || '').trim().slice(0, 40),
        });
      }
    });
    // Keep the worst offenders only.
    return out.sort((a, b) => b.right - a.right).slice(0, 12);
  }, tolerance);
}

/** Visible text content of the main content area (for blank-page detection). */
export async function mainText(page: Page): Promise<string> {
  const main = page.locator('main, .app-main-col').first();
  if (!(await main.count())) return (await page.locator('body').innerText()).trim();
  return (await main.innerText()).trim();
}
