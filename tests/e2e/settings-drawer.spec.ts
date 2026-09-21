/**
 * settings-drawer.spec.ts — the right-anchored Settings drawer (#128).
 *
 * The drawer consolidates four pieces of UI that used to live as separate
 * toolbar islands:
 *   - ATS preview toggle (#31)
 *   - Resume version snapshots dropdown (#94)
 *   - Single-keyboard-shortcut help affordance (#99)
 *   - Keyboard-shortcuts help icon (#58)
 *
 * The trigger is the gear icon at the rightmost slot of toolbar Row 2.
 * Behavior under test:
 *   1. The gear opens the drawer; the drawer mounts the four documented
 *      section groups (Workspace / Snapshots / Theme nav / Help) and the
 *      controls that were absorbed are reachable inside.
 *   2. Escape closes the drawer; focus returns to the gear.
 *   3. Click-outside closes the drawer.
 */
import { test, expect } from '@playwright/test';
import { clearAppStorage, loadSampleResume, openSettingsDrawer } from './helpers';

test.beforeEach(async ({ page }) => {
  await clearAppStorage(page);
  await page.goto('');
  await loadSampleResume(page);
});

test('the gear opens a drawer with the four documented section groups', async ({ page }) => {
  await openSettingsDrawer(page);

  const drawer = page.getByRole('dialog', { name: /^settings$/i });

  // The four group headings — small-caps kickers via .section-kicker.
  await expect(drawer.getByRole('heading', { name: /^workspace$/i })).toBeVisible();
  await expect(drawer.getByRole('heading', { name: /^snapshots$/i })).toBeVisible();
  await expect(drawer.getByRole('heading', { name: /^theme nav$/i })).toBeVisible();
  await expect(drawer.getByRole('heading', { name: /^help$/i })).toBeVisible();

  // ATS toggle reachable inside (role=switch, the contract the old
  // toolbar AtsModeToggle exposed).
  await expect(drawer.getByRole('switch', { name: /ats preview/i })).toBeVisible();

  // Snapshots affordance present (gated off by default — disabled trigger
  // reads as "Save snapshot" with the privacy hint in its aria-label).
  await expect(drawer.getByRole('button', { name: /save snapshot/i })).toBeVisible();

  // Theme nav buttons are reachable from the drawer.
  await expect(drawer.getByRole('button', { name: /previous theme/i })).toBeVisible();
  await expect(drawer.getByRole('button', { name: /next theme/i })).toBeVisible();
  await expect(drawer.getByRole('button', { name: /random theme/i })).toBeVisible();

  // The shortcut legend lives in the Help group as a list of <kbd> rows.
  await expect(drawer.getByText(/previous \/ next theme/i)).toBeVisible();
  await expect(drawer.getByText(/random theme/i).first()).toBeVisible();

  // The full-keyboard-help dialog is still reachable from inside the drawer.
  await expect(
    drawer.getByRole('button', { name: /open the full shortcuts dialog/i }),
  ).toBeVisible();
});

test('Escape closes the drawer and restores focus to the gear button', async ({ page }) => {
  await openSettingsDrawer(page);
  const drawer = page.getByRole('dialog', { name: /^settings$/i });
  await expect(drawer).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);

  // Focus returns to the gear button — keyboard users land where they
  // opened it from.
  await expect(page.getByRole('button', { name: /open settings/i })).toBeFocused();
});

test('click-outside the drawer dismisses it', async ({ page }, testInfo) => {
  // On mobile the drawer takes width: 100vw — there is no visible overlay
  // strip to click. Esc / close button / a back-gesture are the dismiss
  // paths there (covered by the Escape spec above). The click-outside
  // affordance is a desktop concern.
  test.skip(
    testInfo.project.name === 'mobile-iphone-13',
    'drawer fills the viewport on mobile — no overlay strip to click',
  );

  await openSettingsDrawer(page);
  const drawer = page.getByRole('dialog', { name: /^settings$/i });
  await expect(drawer).toBeVisible();

  // Click on the overlay (outside the drawer pane). The drawer pane sits
  // on the right edge; clicking the leftmost edge of the overlay is a
  // safe click-outside target.
  await page.locator('.settings-drawer__overlay').click({ position: { x: 10, y: 200 } });
  await expect(drawer).toHaveCount(0);
});

/* ----------------------------------------------------------------------- *
 * Markdown format reference dialog (#157)                                  *
 *                                                                          *
 * The drawer's Help section gains a "Markdown format" button that opens    *
 * a small modal documenting the frontmatter contract, canonical sections,  *
 * an LLM-handoff prompt with a copy-to-clipboard button, and the privacy   *
 * one-liner. The handoff mirrors the keyboard-shortcuts button: clicking   *
 * closes the drawer first and opens the dialog on a clean stage, so the    *
 * two modals never overlap.                                                *
 * ----------------------------------------------------------------------- */
test('Help → Markdown format opens the format reference dialog', async ({ page }) => {
  await openSettingsDrawer(page);
  const drawer = page.getByRole('dialog', { name: /^settings$/i });
  await expect(drawer).toBeVisible();

  // The "Markdown format" button sits in the Help section, beside the
  // existing "Open the full shortcuts dialog" button. Click it and the
  // drawer must close before the modal lands (the handoff pattern).
  await page.getByRole('button', { name: /markdown format/i }).click();
  await expect(drawer).toHaveCount(0);

  const dialog = page.getByRole('dialog', { name: /^markdown format$/i });
  await expect(dialog).toBeVisible();

  // Every documented section is reachable inside the dialog.
  await expect(dialog.getByRole('heading', { name: /^frontmatter$/i })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: /^sections$/i })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: /^llm handoff$/i })).toBeVisible();

  // The four canonical Resume Health sections are listed by name.
  await expect(dialog.getByText('Summary', { exact: false }).first()).toBeVisible();
  await expect(dialog.getByText('Experience', { exact: false }).first()).toBeVisible();
  await expect(dialog.getByText('Education', { exact: false }).first()).toBeVisible();
  await expect(dialog.getByText('Skills', { exact: false }).first()).toBeVisible();

  // The LLM-handoff prompt sits in a <pre> and is the literal string the
  // user will paste. We assert on the unique prefix rather than the full
  // body — the body contains a YAML scaffold and a [paste your resume
  // here] placeholder, but the prefix is the contract that matters.
  const prompt = dialog.getByLabel('LLM handoff prompt');
  await expect(prompt).toContainText(/^Here's my resume in Works on My Resume markdown format\./);
  await expect(prompt).toContainText(/\[paste your resume here\]/);

  // The privacy reminder is the closing one-liner.
  await expect(dialog.getByText(/all processing happens locally\./i)).toBeVisible();

  // Click the close button to dismiss the dialog.
  await dialog.getByRole('button', { name: /close/i }).click();
  await expect(dialog).toHaveCount(0);
});

test('the Copy to clipboard button writes the prompt prefix', async ({
  page,
  browserName,
}, testInfo) => {
  // Webkit's headless permission model treats clipboard-write as origin-
  // restricted in a way Playwright can't easily grant — the writer falls
  // back to window.prompt(). The clipboard-write assertion is the
  // valuable signal here, so we run it on chromium-class projects.
  test.skip(
    browserName !== 'chromium',
    'clipboard-write permission is chromium-only in Playwright',
  );

  // Grant clipboard permissions for the active origin so writeText resolves
  // instead of taking the prompt fallback path.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: new URL(page.url() || 'http://localhost').origin,
  });

  await openSettingsDrawer(page);
  // The drawer locator isn't needed after the click (which closes it) —
  // the page-scoped button query handles the markdown-format trigger.
  await page.getByRole('button', { name: /markdown format/i }).click();
  const dialog = page.getByRole('dialog', { name: /^markdown format$/i });
  await expect(dialog).toBeVisible();

  // Click the copy button and assert the clipboard contains the prompt
  // prefix. The full body is long; the prefix is the strongest signal
  // that the right string was written (and the visible "Copied"
  // confirmation reinforces it from the UI side).
  await dialog.getByRole('button', { name: /copy to clipboard/i }).click();

  // The confirmation pip flips to "Copied" for ~2 seconds. We assert on
  // the user-visible string rather than waiting on a class toggle —
  // matches the contract a screen reader sees via aria-live.
  await expect(dialog.getByRole('button', { name: /^copied$/i })).toBeVisible();

  // Pull the clipboard contents through the runtime so we don't depend
  // on a Playwright-specific clipboard API. testInfo.project.name keeps
  // the assertion legible in failure traces.
  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  expect(
    clipboardText.startsWith(
      "Here's my resume in Works on My Resume markdown format. Refine the language while keeping the structure exact:",
    ),
    `clipboard text on ${testInfo.project.name} did not start with the expected prefix`,
  ).toBe(true);
  expect(clipboardText).toContain('[paste your resume here]');
});
