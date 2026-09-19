/**
 * templates.spec.ts — "Start from template" flow (#86).
 *
 * Three concerns, three test groups:
 *
 *   1. Modal open/close — depends on integration. The TemplatePicker
 *      component lives in `src/components/TemplatePicker.tsx`, but the
 *      trigger (the "Start from template" affordance in MarkdownUploader)
 *      is wired in by a separate integration agent. These tests are
 *      `fixme`'d for that agent to flip on.
 *
 *   2. Selection fires onSelect and loads the template — same gating.
 *
 *   3. Template content sanity — runs today. Fetches each
 *      `public/templates/*.md` directly via `page.goto()` and asserts the
 *      file is reachable and carries the expected frontmatter keys. This
 *      protects the templates themselves from accidental deletion or
 *      malformed frontmatter regardless of any UI wiring.
 */
import { test, expect } from '@playwright/test';
import { clearAppStorage } from './helpers';

/** The five template slugs, kept in lockstep with TemplatePicker.tsx.
 *  `scaffold` (#156) is the placeholder-only skeleton — it is included in
 *  the file-sanity sweep below but is exercised separately for selection
 *  and Health (it is designed to score LOW, not high, so it sits outside
 *  the Group 2 / Group 2b loops). */
const TEMPLATE_SLUGS = ['junior', 'mid', 'senior', 'em', 'scaffold'] as const;

/** Slugs that should ace the Resume Health rubric (worked examples). The
 *  scaffold is excluded because its bullets are placeholder strings, not
 *  numeric claims — Health will (correctly) score it low until filled. */
const WORKED_SLUGS = ['junior', 'mid', 'senior', 'em'] as const;
type WorkedSlug = (typeof WORKED_SLUGS)[number];

/* ------------------------------------------------------------------ */
/* Group 1 — modal open/close. Gated on integration. ------------------ */
/* ------------------------------------------------------------------ */

test.describe('Start from template — modal lifecycle', () => {
  test.beforeEach(async ({ page }) => {
    await clearAppStorage(page);
    await page.goto('');
  });

  test('opens the template picker dialog and closes it on Escape, restoring focus to the trigger', async ({
    page,
  }) => {
    // TODO(integration): the trigger button is wired into MarkdownUploader
    // by the integration agent. Update the accessible name below to match
    // whatever the agent settles on (likely "Start from template").
    const trigger = page.getByRole('button', { name: /start from (a )?template/i });
    await trigger.click();

    const dialog = page.getByRole('dialog', { name: /start from a template/i });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: /close template picker/i })).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test('Close button dismisses the dialog', async ({ page }) => {
    // TODO(integration): same trigger wiring as above.
    await page.getByRole('button', { name: /start from (a )?template/i }).click();
    const dialog = page.getByRole('dialog', { name: /start from a template/i });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /close template picker/i }).click();
    await expect(dialog).toHaveCount(0);
  });
});

/* ------------------------------------------------------------------ */
/* Group 2 — selecting a card loads the template. Gated on integration. */
/* ------------------------------------------------------------------ */

test.describe('Start from template — selection loads the resume', () => {
  test.beforeEach(async ({ page }) => {
    await clearAppStorage(page);
    await page.goto('');
  });

  /* Expected identity heading per worked-example template — taken from the
     frontmatter `name` field. The renderer surfaces this as the largest
     line of the identity header at the top of the rendered article. The
     scaffold is exercised separately (its `name` is the literal
     `<<your full name>>` placeholder; we assert that further down). */
  const EXPECTED_NAME: Record<WorkedSlug, string> = {
    junior: 'Riley Okonkwo',
    mid: 'Priya Salgado',
    senior: 'Marcus Halberg',
    em: 'Dani Velasquez',
  };

  for (const slug of WORKED_SLUGS) {
    test(`selecting "${slug}" loads its resume into the preview`, async ({ page }) => {
      // TODO(integration): the integration agent wires the trigger and the
      // card buttons through MarkdownUploader. This test asserts the
      // contract: clicking a card MUST cause that template's frontmatter
      // name to appear inside the rendered article.
      await page.getByRole('button', { name: /start from (a )?template/i }).click();

      const dialog = page.getByRole('dialog', { name: /start from a template/i });
      await expect(dialog).toBeVisible();

      // Each card carries a "Use this template" button; pick the one whose
      // nearest heading matches the slug's human label.
      const cardLabels: Record<WorkedSlug, RegExp> = {
        junior: /junior ic/i,
        mid: /mid ic/i,
        senior: /senior ic/i,
        em: /engineering manager/i,
      };
      const card = dialog
        .locator('li', { has: page.getByRole('heading', { name: cardLabels[slug] }) })
        .first();
      await card.getByRole('button', { name: /use this template/i }).click();

      const article = page.getByRole('article', { name: /rendered resume/i });
      await expect(article).toBeVisible({ timeout: 10_000 });
      await expect(article.getByText(EXPECTED_NAME[slug])).toBeVisible();
    });
  }

  /* Scaffold (#156) is the placeholder-only fifth template. The contract
     for the worked examples is "the frontmatter name renders in the
     article" — but the scaffold's `name` is the literal `<<your full
     name>>` placeholder, which is the value we care about for the LLM
     hand-off workflow. Assert it lands in the EDITOR textarea (where a
     user fills it in) rather than in the rendered article (where it
     would look like a stray angle-bracketed string).

     This also pins the contract that the scaffold card is wired into
     the same selection path as the worked examples — selecting it
     populates the editor with the scaffold body. */
  test('selecting "scaffold" loads the placeholder skeleton into the editor', async ({ page }) => {
    await page.getByRole('button', { name: /start from (a )?template/i }).click();

    const dialog = page.getByRole('dialog', { name: /start from a template/i });
    await expect(dialog).toBeVisible();

    const card = dialog
      .locator('li', { has: page.getByRole('heading', { name: /^scaffold$/i }) })
      .first();
    await card.getByRole('button', { name: /use this template/i }).click();

    // The editor textarea uses an accessible label of "Markdown source"
    // (see MarkdownEditor.tsx). After selection it should contain the
    // scaffold's frontmatter placeholder verbatim. We poll the value
    // rather than asserting visibility because on mobile-narrow viewports
    // the editor pane is layout-hidden by default — but the textarea is
    // still in the DOM and carries the loaded source.
    const editor = page.getByLabel(/markdown source/i);
    await expect(editor).toHaveCount(1, { timeout: 10_000 });
    await expect
      .poll(async () => editor.inputValue(), { timeout: 10_000 })
      .toContain('<<your full name>>');
    const value = await editor.inputValue();
    // Spot-check the canonical section ordering survived the round-trip.
    expect(value).toContain('## Summary');
    expect(value).toContain('## Experience');
    expect(value).toContain('## Skills');
    expect(value).toContain('## Education');
  });
});

/* ------------------------------------------------------------------ */
/* Group 2b — Resume Health validation (#104). ---------------------- */
/* ------------------------------------------------------------------ */
/**
 * The four starter templates double as in-app exemplars of the conventions
 * the Resume Health rubric scores. If a future edit ever introduces a thin
 * bullet, a weak verb, a first-person construction, or a buzzword into one
 * of them, we want the suite to flag it loudly — these tests load each
 * template into the live preview, switch the Health tab to the matching
 * career stage, and assert the score clears the bar.
 *
 * Stage selection per template:
 *   - junior.md  → Junior
 *   - mid.md     → Mid
 *   - senior.md  → Senior
 *   - em.md      → Mid (EMs in the rubric land between mid and senior; the
 *                 Mid stage is the better match because the EM template
 *                 leads with leadership highlights rather than a Selected
 *                 Impact framing, which the Senior rubric rewards.)
 *
 * Score threshold: `>= 85`. The templates should ace their own rubric —
 * 85 leaves a small headroom for sub-rule weight tweaks but is firm
 * enough to catch any real regression. Tune this comment, not the
 * threshold, if the rubric is rebalanced.
 */

test.describe('Template Resume Health validation (#104)', () => {
  /** Card label used to pick a card in the picker grid. */
  const CARD_LABELS: Record<WorkedSlug, RegExp> = {
    junior: /junior ic/i,
    mid: /mid ic/i,
    senior: /senior ic/i,
    em: /engineering manager/i,
  };

  /** Which Health-tab career stage best matches each template. */
  const STAGE_FOR: Record<WorkedSlug, 'Junior' | 'Mid' | 'Senior'> = {
    junior: 'Junior',
    mid: 'Mid',
    senior: 'Senior',
    em: 'Mid',
  };

  /** Frontmatter `name` for each template — used to confirm the resume
   *  actually loaded before we read the score. */
  const EXPECTED_NAME: Record<WorkedSlug, string> = {
    junior: 'Riley Okonkwo',
    mid: 'Priya Salgado',
    senior: 'Marcus Halberg',
    em: 'Dani Velasquez',
  };

  test.beforeEach(async ({ page }) => {
    await clearAppStorage(page);
    await page.goto('');
  });

  for (const slug of WORKED_SLUGS) {
    test(`${slug} template scores >= 85 at the ${STAGE_FOR[slug]} stage`, async ({ page }) => {
      /* Open the picker and select the matching card. Mirrors the wiring
         contract that Group 2 establishes (`Use this template` per card). */
      await page.getByRole('button', { name: /start from (a )?template/i }).click();
      const dialog = page.getByRole('dialog', { name: /start from a template/i });
      await expect(dialog).toBeVisible();
      const card = dialog
        .locator('li', { has: page.getByRole('heading', { name: CARD_LABELS[slug] }) })
        .first();
      await card.getByRole('button', { name: /use this template/i }).click();

      /* Confirm the template's resume actually rendered before we switch
         tabs — otherwise we might read a score from a stale state. */
      const article = page.getByRole('article', { name: /rendered resume/i });
      await expect(article).toBeVisible({ timeout: 10_000 });
      await expect(article.getByText(EXPECTED_NAME[slug])).toBeVisible();

      /* Switch to the Health tab and pick the matching career stage. */
      await page.getByRole('tab', { name: /^health$/i }).click();
      const panel = page.getByRole('region', { name: /resume health/i });
      await expect(panel).toBeVisible();
      await panel.getByRole('radio', { name: new RegExp(`^${STAGE_FOR[slug]}$`, 'i') }).click();

      /* Read and assert the score. The score number lives in
         `.health__score-num`; tolerate the analyzer's debounce by
         polling via expect.poll rather than reading once. */
      const scoreNode = panel.locator('.health__score-num');
      await expect(scoreNode).toBeVisible();
      await expect
        .poll(
          async () => {
            const text = ((await scoreNode.textContent()) ?? '').trim();
            const n = Number(text);
            return Number.isFinite(n) ? n : -1;
          },
          { timeout: 5_000 },
        )
        .toBeGreaterThanOrEqual(85);

      /* Defensive: if any of the three rules below ever escalates to
         `bad` severity inside a template, the score gate above might
         still pass (the rubric is generous in the upper band) — so we
         pin them out explicitly. Scoped to `--bad` so legitimate
         warn-severity findings (e.g. the template referencing "how we
         ship" in a section title) do not trip this guard; the goal is
         to catch a regression that introduces a clear-cut bad bullet,
         not to police every warning. */
      const list = panel.locator('.health__list');
      if (await list.count()) {
        await expect(list.locator('[data-rule="weak-verb"].health__item--bad')).toHaveCount(0);
        await expect(list.locator('[data-rule="first-person"].health__item--bad')).toHaveCount(0);
        await expect(list.locator('[data-rule="buzzwords"].health__item--bad')).toHaveCount(0);
      }
    });
  }
});

/* ------------------------------------------------------------------ */
/* Group 3 — template content sanity. Runs today. -------------------- */
/* ------------------------------------------------------------------ */

test.describe('Template files are reachable and well-formed', () => {
  /* Minimum frontmatter the renderer reads (and the writing guide
     documents). If a future edit ever drops one of these we want a
     loud, named failure rather than a silent broken card. */
  const REQUIRED_FRONTMATTER_KEYS = ['name', 'role', 'email'] as const;

  for (const slug of TEMPLATE_SLUGS) {
    test(`templates/${slug}.md is served and carries the required frontmatter keys`, async ({
      page,
    }) => {
      // `page.goto` resolves against the Playwright baseURL, which already
      // includes the configured Astro base path. Fetching the asset as a
      // navigation gives us a real HTTP status and the raw text in one step.
      const response = await page.goto(`templates/${slug}.md`);
      expect(response, `templates/${slug}.md should respond`).not.toBeNull();
      expect(response!.status(), `templates/${slug}.md HTTP status`).toBe(200);

      const body = await response!.text();

      // Frontmatter must be at the very top, fenced by --- lines.
      expect(/^---\r?\n/.test(body), `${slug}.md must start with frontmatter`).toBe(true);
      const frontmatterEnd = body.search(/\r?\n---/);
      expect(frontmatterEnd, `${slug}.md must have a closing --- fence`).toBeGreaterThan(0);
      const frontmatter = body.slice(4, frontmatterEnd);

      for (const key of REQUIRED_FRONTMATTER_KEYS) {
        expect(
          new RegExp(`(^|\\n)${key}:`).test(frontmatter),
          `${slug}.md frontmatter must declare ${key}:`,
        ).toBe(true);
      }

      // Body should have at least one `##` section heading — the conventional
      // structure documented in docs/writing-your-resume.md.
      const bodyAfterFrontmatter = body.slice(frontmatterEnd + 4);
      expect(
        /\n## /.test(bodyAfterFrontmatter),
        `${slug}.md body must use ## section headings`,
      ).toBe(true);
    });
  }
});
