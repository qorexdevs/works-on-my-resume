/**
 * editor.spec.ts — Markdown editor quality-of-life features.
 *
 * Covers:
 *  - The line-number gutter is mounted.
 *  - The soft-wrap toggle flips the textarea's `wrap` attribute.
 *  - "Insert section" inserts the corresponding snippet at the caret.
 *  - After a resume is loaded, the uploader collapses to its one-line bar.
 */
import { test, expect } from '@playwright/test';
import { clearAppStorage, expandMobileEditor, loadSampleResume } from './helpers';

test.beforeEach(async ({ page }) => {
  await clearAppStorage(page);
  await page.goto('');
});

test('the line-number gutter is present and matches the current line count', async ({ page }) => {
  // Populate a known three-line document directly via the editor.
  await page.getByLabel(/markdown source/i).fill('line one\nline two\nline three');

  /* The gutter renders one `<span class="editor__gutter-line">` per line.
     We confirm it exists, is non-empty, and counts up correctly. */
  const gutterLines = page.locator('.editor__gutter .editor__gutter-line');
  await expect(gutterLines).toHaveCount(3);
  await expect(gutterLines.nth(0)).toHaveText('1');
  await expect(gutterLines.nth(2)).toHaveText('3');
});

test('soft-wrap toggle flips the textarea wrap attribute', async ({ page }) => {
  const textarea = page.getByLabel(/markdown source/i);
  // Default is wrapped (soft).
  await expect(textarea).toHaveAttribute('wrap', 'soft');

  await page.getByRole('button', { name: /wrap/i }).click();
  await expect(textarea).toHaveAttribute('wrap', 'off');

  await page.getByRole('button', { name: /wrap/i }).click();
  await expect(textarea).toHaveAttribute('wrap', 'soft');
});

test('Insert section appends an Experience entry skeleton', async ({ page }) => {
  // Start from an empty document so "before" is unambiguous.
  const textarea = page.getByLabel(/markdown source/i);
  await textarea.fill('');
  // Focus so the caret position is `0`.
  await textarea.click();

  /* Post-#154 the editor exposes a single unified Insert-section popover —
     the prior always-visible quick-insert row was retired in favor of one
     menu, with entries grouped and document-ordered. Every snippet now
     lives behind the same trigger. */
  await page.getByRole('button', { name: /^insert section$/i }).click();
  await page.getByRole('menuitem', { name: /experience entry/i }).click();

  const value = await textarea.inputValue();
  // The snippet must include the canonical placeholder heading and a bullet.
  // Note: empty-doc auto-prepend (#97) leads with the frontmatter block, so
  // the Experience heading lands AFTER `---\n…\n---` rather than at offset 0.
  expect(value).toContain('Job Title — Company Name');
  expect(value).toMatch(/###\s+Job Title/);
});

test('Insert section menu is keyboard-reachable (#154)', async ({ page }) => {
  // The unified menu must be reachable + actionable via the keyboard. We
  // drive the trigger with Enter rather than a click to prove the path.
  const textarea = page.getByLabel(/markdown source/i);
  await textarea.fill('');
  await textarea.click();

  const trigger = page.getByRole('button', { name: /^insert section$/i });
  await trigger.focus();
  await page.keyboard.press('Enter');

  // With the menu open the first entry must be a real menuitem.
  const menu = page.getByRole('menu', { name: /insert a resume section/i });
  await expect(menu).toBeVisible();

  // Tab into the menu and pick Education with Enter — verifies that
  // every item is reachable through the standard Tab order.
  await page.getByRole('menuitem', { name: /education entry/i }).focus();
  await page.keyboard.press('Enter');

  const value = await textarea.inputValue();
  expect(value).toContain('Degree, Field of Study');
});

test('picking any snippet on an empty editor auto-prepends frontmatter (#97)', async ({ page }) => {
  // Start from an empty document — the auto-prepend trigger is "value is empty
  // AND no existing frontmatter". With no value at all both conditions hold.
  const textarea = page.getByLabel(/markdown source/i);
  await textarea.fill('');
  await textarea.click();

  // Pick a non-frontmatter snippet through the unified menu (#154).
  await page.getByRole('button', { name: /^insert section$/i }).click();
  await page.getByRole('menuitem', { name: /experience entry/i }).click();

  const value = await textarea.inputValue();
  // Frontmatter must lead the document, with the canonical identity keys,
  // and the Experience snippet must follow.
  expect(value).toMatch(/^---\n/);
  expect(value).toContain('name: Your Name');
  expect(value).toContain('role: Your Role');
  expect(value).toMatch(/---\n[\s\S]*###\s+Job Title/);
});

test('picking the frontmatter snippet itself does not double up (#97)', async ({ page }) => {
  // Empty document → pick Frontmatter directly. It lives in the popover only.
  const textarea = page.getByLabel(/markdown source/i);
  await textarea.fill('');
  await textarea.click();

  await page.getByRole('button', { name: /^insert section$/i }).click();
  await page.getByRole('menuitem', { name: /frontmatter \(identity header\)/i }).click();

  const value = await textarea.inputValue();
  // The frontmatter block opens the document exactly once.
  expect(value).toMatch(/^---\n/);
  const fences = value.match(/^---\s*$/gm) ?? [];
  // Opening + closing fence — two `---` lines, not four.
  expect(fences).toHaveLength(2);
});

test('snippets do not prepend frontmatter when content already exists (#97)', async ({ page }) => {
  // Non-empty editor → the auto-prepend trigger must NOT fire, even when no
  // `---` is present, because the empty-document precondition is unmet.
  const textarea = page.getByLabel(/markdown source/i);
  await textarea.fill('# Existing heading\n\nSome body text.\n');
  // On mobile the editor accordion (#100) collapses once content is present;
  // expand it so the textarea + Insert-section affordance stay reachable.
  await expandMobileEditor(page);
  await textarea.click();

  await page.getByRole('button', { name: /^insert section$/i }).click();
  await page.getByRole('menuitem', { name: /experience entry/i }).click();

  const value = await textarea.inputValue();
  // No frontmatter was injected — the document still opens with the heading.
  expect(value.startsWith('# Existing heading')).toBe(true);
  expect(value).not.toContain('name: Your Name');
});

/**
 * Helper for the bullet-rewrite tests below — see `expandMobileEditor`
 * in helpers.ts for the canonical implementation. Aliased here so the
 * existing call sites keep their familiar local name.
 */
const expandEditorIfCollapsed = expandMobileEditor;

test('bullet-rewrite tray surfaces and inserts a sibling bullet above the original (#93)', async ({
  page,
}) => {
  // Build a minimal Experience section with a single bullet that opens with
  // a weak verb — that gives us two candidates (Add metric + Verb upgrade)
  // plus the always-available Lead-with-outcome fallback, so the tray is
  // guaranteed to mount with multiple choices. Note: no trailing newline,
  // so Ctrl+End lands inside the bullet line rather than on an empty line
  // below it (the rewrite affordance keys off the line the caret is on).
  const textarea = page.getByLabel(/markdown source/i);
  const initial = '## Experience\n\n### Engineer — Acme\n\n- Helped organize a new pipeline';
  await textarea.fill(initial);
  // On mobile the editor accordion collapses once content is present; expand
  // it so the textarea + new affordance are actually visible to interact with.
  await expandEditorIfCollapsed(page);

  // Place the caret at the end of the document — which, given no trailing
  // newline, is the end of the bullet line itself. Ctrl+End fires a
  // synthetic selection-change so our onSelect handler picks it up.
  await textarea.click();
  await page.keyboard.press('Control+End');

  // The affordance must appear once the caret is on an eligible bullet.
  const trigger = page.getByRole('button', { name: /rewrite this bullet/i });
  await expect(trigger).toBeVisible();

  // Open the tray. We expect at least the Verb-upgrade and Add-metric
  // candidates given the weak "Helped" opener.
  await trigger.click();
  const tray = page.getByRole('menu', { name: /bullet rewrite suggestions/i });
  await expect(tray).toBeVisible();
  const verbUpgrade = tray.getByRole('menuitem', { name: /verb upgrade.*helped.*led/i });
  await expect(verbUpgrade).toBeVisible();

  // Click the verb-upgrade candidate — the resulting document must carry
  // BOTH bullets (non-destructive), with the rewritten one above the original.
  await verbUpgrade.click();
  const after = await textarea.inputValue();
  // The new bullet sits directly above the original "Helped organize..." line.
  expect(after).toMatch(/- Led organize a new pipeline\n- Helped organize a new pipeline/);
  // Original bullet is preserved verbatim.
  expect(after).toContain('- Helped organize a new pipeline');
});

test('bullet-rewrite affordance does not appear under non-Experience headings (#93)', async ({
  page,
}) => {
  // A Skills bullet is structurally the same shape as an Experience one,
  // but the pattern library treats Skills as out of scope for rewrites.
  // No trailing newline so the caret lands ON the bullet line after Ctrl+End.
  const textarea = page.getByLabel(/markdown source/i);
  await textarea.fill('## Skills\n\n- Helped maintain the build system');
  await expandEditorIfCollapsed(page);
  await textarea.click();
  await page.keyboard.press('Control+End');

  // The affordance trigger must NOT mount — the bullet is in a Skills
  // section, not an Experience-style one.
  await expect(page.getByRole('button', { name: /rewrite this bullet/i })).toHaveCount(0);
});

test('bullet-rewrite tray closes when the caret leaves the bullet (#93)', async ({ page }) => {
  // Set up an eligible bullet, then a prose paragraph below. The trailing
  // newline is intentional here — we need a non-bullet line below the
  // bullet so the caret can move off without the document ending.
  const textarea = page.getByLabel(/markdown source/i);
  await textarea.fill('## Experience\n\n- Helped ship a new pipeline\n\nSome prose afterward.');
  await expandEditorIfCollapsed(page);
  await textarea.click();
  // Caret onto the bullet line — line 3 (0-indexed line 2). The textarea
  // begins with the caret somewhere arbitrary, so we walk from the top.
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');

  const trigger = page.getByRole('button', { name: /rewrite this bullet/i });
  await expect(trigger).toBeVisible();

  // Move the caret two lines down — onto the prose paragraph.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');

  // The affordance must hide itself; the caret is no longer on a bullet.
  await expect(trigger).toHaveCount(0);
});

test('after loading a resume the editor shows the document tab strip', async ({ page }) => {
  // Phase 1: dropzone is the hero. The "Drop a Markdown file here" copy is its giveaway.
  await expect(page.getByText(/drop a markdown file here/i)).toBeVisible();

  await loadSampleResume(page);

  // On mobile (#100) the editor pane collapses to a <details> accordion
  // when a resume is loaded — expand it so the tab strip is reachable
  // for the assertions below.
  await expandMobileEditor(page);

  // Phase 2: that dropzone copy is gone. The new tab strip carries the
  // filename + line count where the uploader's compact bar used to. The
  // collapsed `.uploader__loaded` bar (#51) was removed in #138.
  await expect(page.getByText(/drop a markdown file here/i)).toHaveCount(0);
  const tabstrip = page.locator('[data-testid="editor-tabstrip"]');
  await expect(tabstrip).toBeVisible();
  await expect(tabstrip.locator('.editor__tab-name')).toHaveText('sample-resume.md');
  // The line count is a plain number, right-aligned in muted color.
  await expect(tabstrip.locator('.editor__tab-lines')).toHaveText(/^\d+$/);
  // And the Replace / Clear actions moved here from the old bar.
  await expect(page.getByRole('button', { name: /^clear$/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /^replace file$/i })).toBeVisible();
});

test('the dirty indicator appears once the user types into the textarea', async ({ page }) => {
  await loadSampleResume(page);
  await expandMobileEditor(page);

  // A freshly-loaded buffer is clean: the dirty dot is not painted.
  const tab = page.locator('[data-testid="editor-tabstrip"] .editor__tab').first();
  await expect(tab).toBeVisible();
  await expect(tab).not.toHaveClass(/editor__tab--dirty/);

  // Type one character into the editor — the buffer now differs from the
  // last-loaded markdown, so the `●` dirty indicator should appear.
  const textarea = page.getByLabel(/markdown source/i);
  await textarea.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' ');

  await expect(tab).toHaveClass(/editor__tab--dirty/);
  // The dot glyph itself is rendered (CSS reserves the width even when
  // clean — but the glyph is present only on the dirty class).
  await expect(tab.locator('.editor__tab-dot')).toHaveText('●');
});
