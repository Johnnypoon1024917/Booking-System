import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ALL_ROUTES, gotoSettled } from './helpers';

/**
 * Accessibility audit (axe-core, WCAG 2.1 A/AA). Enterprise procurement and
 * public-sector tenants routinely require this. We gate on serious/critical
 * violations only — colour contrast, missing form labels, ARIA misuse, image
 * alt text — so the bar is "no blocking a11y defects" rather than pixel-perfect
 * AAA. Each violation is printed with the offending selector for triage.
 */
const BLOCKING = new Set(['serious', 'critical']);

for (const route of ALL_ROUTES) {
  test(`a11y: ${route.name} has no serious/critical violations`, async ({ page }) => {
    await gotoSettled(page, route.path);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    const blocking = results.violations.filter((v) => BLOCKING.has(v.impact || ''));
    const report = blocking
      .map((v) => `[${v.impact}] ${v.id}: ${v.help}\n    nodes: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)
      .join('\n  ');

    expect(blocking.length, `${route.path} a11y violations:\n  ${report}`).toBe(0);
  });
}
