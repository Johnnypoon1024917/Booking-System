import { test, expect } from '@playwright/test';
import { USER_ROUTES, gotoSettled, stableOverflow, overflowingElements, mainText } from './helpers';

/**
 * Responsive behaviour across the three breakpoints a booking system is
 * actually used at: phone (kiosk/on-the-go booking), tablet (front desk),
 * laptop. The app must not produce a horizontal scrollbar at any width and
 * must still render content. We focus on the primary user journeys (admin
 * data grids are desktop-first by design).
 */
const VIEWPORTS = [
  { name: 'mobile',  width: 375,  height: 812 },
  { name: 'tablet',  width: 768,  height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
];

for (const vp of VIEWPORTS) {
  test.describe(`${vp.name} (${vp.width}px)`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    for (const route of USER_ROUTES) {
      test(`${route.name} fits ${vp.name} with no horizontal scroll`, async ({ page }) => {
        await gotoSettled(page, route.path);

        // Content still present at this width.
        expect((await mainText(page)).length, `${route.path} blank at ${vp.width}px`).toBeGreaterThan(10);

        const overflow = await stableOverflow(page);
        if (overflow > 4) {
          const culprits = await overflowingElements(page);
          const detail = culprits.map((c) => `<${c.tag} class="${c.cls}"> right=${c.right}px`).join('\n  ');
          expect(overflow, `${route.path} overflows by ${overflow}px at ${vp.width}px. Offenders:\n  ${detail}`).toBeLessThanOrEqual(4);
        }
      });
    }
  });
}
