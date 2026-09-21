/**
 * toolbar-rhythm.spec.ts — locks in the #135 visual contract.
 *
 * The toolbar dropped its pill outlines and adopted a kicker + value
 * rhythm with hairline separators:
 *
 *   THEME  <name> ▾  │  LAYOUT  Classic Modern Compact  │  FIT  1.4p  │
 *     [Save as PDF]  │  Export ▾  │  ⚙
 *
 * Acceptance:
 *   1. At 1280×800, at least three visible kicker labels (THEME, LAYOUT,
 *      FIT) read in the toolbar.
 *   2. Save-as-PDF is the ONLY `.btn--primary` in the toolbar — every
 *      other control reads as text-with-affordance.
 *   3. The hairline separators (`.studio__toolbar-sep`) are present —
 *      at least one is in the DOM — so the grouping is conveyed
 *      visually. Visibility is asserted via `offsetParent !== null`
 *      so a 1-px wide element is still counted (offsetWidth on a
 *      single-px element is reported as 1, but the layout-shrink
 *      case where width truncates to 0 is rare and we'd rather not
 *      depend on offsetWidth-floor heuristics).
 *
 * Mobile is out of scope: the More menu (#131) reshapes the toolbar
 * into a column drawer, so the hairlines collapse with the rest of the
 * collapsible controls. The desktop project carries the rhythm.
 */
import { test, expect } from '@playwright/test';
import { clearAppStorage, loadSampleResume, waitForThemesReady } from './helpers';

test.beforeEach(async ({ page }) => {
  await clearAppStorage(page);
  await page.goto('');
});

test('at 1280×800 the toolbar shows THEME, LAYOUT, FIT kicker labels', async ({
  page,
  isMobile,
}) => {
  test.skip(
    isMobile === true,
    'kicker rhythm is the desktop layout (mobile collapses behind More)',
  );

  await loadSampleResume(page);
  await waitForThemesReady(page);

  const toolbar = page.locator('.studio__toolbar');
  await expect(toolbar).toBeVisible();

  /* Collect the visible-text content of every `.section-kicker` inside
     the toolbar root. Lowercase + trim so the assertion is robust to a
     CSS uppercase transform vs. JSX literal-case drift; the rule is
     "the label is THERE", not "the label is upper-cased at the source". */
  const kickerTexts = await toolbar
    .locator('.section-kicker')
    .evaluateAll((nodes) =>
      nodes.map((n) => (n.textContent || '').trim().toLowerCase()).filter((t) => t.length > 0),
    );

  expect(kickerTexts).toEqual(expect.arrayContaining(['theme', 'layout']));

  /* The page-fit pill carries its own "Fit:" / "Fits" kicker INSIDE the
     label text (an explicit `.section-kicker` span would have duplicated
     the word — the label already starts with "Fit"). Assert the pill is
     visible and its text leads with the kicker word so the FIT rhythm is
     present alongside THEME and LAYOUT. */
  const pageFitPill = toolbar.locator('.page-fit__pill');
  await expect(pageFitPill).toBeVisible();
  await expect(pageFitPill).toHaveText(/Fits 1 page|Fit: \d\.\d pages/);
});

test('Save as PDF is the only .btn--primary in the toolbar', async ({ page }) => {
  await loadSampleResume(page);
  await waitForThemesReady(page);

  /* Every `.btn--primary` inside the toolbar — accessible name must read
     as Save as PDF. Any extra primary fill is a violation of the rhythm
     since the rest of the cluster should read as text-with-affordance. */
  const primaries = page.locator('.studio__toolbar .btn--primary');
  await expect(primaries).toHaveCount(1);
  await expect(primaries.first()).toHaveText(/save as pdf/i);
});

test('hairline separators are present between toolbar groups', async ({ page, isMobile }) => {
  test.skip(isMobile === true, 'separators collapse on mobile with the More-menu reshape');

  await loadSampleResume(page);
  await waitForThemesReady(page);

  /* The separators are real DOM elements (`<span class="studio__toolbar-sep" />`)
     wrapped in `studio__toolbar-collapsible` so the mobile drawer can
     omit them. On desktop at 1280×800 we expect at least three present —
     matching the three group boundaries that survive a resume-loaded
     toolbar (THEME│LAYOUT, FIT│Save, Export│Settings). The exact count
     can drift one or two if a future PR rearranges groups, so we assert
     a floor rather than equality. We count nodes whose `offsetParent` is
     non-null — i.e. the element participates in layout — since a 1-px
     hairline reports offsetWidth=1 and offsetHeight≥1 but we want a
     defensive check that doesn't break if a future tweak swaps the
     rendered box size. */
  const presentCount = await page
    .locator('.studio__toolbar .studio__toolbar-sep')
    .evaluateAll((nodes) => nodes.filter((n) => (n as HTMLElement).offsetParent !== null).length);
  expect(presentCount).toBeGreaterThanOrEqual(3);
});

test('Theme picker trigger has no panel outline (drops the pill chrome)', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile === true, 'mobile trigger has its own collapsed shape');

  await loadSampleResume(page);
  await waitForThemesReady(page);

  /* The trigger's resting background should be transparent (no panel
     fill) and its border should not paint a visible 1-px ring — the
     #135 rhythm dropped the pill outline so the trigger reads as
     `THEME [name] ▾` text with affordance.

     Rather than read `getComputedStyle` (which reports the LIVE state
     including any :hover that the runtime cursor produces — cold-CI
     runs occasionally leave the pointer on the trigger between the
     last action and the assertion), we walk the matched CSS rules and
     confirm the *resting-state* rule paints transparent. The hover /
     [aria-expanded='true'] rule painting `--ui-panel-hover` is the
     intended active state and is allowed to exist as a separate rule.

     The CSS-class locator (`.theme-picker__trigger`) is the unambiguous
     selector. */
  const trigger = page.locator('.theme-picker__trigger').first();
  await expect(trigger).toBeVisible();

  const restingBg = await trigger.evaluate((el) => {
    /* Walk every stylesheet rule, find ones whose selector text matches
       the bare `.theme-picker__trigger` (i.e. the resting-state rule,
       not the :hover / [aria-expanded='true'] variants), and report the
       `background-color` declaration. Falls back to `getComputedStyle`
       when the rule list is unreachable (cross-origin stylesheet). */
    const matchesResting = (selector: string): boolean => {
      // Resting rule: selector text is exactly `.theme-picker__trigger`
      // (or starts with it followed by a combinator that isn't a
      // pseudo-class / attribute). Crucially we EXCLUDE the :hover and
      // [aria-expanded='true'] siblings which paint the active wash.
      const trimmed = selector.trim();
      if (trimmed === '.theme-picker__trigger') return true;
      return false;
    };
    let found = '';
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        // Cross-origin stylesheet: skip silently.
        continue;
      }
      for (const rule of Array.from(rules)) {
        if (!(rule instanceof CSSStyleRule)) continue;
        // Some rules carry multiple selectors separated by commas.
        const selectors = rule.selectorText.split(',').map((s) => s.trim());
        if (selectors.some(matchesResting)) {
          const bg = rule.style.getPropertyValue('background').trim();
          const bgc = rule.style.getPropertyValue('background-color').trim();
          if (bg) found = bg;
          else if (bgc) found = bgc;
        }
      }
    }
    return found || getComputedStyle(el).backgroundColor;
  });

  /* The resting-state rule declares `background: transparent` (or an
     equivalent zero-alpha rgba). Accept either. */
  expect(restingBg.replace(/\s/g, '')).toMatch(/(rgba\([^)]+,0\)|transparent)/);

  /* The border-top color is computed from `border: 1px solid transparent`;
     the runtime reports `rgba(0, 0, 0, 0)` for that. Sampling computed
     style is safe here because the :hover rule doesn't override the
     border-color (just the background). */
  const borderTop = await trigger.evaluate((el) => getComputedStyle(el).borderTopColor);
  expect(borderTop.replace(/\s/g, '')).toMatch(/(rgba\([^)]+,0\)|transparent)/);
});
