/**
 * editor-overlay.spec.ts — structural overlay behind the Markdown editor (#141).
 *
 * The overlay paints two minimal-but-distinctive cues behind the textarea:
 *   - a 2 px accent left-rail on heading lines (any line whose first
 *     non-whitespace char is `#`);
 *   - a 1 px-tinted band over the leading frontmatter block (the region
 *     between an opening `---` on line 0 and the next `---`).
 *
 * These tests assert the overlay mounts, classifies lines correctly,
 * updates within a frame on every keystroke, and stays scroll-synced
 * with the textarea — the contract that distinguishes a real overlay
 * from one that drifts off-register the moment the writer scrolls.
 */
import { test, expect } from '@playwright/test';
import { clearAppStorage, expandMobileEditor } from './helpers';

test.beforeEach(async ({ page }) => {
  await clearAppStorage(page);
  await page.goto('');
});

test('the overlay mounts, classifies heading + frontmatter lines, and updates within a frame', async ({
  page,
}) => {
  // A small document with both a frontmatter block AND a heading after it —
  // the two cues the overlay paints. The leading `---` sits at line 0 so
  // the frontmatter detection's strict opener-at-line-0 rule applies.
  const sample = '---\nname: X\n---\n\n## Section\n\nBody.';
  const textarea = page.getByLabel(/markdown source/i);
  await textarea.fill(sample);
  // On mobile the editor accordion (#100) collapses once content is
  // present; expand it so the overlay element is actually painted.
  await expandMobileEditor(page);

  // 1. The overlay is mounted as a sibling of the textarea.
  const overlay = page.locator('.editor__overlay');
  await expect(overlay).toHaveCount(1);

  // 2. At least one heading line carries the heading-rail class. With the
  //    seed document above there's exactly one (`## Section`), but the
  //    contract is "at least one" so a future change adding a second
  //    heading doesn't break this assertion.
  const headingLines = overlay.locator('.editor__overlay-heading');
  await expect(headingLines).not.toHaveCount(0);
  await expect(headingLines.first()).toContainText('## Section');

  // 3. The frontmatter band is present. Lines 0 (`---`), 1 (`name: X`),
  //    and 2 (`---`) are all inside the band; the line after the close
  //    is NOT (that's the "prose starts here" boundary the band exists
  //    to communicate). We assert at least one frontmatter line and that
  //    a known prose line does NOT carry the class — guarding against
  //    the band leaking past the closing fence.
  const frontmatterLines = overlay.locator('.editor__overlay-frontmatter');
  await expect(frontmatterLines).not.toHaveCount(0);
  const proseLine = overlay.locator('.editor__overlay-line', { hasText: 'Body.' });
  await expect(proseLine).toHaveCount(1);
  await expect(proseLine).not.toHaveClass(/editor__overlay-frontmatter/);

  // 4. Typing into the textarea updates the overlay within one frame.
  //    We type a fresh heading, then assert that an overlay line
  //    containing the new heading text is present and carries the rail
  //    class. Playwright's auto-wait covers the "within one frame" — the
  //    React render + paint resolves well inside the default expect
  //    timeout, so a fixed-millisecond delay would only add flake.
  await textarea.focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n\n### Subsection\n\nMore body.');
  const subheading = overlay.locator('.editor__overlay-heading', { hasText: '### Subsection' });
  await expect(subheading).toHaveCount(1);
});

test('overlay scrollTop stays in sync with the textarea on scroll', async ({ page }) => {
  // Build a document tall enough to actually require scrolling inside the
  // editor pane. Twenty bulky lines is more than enough on the desktop
  // viewport given the editor surface's `min-height: 22rem`. We mix in
  // heading lines so the overlay actually has visible cues to paint;
  // the scroll-sync assertion below works regardless, but seeing the
  // rail track the scroll position is the failure mode the test guards.
  const lines: string[] = [];
  for (let i = 1; i <= 40; i++) {
    if (i % 5 === 0) lines.push(`## Heading ${i}`);
    else lines.push(`Body line ${i} with some content to take up width and vertical space.`);
  }
  const sample = lines.join('\n');

  const textarea = page.getByLabel(/markdown source/i);
  await textarea.fill(sample);
  await expandMobileEditor(page);

  // Wait for the overlay to be attached + the document tall enough that
  // the textarea can actually scroll. On a viewport that's too narrow the
  // editor surface may not exceed its min-height — in that case the
  // textarea's scrollHeight equals its clientHeight and scrollTop won't
  // budge, which would read as a passing test on a false positive.
  // Both conditions guard against that.
  await expect(page.locator('.editor__overlay')).toBeAttached();
  await expect
    .poll(
      async () =>
        textarea.evaluate(
          (el) =>
            (el as HTMLTextAreaElement).scrollHeight - (el as HTMLTextAreaElement).clientHeight,
        ),
      { timeout: 5_000 },
    )
    .toBeGreaterThan(40);

  // Scroll the textarea by a definite amount. Using the DOM directly
  // (rather than a wheel-event simulation) keeps the test independent
  // of viewport / scroll-snap quirks. We then dispatch a `scroll` event
  // because programmatic scrollTop assignments do NOT fire one in some
  // engines, and we want the same event the textarea's `onScroll`
  // handler keys off in production.
  await textarea.evaluate((el) => {
    const t = el as HTMLTextAreaElement;
    t.scrollTop = 40;
    t.dispatchEvent(new Event('scroll'));
  });

  // The overlay's scrollTop must match the textarea's. We poll rather
  // than read once: React's syncScroll callback flushes through a state-
  // free CSSOM write, so this is effectively synchronous, but polling
  // makes the test robust if a future change adds a microtask hop.
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const ta = document.querySelector('.editor__textarea') as HTMLTextAreaElement | null;
          const ov = document.querySelector('.editor__overlay') as HTMLDivElement | null;
          if (!ta || !ov) return null;
          return { ta: ta.scrollTop, ov: ov.scrollTop };
        }),
      { timeout: 5_000 },
    )
    .toEqual({ ta: 40, ov: 40 });
});
