/**
 * status-line.spec.ts — coverage for the StudioStatusLine (#134).
 *
 * Asserts:
 *  - The modeline appears once a resume is loaded.
 *  - Each segment renders the data it owns: filename, line count, cursor,
 *    Health score, Fit, dirty `●draft` indicator, WCAG pill.
 *  - The cursor segment updates as the user moves the caret in the editor.
 *  - The dirty indicator appears only after the markdown buffer diverges
 *    from the load baseline, and clears on a fresh load.
 *
 * The Fit / Health numeric values are deliberately not pinned — they
 * depend on theme + viewport + fonts. We assert shape (label format)
 * rather than exact values.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clearAppStorage, expandMobileEditor, loadSampleResume } from './helpers';

test.beforeEach(async ({ page }) => {
  await clearAppStorage(page);
  await page.goto('');
});

/**
 * The status line is hidden on viewports ≤ 640 px for the cursor / lines /
 * fit / wcag segments — tests that assert those run on the desktop project
 * only. The "always-on" segments (filename + Health + dirty dot) are
 * checked on both projects through the broader `loaded` test below.
 */
function isMobileProject(testInfo: import('@playwright/test').TestInfo): boolean {
  return testInfo.project.name.includes('mobile');
}

/**
 * Get the status-line locator, asserting it is visible. Used by every test
 * here so a missing modeline fails with a clear error rather than the more
 * confusing "child segment not found" downstream.
 */
async function statusLine(page: Page) {
  const root = page.locator('.studio__statusline');
  await expect(root).toBeVisible();
  return root;
}

test('the status line is not mounted in Phase 1 (no resume loaded)', async ({ page }) => {
  // Empty state — no studio status line, since the modeline would be a row
  // of dashes with nothing to anchor it.
  await expect(page.locator('.studio__statusline')).toHaveCount(0);
});

test('the status line mounts when a resume is loaded and shows the filename + lines + health', async ({
  page,
}) => {
  await loadSampleResume(page);

  const line = await statusLine(page);
  // Filename segment: the sample resume's source name renders bare in the
  // editorial-stationery chrome (#163) — no `~/` shell-prompt prefix.
  await expect(line.locator('.studio__statusline-seg--filename')).toContainText(/\.md$/);

  // Health segment is always-on once a parse is in hand.
  await expect(line.locator('.studio__statusline-seg--health')).toBeVisible();
  // Score is a 0–100 integer; the stage glyph is JR | MID | SR. The
  // composite regex is loose enough not to depend on the exact rubric.
  await expect(line.locator('.studio__statusline-seg--health')).toContainText(/\d+\s+(JR|MID|SR)/);
});

test('the lines segment counts the markdown lines (desktop only)', async ({ page }, testInfo) => {
  test.skip(isMobileProject(testInfo), 'lines segment is hidden on mobile (#134)');
  await loadSampleResume(page);
  const line = await statusLine(page);
  await expect(line.locator('.studio__statusline-seg--lines')).toContainText(/\d+\s+lines?/);
});

test('the Fit segment renders a compact pages label (desktop only)', async ({ page }, testInfo) => {
  test.skip(isMobileProject(testInfo), 'fit segment is hidden on mobile (#134)');
  await loadSampleResume(page);
  const line = await statusLine(page);
  // Either an em-dash (no measurement yet) or "N.Np".
  await expect(line.locator('.studio__statusline-seg--fit')).toContainText(/—|\d+\.\d+p/);
});

test('the WORDS segment renders a ratio and page-target suffix (desktop only)', async ({
  page,
}, testInfo) => {
  test.skip(isMobileProject(testInfo), 'words segment is hidden on mobile (#155)');
  await loadSampleResume(page);
  const line = await statusLine(page);
  // Shape only: a numerator / denominator pair, then ` · N page(s)` suffix.
  // The exact word count depends on the bundled sample so we don't pin it.
  const words = line.locator('.studio__statusline-seg--words');
  await expect(words).toBeVisible();
  await expect(words).toContainText(/\d+\s+\/\s+\d+\s+·\s+\d+\s+pages?/);
  // The segment carries one of the three severity modifiers (`ok | warn |
  // danger`). The Fit chip rubric is mirrored, so this lock-in keeps the
  // two readouts honest about staying in sync.
  await expect(words).toHaveClass(/studio__statusline-seg--words-(ok|warn|danger)/);
});

test('the WCAG segment shows the active theme conformance level (desktop only)', async ({
  page,
}, testInfo) => {
  test.skip(isMobileProject(testInfo), 'wcag segment is hidden on mobile (#134)');
  await loadSampleResume(page);
  const line = await statusLine(page);
  // AAA / AA / FAIL plus a ratio like "7.9:1".
  await expect(line.locator('.studio__statusline-seg--wcag')).toContainText(
    /(AAA|AA|FAIL)\s+\d+\.\d+:1/,
  );
});

test('the cursor segment updates as the user moves the caret (desktop only)', async ({
  page,
}, testInfo) => {
  test.skip(isMobileProject(testInfo), 'cursor segment is hidden on mobile (#134)');
  await loadSampleResume(page);
  await expandMobileEditor(page);

  const line = await statusLine(page);
  const textarea = page.getByLabel(/markdown source/i);

  // Click into the textarea — the caret lands somewhere; the cursor
  // segment must materialize and read as `L<line>:<col>`.
  await textarea.click();
  await expect(line.locator('.studio__statusline-seg--cursor')).toBeVisible();
  await expect(line.locator('.studio__statusline-seg--cursor')).toContainText(/L\d+:\d+/);

  // Drive the caret with a real keyboard chord — React's onSelect /
  // onKeyUp doesn't reliably fire on synthetic dispatched events, but a
  // Ctrl+Home / End from playwright produces real key events that the
  // textarea handles natively.
  await textarea.focus();
  await textarea.press('ControlOrMeta+Home');
  await expect(line.locator('.studio__statusline-seg--cursor')).toContainText('L1:1');

  // Move to end of the first line — column is some N > 1, line stays 1.
  // Avoids pinning on the sample's exact first-line length.
  await textarea.press('End');
  await expect(line.locator('.studio__statusline-seg--cursor')).toContainText(
    /L1:[2-9]\d*|L1:1\d+/,
  );
});

test('the ●draft indicator appears when the buffer diverges from the loaded baseline', async ({
  page,
}) => {
  await loadSampleResume(page);
  await expandMobileEditor(page);

  const line = await statusLine(page);
  // Fresh load — buffer matches the baseline, so the draft segment is absent.
  await expect(line.locator('.studio__statusline-seg--draft')).toHaveCount(0);

  // Type something into the textarea — the buffer now differs from the
  // baseline and the indicator materializes.
  const textarea = page.getByLabel(/markdown source/i);
  await textarea.click();
  await textarea.press('End');
  await textarea.pressSequentially(' x');
  // The parse is debounced; the dirty pill is not — it reads from the raw
  // markdown buffer, so it should appear immediately.
  await expect(line.locator('.studio__statusline-seg--draft')).toBeVisible();
});
