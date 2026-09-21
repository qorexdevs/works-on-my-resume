/**
 * pageFit — approximate "how many printed pages will this be?" estimation.
 *
 * The studio is a screen-rendered React app. The toolbar's "Save as PDF" path
 * eventually hands the document to the browser's print pipeline, which honors
 * print.css and the body's 0.6in padding (see src/styles/print.css). That
 * means a rendered preview height in CSS pixels can be divided by the
 * available print content height to get a coarse-but-useful "pages" estimate.
 *
 * This is intentionally approximate. The screen render and the print render
 * are not pixel-identical — fonts subset differently, line-height rounding
 * differs, page-breaks may split a paragraph. The goal is *signal*: the user
 * should see "Fit: 1.4 pages" and reach for the compact layout, or "Fits 1
 * page" and stop worrying.
 *
 * The math:
 *
 *   Letter at 0.6in margin = 11in - 1.2in = 9.8in content height
 *   9.8in × 96 CSS px/in    = 940.8 CSS px @ 96 dpi   (PAGE_CONTENT_PX_AT_96DPI)
 *
 *   Print content width @ 96 dpi                       (PRINT_CONTENT_WIDTH_PX)
 *   ≈ 825.6 CSS px — the printed line-length the resume reflows to.
 *
 * Print-width scaling (issue #107)
 * --------------------------------
 * On desktop the preview pane is narrower than the actual printed content
 * width: the studio splits the viewport between editor + preview, so the
 * `.resume-preview` article frequently renders at 300–600 CSS px wide. The
 * printed page is wider (≈ 825 CSS px at 96dpi), so text wraps less
 * aggressively in print and the rendered article is **taller on screen
 * than on paper**. Naively dividing the screen height by the page-content
 * height over-estimates page count — for the bundled sample, by roughly
 * 2.5×, reporting ~5 pages for what actually prints in 2.
 *
 * Fix: scale the measured screen height by `measuredPreviewWidth /
 * printContentWidth` before dividing by the page-content height. A narrow
 * preview gets a scale factor < 1 (we virtually "stretch" it to print
 * width, which shortens it as lines re-flow). The factor is clamped to
 * `[0.5, 2.0]` so a phone-sized preview doesn't produce an absurd
 * 0.2-page estimate, and an unusually wide preview can't push us above 2×
 * the measured height either. Section heights returned from `sectionHeights`
 * are scaled by the same factor so the popover breakdown stays consistent.
 *
 * All exported functions remain pure: they read measurements from an
 * HTMLElement and return numbers / strings. No DOM mutation, no global
 * state. Width is sampled inline from the same element used for the height
 * measurement so callers don't have to plumb a second argument.
 *
 * Browser-only: these helpers call `getBoundingClientRect`, which has no
 * server-side analogue. The callsites are React components mounted as Astro
 * islands (`client:load`), so `typeof window` is always defined.
 *
 * @example
 *   const previewEl = document.querySelector<HTMLElement>('.resume-preview');
 *   if (previewEl) {
 *     // 1320 px tall × 400 px wide preview (typical desktop split-pane):
 *     //   factor = 400 / 825.6 ≈ 0.484
 *     //   printH = 1320 × 0.484 ≈ 639 print-px
 *     //   pages  = 639 / 940.8 ≈ 0.68 → "Fits 1 page"
 *     const pages = estimatePages(previewEl); // e.g. 0.68
 *     const label = formatPagesLabel(pages);  // "Fits 1 page"
 *   }
 */

/** US Letter content height at the canonical 0.6in print margin, in CSS px. */
export const PAGE_CONTENT_PX_AT_96DPI = 9.8 * 96; // = 940.8

/**
 * Print-content width in CSS pixels @ 96 dpi.
 *
 * Used by `estimatePages` and `sectionHeights` as the denominator of the
 * print-width scale factor: a measured preview width is divided by this to
 * produce the ratio by which screen-rendered heights are converted to
 * print-equivalent heights (#107).
 *
 * The value (825.6) corresponds to ≈ 8.6 inches at 96 dpi — close to the
 * `.resume-preview` article's content-box width once print.css applies its
 * Letter @ 0.6in body padding. It is intentionally an empirically-tuned
 * constant rather than a derived `(8.5 - 1.2) × 96 = 700.8`; the latter
 * undershoots in practice because the print pipeline anti-aliases and
 * justifies slightly differently than screen rendering.
 */
export const PRINT_CONTENT_WIDTH_PX = 825.6;

/**
 * Clamp range for the print-width scale factor. The factor is
 * `measuredPreviewWidthPx / PRINT_CONTENT_WIDTH_PX`; a clamp prevents
 * pathological inputs (e.g. a 200 px-wide phone preview producing a 0.24×
 * scale that crushes the page estimate to near-zero, or a giant ultra-wide
 * preview inflating it past reason).
 */
const MIN_WIDTH_SCALE = 0.5;
const MAX_WIDTH_SCALE = 2.0;

/**
 * Returns the available content height in CSS pixels for the print page.
 * Parameterized for future use (Legal, A4); defaults to Letter @ 0.6in.
 *
 * @param marginIn — page margin in inches (each side, top/bottom). Default 0.6.
 * @param pageHeightIn — full page height in inches. Default 11 (Letter).
 * @returns content area height in CSS pixels at 96 dpi.
 *
 * @example
 *   pageContentPxAt96dpi();             // 940.8 (Letter, 0.6in)
 *   pageContentPxAt96dpi(0.5);          // 960   (Letter, 0.5in)
 *   pageContentPxAt96dpi(0.6, 14);      // 1267.2 (Legal)
 */
export function pageContentPxAt96dpi(marginIn = 0.6, pageHeightIn = 11): number {
  return (pageHeightIn - marginIn * 2) * 96;
}

/**
 * Compute the print-width scale factor for a measured preview width.
 *
 * The factor is `measuredWidthPx / PRINT_CONTENT_WIDTH_PX`, clamped to
 * `[MIN_WIDTH_SCALE, MAX_WIDTH_SCALE]`. Multiplying a measured height by
 * this factor converts a screen-rendered height into an approximation of
 * the equivalent height at print width — narrower screen ⇒ factor < 1 ⇒
 * shorter print equivalent (because the same content packs more text per
 * row at the wider print width, needing fewer lines).
 *
 * Exported for unit-testability and so callers can reuse the same factor
 * across height + per-section measurements.
 *
 * @example
 *   widthScaleFactor(825.6); // 1     (already at print width)
 *   widthScaleFactor(400);   // 0.484 (typical desktop split-pane)
 *   widthScaleFactor(300);   // 0.5   (clamped — narrow split or mobile)
 *   widthScaleFactor(2000);  // 2     (clamped — extra-wide preview)
 *   widthScaleFactor(0);     // 1     (no measurement — disable scaling)
 */
export function widthScaleFactor(measuredWidthPx: number): number {
  if (!Number.isFinite(measuredWidthPx) || measuredWidthPx <= 0) return 1;
  const raw = measuredWidthPx / PRINT_CONTENT_WIDTH_PX;
  if (raw < MIN_WIDTH_SCALE) return MIN_WIDTH_SCALE;
  if (raw > MAX_WIDTH_SCALE) return MAX_WIDTH_SCALE;
  return raw;
}

/**
 * Estimate the printed page count of `previewEl` (the `.resume-preview`
 * article). Reads its rendered width AND height with `getBoundingClientRect`,
 * scales the height by `measuredWidth / printContentWidth` (clamped) to
 * compensate for screen-vs-print text-reflow, then divides by the available
 * print content height.
 *
 * Returns 0 when the element has no measurable height (e.g. detached or
 * display:none) so callers can no-op cleanly. Otherwise returns a positive
 * float (`1.0` means "exactly one page", `1.42` means "about 1.4 pages").
 *
 * @example
 *   // 1320 px tall × 400 px wide preview (typical desktop split-pane):
 *   //   factor = 400 / 825.6 ≈ 0.484
 *   //   printH = 1320 × 0.484 ≈ 639 print-px
 *   //   pages  = 639 / 940.8 ≈ 0.68
 *   estimatePages(previewEl); // ≈ 0.68
 *
 *   estimatePages(detachedEl); // 0
 */
export function estimatePages(previewEl: HTMLElement | null): number {
  if (!previewEl) return 0;
  const rect = previewEl.getBoundingClientRect();
  if (rect.height <= 0) return 0;
  // Viewport-collapse guard (#126). When the host viewport is zero-width
  // (headless tabs not in foreground, embed contexts, off-screen iframes)
  // the article collapses to ~50 px wide and ~200,000 px tall — and the
  // page-fit pill ends up reading "121.2 pages". The width-scale factor
  // already clamps low, but it can't tell the difference between "narrow
  // mobile pane" and "viewport totally collapsed". 200 px is a hard floor
  // below which we treat the measurement as unreliable and report 0
  // (callers render the pill as "—" or hide it).
  if (rect.width < 200) return 0;
  // Scale the measured height to a print-equivalent height. A narrow
  // preview reflows text into more lines than the wider print page, so a
  // factor < 1 shortens the measured height toward the print equivalent.
  const factor = widthScaleFactor(rect.width);
  const printEquivalentHeight = rect.height * factor;
  return printEquivalentHeight / PAGE_CONTENT_PX_AT_96DPI;
}

/**
 * Format `pages` as the toolbar pill label.
 *
 * Rules (#92):
 *   - `pages ≤ 1.0`           → "Fits 1 page"
 *   - `pages  > 1.0`          → "Fit: {pages.toFixed(1)} pages"
 *   - `pages` is rounded to one decimal for display only.
 *
 * @example
 *   formatPagesLabel(0);    // "Fit: —"          (no measurement yet — #126)
 *   formatPagesLabel(0.83); // "Fits 1 page"
 *   formatPagesLabel(1);    // "Fits 1 page"
 *   formatPagesLabel(1.04); // "Fits 1 page"     (rounds to 1.0)
 *   formatPagesLabel(1.42); // "Fit: 1.4 pages"
 *   formatPagesLabel(2.31); // "Fit: 2.3 pages"
 */
export function formatPagesLabel(pages: number): string {
  // A zero estimate now signals "measurement unavailable" (article detached
  // or viewport collapsed; see the width-floor guard in estimatePages).
  // Render an em-dash rather than the optimistic "Fits 1 page" we used to
  // show — that label looked like a positive answer for a no-answer state
  // (#126).
  if (pages <= 0) return 'Fit: —';
  // Round to one decimal first so a 1.04 estimate reads as "Fits 1 page"
  // rather than the pedantic "Fit: 1.0 pages".
  const rounded = Math.round(pages * 10) / 10;
  if (rounded <= 1.0) return 'Fits 1 page';
  return `Fit: ${rounded.toFixed(1)} pages`;
}

/** Severity bucket for the pill — drives color (accent / warning / danger). */
export type FitSeverity = 'ok' | 'warn' | 'danger';

/**
 * Classify a pages-estimate into a color severity for the pill.
 *
 *   - `≤ 1.0`     → 'ok'      (in accent / success color)
 *   - `1.0 – 2.0` → 'warn'    (over a page but not far)
 *   - `> 2.0`     → 'danger'  (well over)
 *
 * @example
 *   fitSeverity(0.9);  // 'ok'
 *   fitSeverity(1.42); // 'warn'
 *   fitSeverity(2.31); // 'danger'
 */
export function fitSeverity(pages: number): FitSeverity {
  const rounded = Math.round(pages * 10) / 10;
  if (rounded <= 1.0) return 'ok';
  if (rounded <= 2.0) return 'warn';
  return 'danger';
}

/** One measured section for the per-section popover row. */
export interface SectionMeasurement {
  /** Visible heading text — e.g. "Experience", "Education". */
  readonly title: string;
  /** Section height in CSS pixels, scaled to print width (#107). */
  readonly heightPx: number;
  /** That height as a fraction of a single printed page (≥ 0). */
  readonly pages: number;
}

/**
 * Measure each top-level section in the rendered preview. A "section" is the
 * span of content between consecutive `<h2>` headings — the same rhythm the
 * resume markdown convention uses ("## Experience", "## Education", …).
 *
 * Sections are returned in document order. The final section runs from its
 * `h2` to the bottom of the preview. If the preview has no `h2` at all (a
 * malformed resume), an empty array is returned — callers should treat that
 * as "no per-section breakdown available" rather than an error.
 *
 * The same print-width scaling that `estimatePages` applies is applied to
 * each section's height, so the popover's per-section pages-share stays
 * consistent with the headline "Fit: N pages" pill (#107). The `heightPx`
 * field reports the SCALED print-equivalent height, not the raw on-screen
 * pixels, so consumers that sum the row pages will land near the pill total.
 *
 * @example
 *   sectionHeights(previewEl);
 *   // (assuming a 400 px-wide preview, factor ≈ 0.484)
 *   // [
 *   //   { title: 'Summary',    heightPx:  87, pages: 0.09 },
 *   //   { title: 'Experience', heightPx: 348, pages: 0.37 },
 *   //   { title: 'Education',  heightPx: 116, pages: 0.12 },
 *   // ]
 */
export function sectionHeights(previewEl: HTMLElement | null): readonly SectionMeasurement[] {
  if (!previewEl) return [];
  const headings = Array.from(previewEl.querySelectorAll<HTMLHeadingElement>('h2'));
  if (headings.length === 0) return [];

  const previewRect = previewEl.getBoundingClientRect();
  const previewBottom = previewRect.bottom;
  const factor = widthScaleFactor(previewRect.width);
  const results: SectionMeasurement[] = [];

  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i]!;
    const top = heading.getBoundingClientRect().top;
    const nextTop =
      i + 1 < headings.length ? headings[i + 1]!.getBoundingClientRect().top : previewBottom;
    const rawHeight = Math.max(0, nextTop - top);
    // Apply the same width-scale factor as estimatePages so per-section
    // shares sum to roughly the headline pill total.
    const heightPx = rawHeight * factor;
    const title = (heading.textContent ?? '').trim() || `Section ${i + 1}`;
    results.push({
      title,
      heightPx,
      pages: heightPx / PAGE_CONTENT_PX_AT_96DPI,
    });
  }

  return results;
}

/** One trim suggestion shown in the popover when the resume is over a page. */
export interface TrimSuggestion {
  /** Short headline shown as the suggestion's main text. */
  readonly title: string;
  /** Optional one-line elaboration shown below the title. */
  readonly detail?: string;
}

/**
 * Produce 2–3 short, actionable trim suggestions for a preview that is
 * estimated to exceed one page. Returns an empty array when `pages ≤ 1.0`.
 *
 * The suggestions are heuristic — they look at the active layout, the
 * tallest sections, and whether any standard "trim candidates" (Summary,
 * Education, Earlier roles) are present. The popover only renders the first
 * three returned, so callers can pass through the full list.
 *
 * @example
 *   trimSuggestions([...], 'classic', 1.4);
 *   // [
 *   //   { title: 'Switch to Compact layout', detail: 'Trims margins...' },
 *   //   { title: 'Trim oldest role', detail: 'Earlier roles is your tallest section.' },
 *   // ]
 *
 *   trimSuggestions([...], 'classic', 0.9);  // []
 */
export function trimSuggestions(
  sections: readonly SectionMeasurement[],
  currentLayout: string,
  pages: number,
): readonly TrimSuggestion[] {
  if (pages <= 1.0) return [];
  const out: TrimSuggestion[] = [];

  // 1. Layout swap — only when the user is not already on Compact. This is
  //    the lowest-effort win, so it leads.
  if (currentLayout !== 'compact') {
    out.push({
      title: 'Switch to Compact layout',
      detail: 'Tighter margins and spacing reclaim about a quarter-page on average.',
    });
  }

  // Case-insensitive title lookup so "Summary" / "summary" both match.
  const byTitle = (needle: RegExp) => sections.find((s) => needle.test(s.title));

  // 2. Long Summary — a Summary that runs longer than ~3 lines is a common
  //    over-page culprit. We approximate "3 lines" as ~75 CSS px of section
  //    height (1.6 line-height × ~16px × 3 ≈ 77px). The number is intentionally
  //    coarse — this is signal, not precision.
  const summary = byTitle(/^(summary|profile|about)$/i);
  if (summary && summary.heightPx > 110) {
    out.push({
      title: 'Shorten Summary to 3 lines or fewer',
      detail: `Your Summary is about ${summary.pages.toFixed(2)} of a page — a tight 2-3 line lead reads stronger.`,
    });
  }

  // 3. Earlier-roles / older Experience — frequently the trimmable tail.
  const earlier = byTitle(/(earlier roles|prior roles|other (experience|positions))/i);
  if (earlier) {
    out.push({
      title: 'Trim oldest role (Earlier roles)',
      detail: 'Roles older than ~10 years rarely earn their space on a one-pager.',
    });
  } else {
    // No explicit Earlier-roles section: fall back to "trim the tallest one".
    const sorted = [...sections].sort((a, b) => b.heightPx - a.heightPx);
    const tallest = sorted[0];
    if (tallest && tallest.pages > 0.35) {
      out.push({
        title: `Tighten the "${tallest.title}" section`,
        detail: `It's your tallest section at about ${tallest.pages.toFixed(2)} of a page.`,
      });
    }
  }

  // Cap at three — keep the popover scannable.
  return out.slice(0, 3);
}
