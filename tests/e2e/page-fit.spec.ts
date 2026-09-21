/**
 * page-fit.spec.ts — coverage for the page-fit indicator (#92).
 *
 * Asserts:
 *   - The toolbar pill appears once a resume is loaded, and shows a sensible
 *     label (either "Fits 1 page" or "Fit: N.N pages").
 *   - Clicking the pill opens a popover with a section breakdown and the
 *     "Approximate — based on screen rendering" hint.
 *   - Toggling the ruler checkbox mounts (and unmounts) the page-break
 *     overlay inside the preview pane.
 *   - Closing the popover via Esc returns focus to the pill.
 *
 * The estimate itself is approximate — we don't assert a specific page count,
 * only that the label matches one of the two known shapes.
 */
import { test, expect } from '@playwright/test';
import { clearAppStorage, loadSampleResume, openMobileMoreMenu } from './helpers';

test.beforeEach(async ({ page }) => {
  await clearAppStorage(page);
  await page.goto('');
});

/**
 * Reveal the page-fit pill in the toolbar. On desktop it's inline; on
 * mobile (#131) it collapses behind the More menu, so we open the drawer
 * first when the pill isn't immediately visible. Idempotent.
 */
async function revealPageFitPill(page: import('@playwright/test').Page) {
  const pill = page.locator('.page-fit__pill');
  if (!(await pill.isVisible())) {
    await openMobileMoreMenu(page);
  }
  await expect(pill).toBeVisible();
  return pill;
}

test('page-fit pill appears in Phase 2 and reports a page estimate', async ({ page }) => {
  await loadSampleResume(page);

  const pill = await revealPageFitPill(page);

  // Either "Fits 1 page" or "Fit: N.N pages" — the exact value depends on
  // viewport + fonts + theme, so match the shape rather than a literal.
  await expect(pill).toHaveText(/Fits 1 page|Fit: \d\.\d pages/);
});

test('page-fit estimate for the bundled sample is in the right ballpark (#107)', async ({
  page,
}, testInfo) => {
  // Regression test for #107: before the print-width scaling fix the bundled
  // sample reported ~5.2 pages because the preview pane is narrower than the
  // actual printed content width. After the fix, the sample should read as
  // either "Fits 1 page" or a low-decimal multi-page estimate well under the
  // original 5.2-page miscount.
  //
  // We assert on the shape AND on the numeric value when a decimal is
  // present. The "right ballpark" tolerance is deliberately generous — the
  // exact number drifts with viewport, fonts, theme; the bug was a 2-3×
  // over-estimate, not a 10% one. Mobile gets a looser ceiling because at
  // ~360px the print-width scale factor clamps at 0.5, so it can't drop the
  // estimate as far as a wider desktop preview can.
  await loadSampleResume(page);

  const pill = await revealPageFitPill(page);

  const text = (await pill.textContent())?.trim() ?? '';

  // Accept "Fits 1 page" outright — that's the happiest outcome.
  if (text === 'Fits 1 page') return;

  // Otherwise it must be "Fit: N.N pages" with N.N ≤ ceiling for the project.
  const isMobile = testInfo.project.name.includes('mobile');
  const ceiling = isMobile ? 3.0 : 2.5;
  const match = text.match(/^Fit:\s+(\d+\.\d)\s+pages$/);
  expect(match, `unexpected page-fit pill text: ${text}`).not.toBeNull();
  const pages = Number(match![1]);
  expect(
    pages,
    `bundled sample is reporting ${pages} pages; #107 expected ≤ ${ceiling} after print-width scaling`,
  ).toBeLessThanOrEqual(ceiling);
});

test('clicking the pill opens a popover with section heights and the approximate-render hint', async ({
  page,
}) => {
  await loadSampleResume(page);

  const pill = await revealPageFitPill(page);
  await pill.click();

  const popover = page.getByRole('dialog', { name: /page fit details/i });
  await expect(popover).toBeVisible();
  await expect(popover.getByText(/approximate — based on screen rendering/i)).toBeVisible();
  // The per-section list mounts whenever the preview has any `<h2>` —
  // the bundled sample resume has several.
  await expect(popover.getByText(/per-section share/i)).toBeVisible();
});

test('toggling the ruler shows then hides page-break lines on the preview', async ({ page }) => {
  await loadSampleResume(page);

  const pill = await revealPageFitPill(page);
  await pill.click();
  const popover = page.getByRole('dialog', { name: /page fit details/i });

  // Ruler off by default — no overlay in the DOM.
  await expect(page.locator('.page-fit-ruler')).toHaveCount(0);

  // The ruler-toggle row can sit below the viewport on the mobile project
  // (the popover is taller than 200px). Scroll it into view before
  // clicking; `.check()` reports "element outside viewport" otherwise.
  const rulerToggle = popover.getByLabel(/show page-break ruler/i);
  await rulerToggle.scrollIntoViewIfNeeded();
  await rulerToggle.check();

  // Overlay appears in the preview pane. The sample resume is short enough
  // that it may fit a single page (zero ruler lines), so we assert the
  // overlay's PRESENCE rather than the line count — the toggle wiring is
  // what matters here.
  await expect(page.locator('.page-fit-ruler')).toHaveCount(1);

  await rulerToggle.uncheck();
  await expect(page.locator('.page-fit-ruler')).toHaveCount(0);
});

test('chip renders the print-mode label next to the Fit value (#139)', async ({ page }) => {
  // The hidden-state hazard #139 closes by surfacing the print mode as a
  // visible segment of the chip. Once a resume is loaded, the chip should
  // expose a print-mode <select> whose value is the current mode.
  await loadSampleResume(page);
  await revealPageFitPill(page);

  const modeSelect = page.locator('.page-fit__mode-select');
  await expect(modeSelect).toBeVisible();
  // Default print mode is `conservative` (set in ResumeStudio).
  await expect(modeSelect).toHaveValue('conservative');
  // The chip's accessible label spells out that the choice affects both the
  // print path and the Fit estimate — the whole point of pulling the
  // toggle out of the hidden Export panel.
  await expect(modeSelect).toHaveAccessibleName(/print mode/i);
});

test('selecting Themed in the chip flips body[data-print-mode] (#139)', async ({ page }) => {
  // The chip is now the primary surface for the print mode. The Export
  // panel's radio remains as a redundant mirror, but a user should be able
  // to flip the mode without ever opening Export.
  await loadSampleResume(page);
  await revealPageFitPill(page);

  const modeSelect = page.locator('.page-fit__mode-select');
  await modeSelect.selectOption('theme');
  await expect.poll(async () => page.evaluate(() => document.body.dataset.printMode)).toBe('theme');

  // Pick Conservative — the body attribute follows.
  await modeSelect.selectOption('conservative');
  await expect
    .poll(async () => page.evaluate(() => document.body.dataset.printMode))
    .toBe('conservative');
});

test('pressing Escape closes the popover and returns focus to the pill', async ({ page }) => {
  await loadSampleResume(page);

  const pill = await revealPageFitPill(page);
  await pill.click();

  const popover = page.getByRole('dialog', { name: /page fit details/i });
  await expect(popover).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);

  // Focus is back on the pill so keyboard users aren't stranded.
  await expect(pill).toBeFocused();
});
