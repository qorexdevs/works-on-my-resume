/**
 * empty-state-hero.spec.ts — the Phase 1 hero block (#127).
 *
 * Phase 1 lands a loud, OKLCH-inspired landing hero above the workbench:
 *   - Title (`Works on My Resume`) at display size.
 *   - Tagline with inline keyboard chips (the discoverable shortcuts).
 *   - Stat counter row — THEMES / LAYOUTS / TEMPLATES / OFFLINE-READY.
 *
 * Once a resume is loaded, the hero collapses to the static AppHeader
 * chrome (no double-render of the brand row). This spec validates that
 * round-trip end-to-end.
 */
import { test, expect } from '@playwright/test';
import { clearAppStorage, loadSampleResume } from './helpers';

test.beforeEach(async ({ page }) => {
  await clearAppStorage(page);
  await page.goto('');
});

test('the hero is rendered on Phase 1 with title, kbd-chip tagline, and stat counters', async ({
  page,
}) => {
  const hero = page.locator('.app-hero');
  await expect(hero).toBeVisible();

  // The title carries the brand name at display size.
  await expect(hero.getByRole('heading', { name: /works on my resume/i })).toBeVisible();

  // The tagline carries inline <kbd> chips for the headline shortcuts.
  // Match the actual chip elements so a future copy tweak that loses the
  // chips would fail this assertion.
  const heroKbds = hero.locator('kbd');
  // We render four kbd chips: ←, →, /, r.
  await expect(heroKbds).toHaveCount(4);

  // The stat counters: each documented label must be present in the
  // stat-label region. The tagline above also mentions "themes" and
  // "layouts", so scope strictly to the .app-hero__stat-label nodes.
  const statLabels = hero.locator('.app-hero__stat-label');
  await expect(statLabels.filter({ hasText: /^themes$/i })).toBeVisible();
  await expect(statLabels.filter({ hasText: /^layouts$/i })).toBeVisible();
  await expect(statLabels.filter({ hasText: /^templates$/i })).toBeVisible();
  await expect(statLabels.filter({ hasText: /^offline-ready$/i })).toBeVisible();

  // While the hero is up, the static AppHeader chrome is hidden via the
  // body[data-app-phase='hero'] CSS rule.
  await expect(page.locator('.app-header')).toBeHidden();
});

test('loading a resume collapses the hero — the static AppHeader returns', async ({ page }) => {
  // Baseline: hero present.
  await expect(page.locator('.app-hero')).toHaveCount(1);

  // Load the bundled sample, which transitions to Phase 2.
  await loadSampleResume(page);

  // Hero is gone — no double-render of the brand row.
  await expect(page.locator('.app-hero')).toHaveCount(0);

  // The static AppHeader is now the brand surface again.
  await expect(page.locator('.app-header')).toBeVisible();
});

test('the body-level data-app-phase attribute flips on load + unload', async ({ page }) => {
  // Phase 1 → data-app-phase='hero'.
  await expect(page.locator('body')).toHaveAttribute('data-app-phase', 'hero');

  await loadSampleResume(page);

  // Phase 2 → data-app-phase='workbench'.
  await expect(page.locator('body')).toHaveAttribute('data-app-phase', 'workbench');
});

/**
 * #140 — stat counters tick up on mount with a staggered entrance.
 *
 * The numbers animate from 0 to their final values over ~500 ms via
 * `requestAnimationFrame` writing `textContent`. Themes leads, Layouts
 * staggers +100 ms, Templates +200 ms; the Offline-ready check fades in
 * via a CSS class at +400 ms. Under prefers-reduced-motion: reduce the
 * effect is skipped — the final values are rendered immediately at mount.
 *
 * Both specs use `page.emulateMedia` to pin the reduced-motion preference
 * BEFORE navigation, so AppHero's mount-time `matchMedia` read picks up
 * the requested value. (Setting `reducedMotion` via `test.use` is unreliable
 * when the worker reuses contexts across describe blocks.)
 */
test('#140 stat counters animate on mount and tag the check stat with --check-enter', async ({
  page,
}) => {
  // The top-level beforeEach already navigated; reset media + re-navigate
  // so AppHero's mount-time `matchMedia` read picks up the requested value.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('');

  // Hero is mounted before we assert on its children.
  await expect(page.locator('.app-hero')).toBeVisible();

  // Three numeric stat values (Themes, Layouts, Templates).
  const numericStats = page.locator('.app-hero__stat-value:not(.app-hero__stat-value--icon)');
  await expect(numericStats).toHaveCount(3);

  // After the entrance budget all three numeric stats land on a positive
  // integer. We don't pin the exact themeCount because the hero is
  // rendered while the lazy ~465-theme dataset is still resolving — the
  // boot fallback may be lower. The animation contract is: from 0, to a
  // positive integer, within ~1 s.
  await expect
    .poll(
      async () => {
        const texts = await numericStats.allTextContents();
        return texts.every((t) => {
          const n = Number(t);
          return Number.isInteger(n) && n > 0;
        });
      },
      {
        timeout: 1500,
        message: 'stat counters should reach their final values within ~1 s',
      },
    )
    .toBe(true);

  // Sanity-check the icon stat: it carries the `--check-enter` modifier
  // when motion is allowed.
  await expect(page.locator('.app-hero__stat--check')).toHaveClass(/app-hero__stat--check-enter/);
});

test('#140 stat counters skip the entrance under prefers-reduced-motion: reduce', async ({
  page,
}) => {
  // The top-level beforeEach already navigated; set the media query and
  // re-navigate so AppHero's mount-time `matchMedia` read sees `reduce`.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('');

  // The hero is present.
  await expect(page.locator('.app-hero')).toBeVisible();

  // Under reduced-motion the check stat must NOT carry the entrance
  // modifier — AppHero.tsx omits it. (This also means the icon is
  // visible at opacity 1 from frame zero.)
  await expect(page.locator('.app-hero__stat--check')).not.toHaveClass(
    /app-hero__stat--check-enter/,
  );

  // The numeric stat values must already be at their final state — no
  // "0" anywhere among the three numeric counters.
  const numericStats = page.locator('.app-hero__stat-value:not(.app-hero__stat-value--icon)');
  await expect(numericStats).toHaveCount(3);
  for (const text of await numericStats.allTextContents()) {
    const n = Number(text);
    // Final state must be a positive integer — no transient zero.
    expect(Number.isInteger(n) && n > 0).toBe(true);
  }
});
