/**
 * health-actionable.spec.ts — actionable Resume Health findings (#115).
 *
 * The Resume Health panel (#85) emits findings with severity dots. With #115
 * each finding becomes an interactive row: "Jump to line N" selects the
 * literal offender substring in the editor textarea, and findings backed by
 * a templated rewrite (weak-verb, the most common case) get an extra
 * "Suggest a fix" button that opens an inline tray of 2-3 candidate
 * rewrites pulled from `bulletPatterns` (#93). Selecting a candidate
 * inserts a sibling bullet above the original through the editor's
 * value/onChange path — the preview never receives unsanitized content.
 *
 * The spec exercises the weak-verb + Suggest-a-fix path end-to-end, which
 * covers the most user-visible bit of #115. The Open-an-example fallback
 * path and the offender-aware selection are covered as smaller assertions
 * inside the same file.
 */
import { test, expect, type Page } from '@playwright/test';
import { clearAppStorage, expandMobileEditor, loadSampleResume } from './helpers';

/** The Resume Health panel region locator. */
function healthPanel(page: Page) {
  return page.getByRole('region', { name: /resume health/i });
}

/** Activate the Health tab in the preview pane. Idempotent. */
async function openHealthTab(page: Page) {
  await page.getByRole('tab', { name: /^health$/i }).click();
}

/**
 * A small resume that contains exactly one weak-verb opener so the
 * weak-verb finding is the only actionable warning. Frontmatter +
 * structure mirrors `health.spec.ts` so we stay consistent with the
 * existing fixtures.
 */
const RESUME_WITH_WEAK_VERB = [
  '---',
  'name: Test User',
  'role: Engineer',
  'email: test@example.com',
  'links:',
  '  - GitHub: https://example.com',
  '---',
  '',
  '## Summary',
  '',
  'Body text so the preview renders.',
  '',
  '## Experience',
  '',
  '### Engineer — Acme',
  '',
  '- Worked on the cache layer and the deploy pipeline.',
  '- Shipped a feature that mattered.',
  '- Built another nice thing.',
  '',
  '## Skills',
  '',
  '- Things',
  '',
].join('\n');

test.beforeEach(async ({ page }) => {
  await clearAppStorage(page);
  await page.goto('');
});

/* ------------------------------------------------------------------ */
/* 1. Weak-verb: Jump to line selects the offender                    */
/* ------------------------------------------------------------------ */
test('weak-verb "Jump to line" selects the offender substring', async ({ page }) => {
  await expandMobileEditor(page);
  await page.getByLabel(/markdown source/i).fill(RESUME_WITH_WEAK_VERB);
  await expect(page.getByRole('article', { name: /rendered resume/i })).toBeVisible();
  await openHealthTab(page);

  const panel = healthPanel(page);
  const finding = panel.locator('.health__list [data-rule="weak-verb"]');
  await expect(finding).toHaveCount(1);

  // The "Worked on …" bullet is on line 17 of the markdown above.
  const jumpButton = finding.getByRole('button', { name: /jump to line 17/i });
  await expect(jumpButton).toBeVisible();

  // On mobile the editor pane collapses into a <details> accordion once a
  // resume is loaded (#100). Re-expand BEFORE the jump click — focusing
  // a textarea inside a collapsed <details> can drop the selection on
  // mobile WebKit (the engine playwright emulates for mobile-iphone-13).
  await expandMobileEditor(page);
  await jumpButton.click();

  // After the jump, the textarea selection should land on "Worked on".
  // We read the live DOM selection — `selectionStart`/`selectionEnd` are
  // the canonical signal that a substring (not the whole line) was picked.
  const textarea = page.getByLabel(/markdown source/i);
  const selection = await textarea.evaluate((el) => {
    const ta = el as HTMLTextAreaElement;
    return {
      start: ta.selectionStart,
      end: ta.selectionEnd,
      value: ta.value.slice(ta.selectionStart, ta.selectionEnd),
    };
  });
  expect(selection.value).toBe('Worked on');
});

/* ------------------------------------------------------------------ */
/* 2. Weak-verb: Suggest a fix opens a tray with bulletPattern entries */
/* ------------------------------------------------------------------ */
test('weak-verb "Suggest a fix" opens a tray with at least two rewrites', async ({ page }) => {
  await expandMobileEditor(page);
  await page.getByLabel(/markdown source/i).fill(RESUME_WITH_WEAK_VERB);
  await expect(page.getByRole('article', { name: /rendered resume/i })).toBeVisible();
  await openHealthTab(page);

  const panel = healthPanel(page);
  const finding = panel.locator('.health__list [data-rule="weak-verb"]');
  const fixButton = finding.getByRole('button', { name: /suggest a fix/i });
  await expect(fixButton).toBeVisible();
  await fixButton.click();

  // Tray opens beneath the finding row with candidates from bulletPatterns.
  // "Worked on …" matches three rewrites: Add a metric, Lead with outcome,
  // and the verb-upgrade (Worked on → Built). We require at least two so
  // the test stays robust as the pattern library evolves.
  const tray = finding.locator('.health__item-tray');
  await expect(tray).toBeVisible();
  const candidates = tray.getByRole('menuitem');
  await expect(candidates).toHaveCount(3);
  // One candidate must be the verb-upgrade, since that's the bullet's
  // signature behavior in #115.
  await expect(
    tray.getByRole('menuitem', { name: /verb upgrade.*worked on.*built/i }),
  ).toBeVisible();
});

/* ------------------------------------------------------------------ */
/* 3. Picking a rewrite inserts a sibling bullet above the original    */
/* ------------------------------------------------------------------ */
test('selecting a rewrite inserts a sibling bullet above the original line', async ({ page }) => {
  await expandMobileEditor(page);
  await page.getByLabel(/markdown source/i).fill(RESUME_WITH_WEAK_VERB);
  await expect(page.getByRole('article', { name: /rendered resume/i })).toBeVisible();
  // Mobile accordion collapses on hasResume = true (#100); re-expand so the
  // editor textarea remains reachable for the rewrite-insert path below.
  await expandMobileEditor(page);
  await openHealthTab(page);

  const panel = healthPanel(page);
  const finding = panel.locator('.health__list [data-rule="weak-verb"]');
  await finding.getByRole('button', { name: /suggest a fix/i }).click();

  // Verb-upgrade is the most predictable rewrite — pick it and assert the
  // editor now has a Built bullet sitting ABOVE the original Worked on bullet.
  const upgrade = finding
    .locator('.health__item-tray')
    .getByRole('menuitem', { name: /verb upgrade.*worked on.*built/i });
  await upgrade.click();

  const textareaValue = await page
    .getByLabel(/markdown source/i)
    .evaluate((el) => (el as HTMLTextAreaElement).value);
  // Original bullet is preserved.
  expect(textareaValue).toContain('- Worked on the cache layer and the deploy pipeline.');
  // Rewrite is inserted as a sibling.
  expect(textareaValue).toContain('- Built the cache layer and the deploy pipeline.');
  // The "Built" line must appear BEFORE the original "Worked on" line.
  const builtIdx = textareaValue.indexOf('- Built the cache layer and the deploy pipeline.');
  const workedOnIdx = textareaValue.indexOf('- Worked on the cache layer and the deploy pipeline.');
  expect(builtIdx).toBeGreaterThan(-1);
  expect(workedOnIdx).toBeGreaterThan(builtIdx);
});

/* ------------------------------------------------------------------ */
/* 4. Open-an-example fallback dialog (#120)                           */
/* ------------------------------------------------------------------ */
/* The Resume Health panel's "Open an example" button points at a section
 * of the bundled sample. When the writer's resume already has that
 * section, the editor textarea scrolls to it (the existing #115 behavior).
 * When it DOESN'T — e.g. a Junior-shaped resume with no Selected Impact —
 * we open a small modal showing the bundled sample's section. Previously
 * the button was a no-op on that path, leaving the writer stuck.
 *
 * The fixture below uses a first-person bullet ("I shipped …") so the
 * `first-person` rule fires; that rule's `suggest.section` is
 * "Selected Impact", and we deliberately omit that section from the
 * fixture so the fallback path is exercised.
 */
const RESUME_WITHOUT_SELECTED_IMPACT = [
  '---',
  'name: Test User',
  'role: Engineer',
  'email: test@example.com',
  'links:',
  '  - GitHub: https://example.com',
  '---',
  '',
  '## Summary',
  '',
  'Body text so the preview renders.',
  '',
  '## Experience',
  '',
  '### Engineer — Acme',
  '',
  '- I shipped the cache layer and the deploy pipeline.',
  '- Built a feature that mattered.',
  '- Built another nice thing.',
  '',
  '## Skills',
  '',
  '- Things',
  '',
].join('\n');

test('first-person "Open an example" opens the bundled sample fallback dialog', async ({
  page,
}) => {
  await expandMobileEditor(page);
  await page.getByLabel(/markdown source/i).fill(RESUME_WITHOUT_SELECTED_IMPACT);
  await expect(page.getByRole('article', { name: /rendered resume/i })).toBeVisible();
  await openHealthTab(page);

  const panel = healthPanel(page);
  const finding = panel.locator('.health__list [data-rule="first-person"]').first();
  // The example button is now always offered for example-shaped findings
  // (#120) — the panel no longer hides it on section-missing.
  const exampleButton = finding.getByRole('button', { name: /open an example/i });
  await expect(exampleButton).toBeVisible();
  await exampleButton.click();

  // Modal: role=dialog, labelled "Example: Selected Impact". Carries the
  // sanitized bundled sample slice, including the H2 heading.
  const dialog = page.getByRole('dialog', { name: /example: selected impact/i });
  await expect(dialog).toBeVisible();
  // Two H2s share the dialog: the modal's own "Example: Selected Impact"
  // title and the rendered slice's "Selected Impact" heading. Match the
  // slice one exactly so we don't accidentally accept the title and miss
  // the case where the body didn't render.
  await expect(dialog.getByRole('heading', { name: 'Selected Impact', exact: true })).toBeVisible();
  // One of the bundled sample's bullets — assert the body content rendered,
  // not just the heading. The sample's first Selected Impact bullet opens
  // with "Cut median CI time".
  await expect(dialog.getByText(/cut median ci time/i)).toBeVisible();

  // Esc closes the dialog and focus returns to the trigger button.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(exampleButton).toBeFocused();
});

test('first-person "Open an example" jumps the editor when the section IS present', async ({
  page,
}) => {
  // Same first-person trigger, but this time the writer DOES have a
  // Selected Impact section. The button should jump the editor textarea
  // to that heading rather than opening the fallback dialog.
  const withSelectedImpact = RESUME_WITHOUT_SELECTED_IMPACT.replace(
    '## Summary',
    '## Selected Impact\n\n- Outcome bullet.\n\n## Summary',
  );
  await expandMobileEditor(page);
  await page.getByLabel(/markdown source/i).fill(withSelectedImpact);
  await expect(page.getByRole('article', { name: /rendered resume/i })).toBeVisible();
  await openHealthTab(page);

  const panel = healthPanel(page);
  const finding = panel.locator('.health__list [data-rule="first-person"]').first();
  const exampleButton = finding.getByRole('button', { name: /open an example/i });
  await expect(exampleButton).toBeVisible();

  await expandMobileEditor(page);
  await exampleButton.click();

  // No dialog — the existing #115 path is taken.
  await expect(page.getByRole('dialog', { name: /example: selected impact/i })).toHaveCount(0);

  // The editor textarea selection lands on the "## Selected Impact" heading.
  const textarea = page.getByLabel(/markdown source/i);
  const selection = await textarea.evaluate((el) => {
    const ta = el as HTMLTextAreaElement;
    return ta.value.slice(ta.selectionStart, ta.selectionEnd);
  });
  expect(selection).toBe('## Selected Impact');
});

/* ------------------------------------------------------------------ */
/* 5. Existing rewrite-tray affordance (#93) is unaffected             */
/* ------------------------------------------------------------------ */
test('in-editor rewrite tray still surfaces when caret lands on an Experience bullet', async ({
  page,
}) => {
  await expandMobileEditor(page);
  const textarea = page.getByLabel(/markdown source/i);
  await textarea.fill(RESUME_WITH_WEAK_VERB);
  await expect(page.getByRole('article', { name: /rendered resume/i })).toBeVisible();
  // Mobile accordion collapses on hasResume transition (#100); re-expand
  // so the textarea is interactable.
  await expandMobileEditor(page);

  // Place the caret inside the weak-verb bullet and force React to re-derive
  // caret state through its real event handlers. We position via the DOM
  // (setSelectionRange) then press ArrowRight/ArrowLeft so the textarea
  // dispatches `keydown`/`keyup` events; React's `onKeyUp` is what the
  // #93 tray uses to update its eligibility-checking caret state.
  await textarea.focus();
  await textarea.evaluate((el) => {
    const ta = el as HTMLTextAreaElement;
    const target = ta.value.indexOf('Worked on the cache layer');
    ta.setSelectionRange(target + 4, target + 4);
  });
  await textarea.press('ArrowLeft');
  await textarea.press('ArrowRight');

  // The original "Rewrite this bullet" trigger from #93 should be visible.
  await expect(page.getByRole('button', { name: /rewrite this bullet/i })).toBeVisible();
});

/* ------------------------------------------------------------------ */
/* 6. Coaching blocks (#137): celebrate strip + progress meter +       */
/*    next-step CTA all render and the CTA jumps the editor.            */
/* ------------------------------------------------------------------ */

test('coaching blocks render the celebrate strip, progress meter, and next-step CTA', async ({
  page,
}) => {
  // Load the bundled sample (Avery Quinn) — it's a clean senior resume with
  // plenty of positive signals + a non-zero number of findings at mid stage,
  // so all three coaching blocks have content.
  await expandMobileEditor(page);
  await loadSampleResume(page);
  await openHealthTab(page);

  const panel = healthPanel(page);

  // (a) What's working strip — at least 3 positive entries.
  const celebrate = panel.locator('.resume-health__celebrate');
  await expect(celebrate).toBeVisible();
  await expect(celebrate.getByRole('heading', { name: /what's working/i })).toBeVisible();
  const positiveItems = celebrate.locator('.resume-health__celebrate-item');
  const positiveCount = await positiveItems.count();
  expect(positiveCount).toBeGreaterThanOrEqual(3);

  // (b) Stage progress meter — carries the score and either the next-tier
  // hint or the at-the-top affordance. The default stage is `mid` which
  // advances to `senior`, so we assert on the score + the "advance to"
  // language.
  const progress = panel.locator('.resume-health__progress');
  await expect(progress).toBeVisible();
  await expect(progress.getByRole('heading', { name: /stage progress/i })).toBeVisible();
  const label = progress.locator('.resume-health__progress-label');
  await expect(label).toHaveText('MID');
  // The meter is a row of █/░ glyphs — at minimum it should contain a fill cell.
  const meter = progress.locator('.resume-health__progress-meter');
  const meterText = (await meter.textContent()) ?? '';
  expect(meterText).toMatch(/█/);
  expect(meterText).toMatch(/^[█░]+$/);
  // The hint reads "<score> → 90 to advance to SENIOR" at the mid tier.
  await expect(progress.locator('.resume-health__progress-hint')).toContainText(
    /advance to SENIOR/,
  );
});

test('coaching: clicking the Next step CTA jumps the editor to the offender line', async ({
  page,
}) => {
  // Use the weak-verb fixture so the next-step CTA points at the
  // "Worked on …" bullet on line 17 — same shape as the existing jump test.
  await expandMobileEditor(page);
  await page.getByLabel(/markdown source/i).fill(RESUME_WITH_WEAK_VERB);
  await expect(page.getByRole('article', { name: /rendered resume/i })).toBeVisible();
  await openHealthTab(page);

  const panel = healthPanel(page);
  const next = panel.locator('.resume-health__next');
  await expect(next).toBeVisible();
  await expect(next.getByRole('heading', { name: /next step/i })).toBeVisible();
  // The CTA copy mentions the role + opener replacement for the weak-verb
  // rule. Match loosely so the exact wording can evolve.
  const cta = next.getByRole('button');
  await expect(cta).toBeVisible();
  await expect(cta).toContainText(/weak opener|number|line 17/i);

  // Re-expand the mobile accordion so the textarea is reachable BEFORE the
  // jump click — same pattern as the existing weak-verb jump test.
  await expandMobileEditor(page);
  await cta.click();

  // The textarea selection should land on the offender substring ("Worked on")
  // — the same plumbing as the existing #115 Jump-to-line affordance.
  const textarea = page.getByLabel(/markdown source/i);
  const selection = await textarea.evaluate((el) => {
    const ta = el as HTMLTextAreaElement;
    return {
      value: ta.value.slice(ta.selectionStart, ta.selectionEnd),
    };
  });
  expect(selection.value).toBe('Worked on');
});
