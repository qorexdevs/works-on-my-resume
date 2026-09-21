/**
 * StudioStatusLine — vim-modeline-style state strip pinned to the bottom of
 * the studio (#134).
 *
 * Consolidates the scattered "what state is this resume in?" signals into one
 * monospace strip so a reviewer can scan the whole rig at a glance instead of
 * grazing four different toolbar islands:
 *
 *   resume.md  │  L42:18  │  117 lines  │  HEALTH 98 MID  │  FIT 1.4p  │  ●draft  │  AAA 7.9:1
 *
 * Design contract
 * ---------------
 * - Mono, uppercase kickers, ~28 px tall.
 * - Thin vertical separators rendered with `::after { content: '│' }`.
 * - `position: sticky; bottom: 0` so the strip rides the bottom of the
 *   `.studio` container as the editor / preview pane scroll.
 * - Hidden on print via `data-print-hide` (matches the toolbar).
 * - Mobile (≤ 640px): collapses to the three most important segments —
 *   filename, health score, and the draft dot — via CSS `display: none`
 *   on the de-prioritized segments.
 *
 * The status line is purely informational — every segment also has a
 * companion control elsewhere in the chrome (the Fit pill, the Health
 * tab, the editor meta row). This strip never tries to be the primary
 * affordance, only the consolidated readout.
 *
 * Caret position
 * --------------
 * The editor textarea reports its line/column to the parent via the new
 * `onCaretChange` prop on MarkdownEditor; the parent threads `cursorLine`
 * and `cursorColumn` down to this component. Both are 1-based, matching
 * what the analyzer emits and what vim's modeline shows.
 *
 * CSP
 * ---
 * No inline `style={...}` JSX attributes. Variant selection happens by
 * toggling class names; severity colors live in `global.css`.
 */
import { useEffect, useMemo, useState } from 'react';
import type { RefObject } from 'react';
import type { CareerStage, WordsSeverity } from '../utils/health';
import { analyzeResume, targetPages, wordCount, wordsSeverity, wordsTarget } from '../utils/health';
import { estimatePages } from '../utils/pageFit';
import { wcagLevel } from '../utils/wcag';
import { getStoredCareerStage } from '../utils/storage';
import type { ParsedResume } from '../types';

interface Props {
  /** The source-of-truth Markdown — used for line count and the dirty check. */
  markdown: string;
  /** Parsed resume — gates the Health/Fit segments (no parse, no report). */
  parsed: ParsedResume | null;
  /** Filename label (matches what the editor pane tab shows). */
  sourceName: string;
  /** 1-based caret line in the editor textarea. `null` when no caret yet. */
  cursorLine: number | null;
  /** 1-based caret column in the editor textarea. `null` when no caret yet. */
  cursorColumn: number | null;
  /**
   * True when the markdown buffer differs from the last load / snapshot baseline.
   * The parent owns the baseline so this stays a presentation prop.
   */
  dirty: boolean;
  /**
   * The preview-pane wrapping `<div>`. The status line queries it for the
   * inner `.resume-preview` article and runs `estimatePages` against that —
   * same numeric source as the toolbar's Fit pill, so the two segments
   * always agree.
   */
  previewRef: RefObject<HTMLDivElement | null>;
  /** Pair of contrast ratios from the active theme — drives the AAA/AA pill. */
  wcag: {
    /** Body text on background. */
    readonly fgOnBg: number;
    /** Accent on background. */
    readonly accentOnBg: number;
  };
}

/** Short stage glyph for the HEALTH kicker (JR / MID / SR). */
function stageGlyph(stage: CareerStage): string {
  switch (stage) {
    case 'junior':
      return 'JR';
    case 'mid':
      return 'MID';
    case 'senior':
      return 'SR';
  }
}

/**
 * Compact pages label used inside the FIT segment. Reuses the project's
 * convention of one decimal place, but drops the "pages" word so the
 * modeline stays tight: 0.8p / 1.4p / 2.3p. An unmeasurable estimate
 * (article detached / viewport collapsed — see pageFit.ts) reads as "—"
 * so the segment is never silently absent.
 */
function compactPagesLabel(pages: number): string {
  if (pages <= 0) return '—';
  const rounded = Math.round(pages * 10) / 10;
  return `${rounded.toFixed(1)}p`;
}

/**
 * Map a `WordsSeverity` to the BEM modifier suffix the stylesheet keys off
 * (`ok | warn | danger`). Kept as a tiny mapping rather than inlined so the
 * JSX className expression doesn't carry a switch statement. The three
 * classes mirror the Fit chip's severity palette — same hues, same rubric
 * (#155).
 */
function wordsSeverityClass(severity: WordsSeverity): string {
  return `studio__statusline-seg--words-${severity}`;
}

export default function StudioStatusLine({
  markdown,
  parsed,
  sourceName,
  cursorLine,
  cursorColumn,
  dirty,
  previewRef,
  wcag,
}: Props) {
  /* ----- Career stage (#85) -----
     The Resume Health panel owns the user-facing stage picker; the modeline
     just reflects the persisted choice. localStorage is client-only, so the
     initial render uses 'mid' (same SSR-parity dance as ResumeHealth).
     Listening on `storage` events isn't worth the wiring — the Health panel
     and the modeline can both write/read the same key; if they desync mid-
     session, the modeline self-corrects on the next remount. */
  const [stage, setStage] = useState<CareerStage>('mid');
  useEffect(() => {
    const stored = getStoredCareerStage();
    if (stored) setStage(stored);
  }, []);

  /* Same storage key the Health panel writes to. When the user changes
     stage there, the value lands in localStorage; we pick it up on the
     next interaction-driven render via this poll-on-focus listener. */
  useEffect(() => {
    function refresh() {
      const stored = getStoredCareerStage();
      if (stored) setStage(stored);
    }
    window.addEventListener('storage', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener('storage', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  /* ----- Live line count (kept here, not threaded from the parent, so the
     modeline stays self-sufficient if the parent ever splits state). ----- */
  const lineCount = useMemo(
    () => (markdown.length === 0 ? 0 : markdown.split('\n').length),
    [markdown],
  );

  /* ----- Health score -----
     Re-runs the same analyzer the Resume Health panel uses so the number
     is the same number — calling `analyzeResume` twice per render is
     cheap relative to the parse step that produced `parsed`. Gated on
     `parsed` because the analyzer requires a real `ParsedResume`. */
  const healthScore = useMemo<number | null>(() => {
    if (!parsed) return null;
    return analyzeResume(markdown, parsed, stage).score;
  }, [markdown, parsed, stage]);

  /* ----- Page-fit estimate -----
     Drives a ResizeObserver on the preview pane so the FIT segment stays
     in sync with layout / theme / template changes. Same numeric source
     as the toolbar pill — the two readouts are guaranteed to match
     because they both call `estimatePages` against the same article. */
  const [pages, setPages] = useState<number>(0);
  useEffect(() => {
    const pane = previewRef.current;
    if (!pane) {
      setPages(0);
      return;
    }
    function measure() {
      const article = pane?.querySelector<HTMLElement>('.resume-preview') ?? null;
      setPages(estimatePages(article));
    }
    measure();
    // rAF chain catches font / layout settle on initial mount.
    const r1 = window.requestAnimationFrame(() => {
      measure();
      window.requestAnimationFrame(measure);
    });
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure);
      observer.observe(pane);
    }
    return () => {
      window.cancelAnimationFrame(r1);
      observer?.disconnect();
    };
    // Re-measure when the parsed object changes too — the preview re-renders
    // and may be taller/shorter than the previous measurement.
  }, [previewRef, parsed]);

  /* ----- Words meter (#155) -----
     Computes the live word count + the stage's target. Same algorithm the
     length heuristic uses (`wordCount` is exported from health.ts) so the
     modeline can never disagree with the Health rubric on what a word is.
     The target is derived from `wordsTarget(stage)` — 475 for junior, 950
     for mid/senior — and the suffix reads `· N page(s)` off the same
     `targetPages(stage)` mapping. Severity (`ok | warn | danger`) mirrors
     the Fit chip's three-tier vocabulary. */
  const words = useMemo(() => wordCount(markdown), [markdown]);
  const wordsTargetCount = useMemo(() => wordsTarget(stage), [stage]);
  const wordsPagesTarget = useMemo(() => targetPages(stage), [stage]);
  const wordsSev = useMemo(() => wordsSeverity(words, wordsTargetCount), [words, wordsTargetCount]);

  const worstRatio = Math.min(wcag.fgOnBg, wcag.accentOnBg);
  const level = wcagLevel(worstRatio);

  /* Caret label: `L42:18`. When there's no caret yet (the user hasn't
     focused the textarea) we omit the cursor segment entirely — vim's
     modeline shows the cursor unconditionally, but in our case "no
     caret" reads more honest than "L1:1" before the user has clicked. */
  const showCursor = cursorLine !== null && cursorColumn !== null;
  const cursorLabel = showCursor ? `L${cursorLine}:${cursorColumn}` : null;

  /* On mobile we strip down to the three most signal-dense segments. CSS
     handles the actual hiding — we hand each segment a stable class so
     the breakpoint rule has something to target without component-level
     window-listening. */
  return (
    <div className="studio__statusline" data-print-hide role="status" aria-label="Studio status">
      <span className="studio__statusline-seg studio__statusline-seg--filename">
        <span className="studio__statusline-value" title={sourceName}>
          {sourceName}
        </span>
      </span>

      {cursorLabel && (
        <span className="studio__statusline-seg studio__statusline-seg--cursor">
          <span
            className="studio__statusline-value"
            aria-label={`Cursor at line ${cursorLine}, column ${cursorColumn}`}
          >
            {cursorLabel}
          </span>
        </span>
      )}

      <span className="studio__statusline-seg studio__statusline-seg--lines">
        <span className="studio__statusline-value">
          {lineCount} {lineCount === 1 ? 'line' : 'lines'}
        </span>
      </span>

      {healthScore !== null && (
        <span className="studio__statusline-seg studio__statusline-seg--health">
          <span className="studio__statusline-kicker" aria-hidden="true">
            Health
          </span>
          <span
            className="studio__statusline-value"
            aria-label={`Resume Health score ${healthScore} out of 100, ${stageGlyph(stage)} stage`}
          >
            {healthScore} {stageGlyph(stage)}
          </span>
        </span>
      )}

      {parsed && (
        <span className="studio__statusline-seg studio__statusline-seg--fit">
          <span className="studio__statusline-kicker" aria-hidden="true">
            Fit
          </span>
          <span className="studio__statusline-value">{compactPagesLabel(pages)}</span>
        </span>
      )}

      {parsed && (
        <span
          className={`studio__statusline-seg studio__statusline-seg--words ${wordsSeverityClass(wordsSev)}`}
        >
          <span className="studio__statusline-kicker" aria-hidden="true">
            Words
          </span>
          <span
            className="studio__statusline-value"
            aria-label={`${words} of ${wordsTargetCount} target words for a ${wordsPagesTarget} page resume`}
          >
            {words} / {wordsTargetCount}
            <span className="studio__statusline-words-suffix" aria-hidden="true">
              {' · '}
              {wordsPagesTarget} {wordsPagesTarget === 1 ? 'page' : 'pages'}
            </span>
          </span>
        </span>
      )}

      {dirty && (
        <span className="studio__statusline-seg studio__statusline-seg--draft">
          <span
            className="studio__statusline-value"
            aria-label="Unsaved changes since last load or snapshot"
          >
            <span className="studio__statusline-dot" aria-hidden="true">
              ●
            </span>
            draft
          </span>
        </span>
      )}

      <span
        className={`studio__statusline-seg studio__statusline-seg--wcag studio__statusline-seg--wcag-${
          level === 'AAA' ? 'aaa' : level === 'AA' ? 'aa' : 'fail'
        }`}
      >
        <span
          className="studio__statusline-value"
          aria-label={`WCAG ${level} — worst contrast ${worstRatio.toFixed(1)} to 1`}
        >
          {level === 'fails AA' ? 'FAIL' : level} {worstRatio.toFixed(1)}:1
        </span>
      </span>
    </div>
  );
}
