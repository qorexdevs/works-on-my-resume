/**
 * a11y.spec.ts — axe-core accessibility gate (#111).
 *
 * Drives axe-core through Playwright against the canonical interactive states
 * of the studio. Fails the suite on any `serious` or `critical` violation.
 * `moderate` and `minor` results are logged but not asserted on — we tighten
 * those gates in follow-up issues, not in the bootstrap commit.
 *
 * States covered:
 *   1. Empty studio (initial load, no resume).
 *   2. Bundled sample loaded.
 *   3. Theme picker open.
 *   4. Tailor disclosure (#91) expanded.
 *   5. Page-fit popover (#92) open.
 *   6. Snapshots menu (#94) open.
 *   7. (Stretch) themed sample under `emulateMedia({ media: 'print' })`.
 *
 * Performance budget: each axe run should complete in well under the
 * 30 s spec timeout — typical run is ~1–3 s.
 */
import { test, expect } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import type { Result } from 'axe-core';
import {
  clearAppStorage,
  expandMobileEditor,
  loadSampleResume,
  openMobileMoreMenu,
  openSettingsDrawer,
  openThemePickerReady,
  waitForThemesReady,
} from './helpers';

/**
 * Run axe and assert zero `serious` or `critical` violations for the named
 * state. Logs the full breakdown so failing CI gives an actionable summary
 * without needing the HTML report.
 */
async function expectNoSeriousOrCritical(
  page: import('@playwright/test').Page,
  stateLabel: string,
  disabledRules: readonly string[] = [],
): Promise<void> {
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
  if (disabledRules.length > 0) {
    builder = builder.disableRules([...disabledRules]);
  }
  const results = await builder.analyze();

  const violations: Result[] = results.violations;
  const blocking = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const moderate = violations.filter((v) => v.impact === 'moderate' || v.impact === 'minor');

  // Log the full picture for the state. Moderate/minor land in the console
  // only — we don't fail on them yet (see #111). Blocking findings are
  // surfaced both in the log and in the assertion message.
  console.log(
    `[a11y:${stateLabel}] passes=${results.passes.length} ` +
      `violations=${violations.length} ` +
      `(serious/critical=${blocking.length}, moderate/minor=${moderate.length}) ` +
      `incomplete=${results.incomplete.length}`,
  );
  for (const v of moderate) {
    console.log(
      `  [moderate/minor] ${v.id} (${v.impact}) — ${v.nodes[0]?.target?.join(' ') ?? '?'}`,
    );
  }

  if (blocking.length > 0) {
    const summary = blocking
      .map(
        (v) =>
          `  - ${v.id} [${v.impact}] target=${v.nodes[0]?.target?.join(' ') ?? '?'}\n` +
          `    help: ${v.help}`,
      )
      .join('\n');
    // Surface the violation summary in the failure message so CI logs alone
    // tell a maintainer what broke.
    expect(
      blocking,
      `a11y violations (serious/critical) in state "${stateLabel}":\n${summary}`,
    ).toEqual([]);
  }
}

test.beforeEach(async ({ page }) => {
  await clearAppStorage(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('');
});

test('empty studio has no serious or critical a11y violations', async ({ page }) => {
  // Wait for the studio to mount. The "Load sample" button is the canonical
  // empty-state affordance; once it's visible the React tree has hydrated.
  await expect(page.getByRole('button', { name: /load sample/i })).toBeVisible();
  await expectNoSeriousOrCritical(page, 'empty');
});

test('bundled sample loaded has no serious or critical a11y violations', async ({ page }) => {
  await loadSampleResume(page);
  await waitForThemesReady(page);
  await expectNoSeriousOrCritical(page, 'sample-loaded');
});

test('theme picker open has no serious or critical a11y violations', async ({ page }) => {
  await loadSampleResume(page);
  await openThemePickerReady(page);
  // Confirm the popover is in the DOM before scanning so axe sees it.
  await expect(page.getByRole('dialog', { name: /choose a theme/i })).toBeVisible();
  await expectNoSeriousOrCritical(page, 'theme-picker-open');
});

test('tailor disclosure open has no serious or critical a11y violations', async ({ page }) => {
  await loadSampleResume(page);
  await expandMobileEditor(page);

  const tailor = page.locator('details.tailor');
  await expect(tailor).toHaveCount(1);
  await tailor.locator('summary').click();
  await expect(tailor).toHaveAttribute('open', '');
  await expect(tailor.getByLabel(/paste a job description/i)).toBeVisible();

  await expectNoSeriousOrCritical(page, 'tailor-open');
});

test('page-fit popover open has no serious or critical a11y violations', async ({ page }) => {
  await loadSampleResume(page);

  // Mobile (#131): the page-fit pill collapses behind the More menu —
  // open the drawer first when the pill isn't immediately visible.
  const pill = page.locator('.page-fit__pill');
  if (!(await pill.isVisible())) {
    await openMobileMoreMenu(page);
  }
  await expect(pill).toBeVisible();
  await pill.click();
  await expect(page.getByRole('dialog', { name: /page fit details/i })).toBeVisible();

  await expectNoSeriousOrCritical(page, 'page-fit-popover-open');
});

test('snapshots menu open has no serious or critical a11y violations', async ({ page }) => {
  await loadSampleResume(page);
  await expandMobileEditor(page);

  // Snapshots are gated behind the "Remember this resume on this device"
  // toggle (#32 / #94). Enable it so the trigger is interactive.
  await page.locator('.studio__draft-toggle input[type="checkbox"]').check();

  // #128: Snapshots live inside the Settings drawer now. Open the drawer
  // so the SnapshotsMenu is reachable.
  await openSettingsDrawer(page);

  // Match either of the two trigger labels SnapshotsMenu exposes — the
  // legacy `Snapshots (0)` form and the zero-state `Save snapshot` form
  // introduced by #112. Whichever is the committed UI when this lands,
  // the spec finds it without needing to be re-pinned.
  const trigger = page
    .getByRole('button', { name: 'Save snapshot', exact: true })
    .or(page.getByRole('button', { name: /Snapshots \(0\)/i }))
    .first();
  await trigger.click();
  await expect(page.getByRole('dialog', { name: /Save snapshot/i })).toBeVisible();

  await expectNoSeriousOrCritical(page, 'snapshots-menu-open');
});

test('themed sample under print media has no serious or critical a11y violations', async ({
  page,
}) => {
  // Stretch goal: catch print-only contrast regressions. We pick a high-
  // saturation theme so any print stylesheet that drops a background but
  // keeps a light foreground (or vice-versa) would surface as a color-
  // contrast violation. The exact slug ("popping-and-locking") is one of
  // the bundled OKLCH themes shipped with the project.
  await page.goto('?theme=popping-and-locking&layout=modern');
  await loadSampleResume(page);
  await waitForThemesReady(page);

  // Switch to print media emulation so axe evaluates the printed appearance.
  await page.emulateMedia({ media: 'print' });

  // Fixed in #113 — em/i are now pinned to #222 (~16:1 on white) in
  // conservative print regardless of the active theme, so `color-contrast`
  // is back in the active rule set for the print-themed gate.
  await expectNoSeriousOrCritical(page, 'print-themed');

  // Restore default media so the after-test teardown is consistent with
  // every other spec — Playwright re-uses pages within a worker.
  await page.emulateMedia({ media: null });
});
