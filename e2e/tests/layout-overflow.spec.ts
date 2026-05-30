import { test, expect } from '@playwright/test';
import { ALL_ROUTES, gotoSettled, stableOverflow, overflowingElements } from './helpers';

/**
 * Layout integrity — catches the "look & view" defects: content that spills
 * past the viewport, tables/charts that force a horizontal scrollbar on the
 * whole page, or rows wider than the window. A small tolerance absorbs
 * sub-pixel rounding; intentional inner scrollers (charts, tables) are fine
 * because we measure the *document*, not those scoped containers.
 */
test.use({ viewport: { width: 1440, height: 900 } });

for (const route of ALL_ROUTES) {
  test(`layout: ${route.name} has no page-level horizontal overflow`, async ({ page }) => {
    await gotoSettled(page, route.path);

    const overflow = await stableOverflow(page);
    if (overflow > 4) {
      // Surface the offending elements in the failure message for fast triage.
      const culprits = await overflowingElements(page);
      const detail = culprits.map((c) => `<${c.tag} class="${c.cls}"> right=${c.right}px "${c.text}"`).join('\n  ');
      expect(overflow, `${route.path} overflows the viewport by ${overflow}px. Offenders:\n  ${detail}`).toBeLessThanOrEqual(4);
    }
  });
}
