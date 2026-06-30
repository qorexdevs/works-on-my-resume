/**
 * health.spec.ts — Resume Health panel (#85).
 *
 * The panel itself is shipped by this turn, but the integration agent wires
 * it into ResumeStudio and adds the panel's CSS in `global.css`. Tests that
 * exercise the rendered panel in-app are gated with `test.fixme` and will
 * be flipped on once the panel is mounted by the studio.
 *
 * A `test.fixme` is a test that's KNOWN to be skipped — Playwright reports
 * it distinctly from a pass, so the integration agent has a single grep
 * target to flip and re-run the suite.
 */
import { test, expect } from '@playwright/test';
import { clearAppStorage, expandMobileEditor, loadSampleResume } from './helpers';

/** Convenience locator for the Resume Health section once it's mounted. */
function healthPanel(page: import('@playwright/test').Page) {
  return page.getByRole('region', { name: /resume health/i });
}

/**
 * Activate the Health tab in the preview pane. The tab default is Preview,
 * so every test that asserts on the Health panel begins by switching.
 *
 * Idempotent: if a previous step already activated the tab the second click
 * is harmless.
 */
async function openHealthTab(page: import('@playwright/test').Page) {
  await page.getByRole('tab', { name: /^health$/i }).click();
}

test.beforeEach(async ({ page }) => {
  await clearAppStorage(page);
  await page.goto('');
});

/* ------------------------------------------------------------------ */
/* 1. Empty state                                                      */
/* ------------------------------------------------------------------ */
test('renders the empty-state copy when no resume is loaded', async ({ page }) => {
  // Switch to the Health tab without first loading a resume.
  await openHealthTab(page);
  const panel = healthPanel(page);
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(/load a resume to see health feedback/i);
});

/* ------------------------------------------------------------------ */
/* 2. Sample resume scoring (senior)                                   */
/* ------------------------------------------------------------------ */
test('scores the sample resume above 60 at the senior stage', async ({ page }) => {
  await loadSampleResume(page);
  await openHealthTab(page);

  // Default stage is `mid`, so switch to senior first.
  const panel = healthPanel(page);
  await panel.getByRole('radio', { name: /^senior$/i }).click();

  // The score is rendered as a number inside `.health__score-num`.
  // The aria-label encodes the same number for assertion ergonomics.
  const score = panel.locator('.health__score-num');
  await expect(score).toBeVisible();
  const value = Number(((await score.textContent()) ?? '').trim());
  expect(Number.isFinite(value)).toBe(true);
  expect(value).toBeGreaterThan(60);

  // Sample is clean on weak-verb and first-person — make sure no finding
  // from those rules surfaced.
  const list = panel.locator('.health__list');
  if (await list.count()) {
    await expect(list.locator('[data-rule="weak-verb"]')).toHaveCount(0);
    await expect(list.locator('[data-rule="first-person"]')).toHaveCount(0);
  }
});

/* ------------------------------------------------------------------ */
/* 3. Stage sensitivity                                                */
/* ------------------------------------------------------------------ */
test('score drops when the user switches from senior to junior', async ({ page }) => {
  await loadSampleResume(page);
  await openHealthTab(page);
  const panel = healthPanel(page);

  await panel.getByRole('radio', { name: /^senior$/i }).click();
  const seniorScore = Number(
    ((await panel.locator('.health__score-num').textContent()) ?? '').trim(),
  );

  await panel.getByRole('radio', { name: /^junior$/i }).click();
  const juniorScore = Number(
    ((await panel.locator('.health__score-num').textContent()) ?? '').trim(),
  );

  expect(juniorScore).toBeLessThan(seniorScore);

  // The length finding should now exist at `bad` severity. It carries no
  // line, so the dot's container is matched on `data-rule`.
  const lengthFinding = panel.locator('.health__list [data-rule="length"]');
  await expect(lengthFinding).toHaveCount(1);
  await expect(lengthFinding).toHaveClass(/health__item--bad/);
});

/* ------------------------------------------------------------------ */
/* 4. Weak-verb detection + jump handler                               */
/* ------------------------------------------------------------------ */
test('weak-verb finding fires for a bullet starting with "Responsible for"', async ({ page }) => {
  // Capture jump invocations on the page object so the test can assert one
  // fired with the expected line number. The integration agent owns the
  // wiring of `onJumpToLine`; if it forwards the call to a globally-listenable
  // hook (e.g. dispatching a custom event), the test can listen and assert
  // directly. Until then, asserting on the rendered "Jump to line N" button
  // is sufficient evidence the finding carries a `line`.
  const md = [
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
    '- Responsible for managing the team.',
    '- Shipped a feature that mattered.',
    '- Built another nice thing.',
    '',
    '## Skills',
    '',
    '- Things',
    '',
  ].join('\n');

  await page.getByLabel(/markdown source/i).fill(md);
  // The parser is debounced 200 ms; wait until the preview rerenders.
  await expect(page.getByRole('article', { name: /rendered resume/i })).toBeVisible();
  await openHealthTab(page);

  const panel = healthPanel(page);
  const finding = panel.locator('.health__list [data-rule="weak-verb"]');
  await expect(finding).toHaveCount(1);
  // The "Responsible for" bullet is on line 17 of the markdown above.
  await expect(finding.getByRole('button', { name: /jump to line 17/i })).toBeVisible();
});

/* ------------------------------------------------------------------ */
/* 4b. Leftover placeholders                                           */
/* ------------------------------------------------------------------ */
test('placeholder finding fires for an unfilled [Company Name] slot', async ({ page }) => {
  const md = [
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
    '### Engineer — [Company Name]',
    '',
    '- Shipped a feature that mattered.',
    '- Built another nice thing.',
    '',
  ].join('\n');

  await page.getByLabel(/markdown source/i).fill(md);
  await expect(page.getByRole('article', { name: /rendered resume/i })).toBeVisible();
  await openHealthTab(page);

  const panel = healthPanel(page);
  const finding = panel.locator('.health__list [data-rule="placeholder"]');
  await expect(finding).toHaveCount(1);
  await expect(finding).toHaveClass(/health__item--bad/);
  // The placeholder sits on line 15 of the markdown above.
  await expect(finding.getByRole('button', { name: /jump to line 15/i })).toBeVisible();
});

/* ------------------------------------------------------------------ */
/* 4c. References-available-on-request line                            */
/* ------------------------------------------------------------------ */
test('references-line finding fires for "References available upon request"', async ({ page }) => {
  const md = [
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
    '- Shipped a feature that mattered.',
    '',
    '## References',
    '',
    'References available upon request',
    '',
  ].join('\n');

  await page.getByLabel(/markdown source/i).fill(md);
  await expect(page.getByRole('article', { name: /rendered resume/i })).toBeVisible();
  await openHealthTab(page);

  const panel = healthPanel(page);
  const finding = panel.locator('.health__list [data-rule="references-line"]');
  await expect(finding).toHaveCount(1);
  // The references line sits on line 21 of the markdown above.
  await expect(finding.getByRole('button', { name: /jump to line 21/i })).toBeVisible();
});

test('objective-statement finding fires for a "Seeking..." summary opener', async ({ page }) => {
  const md = [
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
    'Seeking a challenging role to apply my backend skills.',
    '',
    '## Experience',
    '',
    '### Engineer — Acme',
    '',
    '- Shipped a feature that mattered.',
    '',
  ].join('\n');

  await page.getByLabel(/markdown source/i).fill(md);
  await expect(page.getByRole('article', { name: /rendered resume/i })).toBeVisible();
  await openHealthTab(page);

  const panel = healthPanel(page);
  const finding = panel.locator('.health__list [data-rule="objective-statement"]');
  await expect(finding).toHaveCount(1);
  // The "Seeking..." line sits on line 11 of the markdown above.
  await expect(finding.getByRole('button', { name: /jump to line 11/i })).toBeVisible();
});

test('passive-voice finding fires for a "were increased" bullet', async ({ page }) => {
  const md = [
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
    '- Sales were increased 20% across the quarter.',
    '',
  ].join('\n');

  await page.getByLabel(/markdown source/i).fill(md);
  await expect(page.getByRole('article', { name: /rendered resume/i })).toBeVisible();
  await openHealthTab(page);

  const panel = healthPanel(page);
  const finding = panel.locator('.health__list [data-rule="passive-voice"]');
  await expect(finding).toHaveCount(1);
  // The passive bullet sits on line 17 of the markdown above.
  await expect(finding.getByRole('button', { name: /jump to line 17/i })).toBeVisible();
});

test('personal-details finding fires for a "Marital status:" line', async ({ page }) => {
  const md = [
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
    'Marital status: single. Senior backend engineer.',
    '',
    '## Experience',
    '',
    '### Engineer — Acme',
    '',
    '- Shipped a feature that mattered.',
    '',
  ].join('\n');

  await page.getByLabel(/markdown source/i).fill(md);
  await expect(page.getByRole('article', { name: /rendered resume/i })).toBeVisible();
  await openHealthTab(page);

  const panel = healthPanel(page);
  const finding = panel.locator('.health__list [data-rule="personal-details"]');
  await expect(finding).toHaveCount(1);
  // The "Marital status:" line sits on line 11 of the markdown above.
  await expect(finding.getByRole('button', { name: /jump to line 11/i })).toBeVisible();
});

test('exclamation finding fires for a bullet ending with "!"', async ({ page }) => {
  const md = [
    '---',
    'name: Test User',
    'role: Engineer',
    'email: test@example.com',
    'links:',
    '  - GitHub: https://example.com',
    '---',
    '',
    '## Experience',
    '',
    '### Engineer — Acme',
    '',
    '- Shipped the launch on time!',
    '',
  ].join('\n');

  await page.getByLabel(/markdown source/i).fill(md);
  await expect(page.getByRole('article', { name: /rendered resume/i })).toBeVisible();
  await openHealthTab(page);

  const panel = healthPanel(page);
  const finding = panel.locator('.health__list [data-rule="exclamation"]');
  await expect(finding).toHaveCount(1);
  // The "Shipped the launch on time!" bullet sits on line 13 of the markdown above.
  await expect(finding.getByRole('button', { name: /jump to line 13/i })).toBeVisible();
});

test('bullet-capitalization finding fires for a lowercase bullet opener', async ({ page }) => {
  const md = [
    '---',
    'name: Test User',
    'role: Engineer',
    'email: test@example.com',
    'links:',
    '  - GitHub: https://example.com',
    '---',
    '',
    '## Experience',
    '',
    '### Engineer — Acme',
    '',
    '- Built the billing pipeline end to end.',
    '- Cut deploy time from 30m to 4m.',
    '- shipped the launch on time.',
    '',
  ].join('\n');

  await page.getByLabel(/markdown source/i).fill(md);
  await expect(page.getByRole('article', { name: /rendered resume/i })).toBeVisible();
  await openHealthTab(page);

  const panel = healthPanel(page);
  const finding = panel.locator('.health__list [data-rule="bullet-capitalization"]');
  await expect(finding).toHaveCount(1);
  // Only the "shipped" bullet on line 15 opens lowercase; the two above it don't.
  await expect(finding.getByRole('button', { name: /jump to line 15/i })).toBeVisible();
});

test('duplicate-bullet finding fires for a repeated experience bullet', async ({ page }) => {
  const md = [
    '---',
    'name: Test User',
    'role: Engineer',
    'email: test@example.com',
    'links:',
    '  - GitHub: https://example.com',
    '---',
    '',
    '## Experience',
    '',
    '### Engineer — Acme',
    '',
    '- Cut the deploy time from thirty minutes to four.',
    '- Owned the billing service end to end.',
    '',
    '### Engineer — Globex',
    '',
    '- Cut the deploy time from thirty minutes to four.',
    '',
  ].join('\n');

  await page.getByLabel(/markdown source/i).fill(md);
  await expect(page.getByRole('article', { name: /rendered resume/i })).toBeVisible();
  await openHealthTab(page);

  const panel = healthPanel(page);
  const finding = panel.locator('.health__list [data-rule="duplicate-bullet"]');
  await expect(finding).toHaveCount(1);
  // The repeat sits on line 18; it points back at the first copy on line 13.
  await expect(finding.getByRole('button', { name: /jump to line 18/i })).toBeVisible();
});

test('date-format finding fires for a role that breaks the majority style', async ({ page }) => {
  const md = [
    '---',
    'name: Test User',
    'role: Engineer',
    'email: test@example.com',
    'links:',
    '  - GitHub: https://example.com',
    '---',
    '',
    '## Experience',
    '',
    '### Senior Engineer — Acme',
    '',
    '_Mar 2021 – Present_',
    '',
    '- Built the billing pipeline end to end.',
    '',
    '### Engineer — Globex',
    '',
    '_Jun 2018 – Feb 2021_',
    '',
    '- Cut deploy time from 30m to 4m.',
    '',
    '### Engineer — Initech',
    '',
    '_06/2016 – 05/2018_',
    '',
    '- Shipped the launch on schedule.',
    '',
  ].join('\n');

  await page.getByLabel(/markdown source/i).fill(md);
  await expect(page.getByRole('article', { name: /rendered resume/i })).toBeVisible();
  await openHealthTab(page);

  const panel = healthPanel(page);
  const finding = panel.locator('.health__list [data-rule="date-format"]');
  await expect(finding).toHaveCount(1);
  // Two roles use the "Mar 2021" style; the numeric "06/2016" line 25 is the odd one.
  await expect(finding.getByRole('button', { name: /jump to line 25/i })).toBeVisible();
});

/* ------------------------------------------------------------------ */
/* 5. Quantification scoping (#105)                                    */
/* ------------------------------------------------------------------ */
test('quantification ignores non-Experience bullets but counts Experience ones', async ({
  page,
}) => {
  // Variant A: Experience bullets all carry numbers; the Selected Writing
  // and Skills lists do not. The old (unscoped) rule averaged the two pools
  // together and warned on senior; the new rule should not warn at all
  // because every Experience bullet quantifies an outcome.
  const goodExperience = [
    '---',
    'name: Test User',
    'role: Senior Engineer',
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
    '### Senior Engineer — Acme',
    '',
    '- Cut p95 latency by 40% across the checkout path.',
    '- Reduced infra spend by $120k in 6 months.',
    '- Mentored 4 engineers; 2 were promoted to senior.',
    '',
    '## Skills',
    '',
    '- TypeScript, Go, Rust',
    '- Kubernetes, Terraform, Pulumi',
    '',
    '## Selected Writing',
    '',
    '- [Caching is a contract](https://example.com/post-a)',
    '- [On-call as product](https://example.com/post-b)',
    '',
  ].join('\n');

  await expandMobileEditor(page);
  await page.getByLabel(/markdown source/i).fill(goodExperience);
  await expect(page.getByRole('article', { name: /rendered resume/i })).toBeVisible();
  await openHealthTab(page);
  const panel = healthPanel(page);
  await panel.getByRole('radio', { name: /^senior$/i }).click();
  // No quantification warning — every Experience bullet carries a number.
  await expect(panel.locator('.health__list [data-rule="quantification"]')).toHaveCount(0);

  // Variant B: same shape, but the Experience bullets no longer carry
  // numbers. The Skills / Writing bullets are unchanged (still numberless).
  // The new rule scopes to Experience and SHOULD warn now.
  const weakExperience = [
    '---',
    'name: Test User',
    'role: Senior Engineer',
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
    '### Senior Engineer — Acme',
    '',
    '- Shipped the checkout redesign across the platform.',
    '- Tuned the caching layer and the deploy pipeline.',
    '- Mentored several engineers across the team.',
    '',
    '## Skills',
    '',
    '- TypeScript, Go, Rust',
    '- Kubernetes, Terraform, Pulumi',
    '',
    '## Selected Writing',
    '',
    '- [Caching is a contract](https://example.com/post-a)',
    '- [On-call as product](https://example.com/post-b)',
    '',
  ].join('\n');

  await expandMobileEditor(page);
  await page.getByLabel(/markdown source/i).fill(weakExperience);
  await expect(panel.locator('.health__list [data-rule="quantification"]')).toHaveCount(1);
});

/* ------------------------------------------------------------------ */
/* 6. First-person detection                                           */
/* ------------------------------------------------------------------ */
test('first-person finding fires for a bullet starting with "I led"', async ({ page }) => {
  const md = [
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
    '- I led the migration to a new platform.',
    '- Shipped a feature that mattered.',
    '- Built another nice thing.',
    '',
    '## Skills',
    '',
    '- Things',
    '',
  ].join('\n');

  await page.getByLabel(/markdown source/i).fill(md);
  await expect(page.getByRole('article', { name: /rendered resume/i })).toBeVisible();
  await openHealthTab(page);

  const panel = healthPanel(page);
  const finding = panel.locator('.health__list [data-rule="first-person"]');
  await expect(finding).toHaveCount(1);
  await expect(finding.getByRole('button', { name: /jump to line 17/i })).toBeVisible();
});

test('tech-casing finding fires for a tool written in the wrong case', async ({ page }) => {
  const md = [
    '---',
    'name: Test User',
    'role: Engineer',
    'email: test@example.com',
    'links:',
    '  - GitHub: https://example.com',
    '---',
    '',
    '## Experience',
    '',
    '### Senior Engineer — Acme',
    '',
    '- Shipped the billing service and pushed it to github.',
    '',
  ].join('\n');

  await page.getByLabel(/markdown source/i).fill(md);
  await expect(page.getByRole('article', { name: /rendered resume/i })).toBeVisible();
  await openHealthTab(page);

  const panel = healthPanel(page);
  const finding = panel.locator('.health__list [data-rule="tech-casing"]');
  // The frontmatter "GitHub:" link is correctly cased and skipped; only the
  // lowercase "github" in the bullet on line 13 should fire.
  await expect(finding).toHaveCount(1);
  await expect(finding.getByRole('button', { name: /jump to line 13/i })).toBeVisible();
});
