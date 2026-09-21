/**
 * TailorForRole — paste-a-JD keyword overlap (#91, #116).
 *
 * A collapsed `<details>` disclosure that lives in the editor pane. Open
 * it, paste a job description, and the component computes a local,
 * AI-free overlap between the JD's terms and the rendered resume:
 *
 *   - **Per-category sections** (#116). Each of Tech / Soft / Domain is its
 *     own collapsible group containing the Matches found and the Gaps
 *     identified for that bucket. Default-open when the bucket has any
 *     terms; otherwise omitted. The summary chip becomes
 *     `Tech 5/12 · Soft 3/8 · Domain 2/4` so the user can see WHICH KIND
 *     of gap they have at a glance — the flat 40-item list from #91 was
 *     swamping useful structure on realistic JDs.
 *   - A "hit rate" chip (`12 / 35 (34%)`) for the overall overlap.
 *   - Visual overlay marks on the rendered preview pane: every match
 *     substring is wrapped in `<mark class="tailor-match">` via a
 *     `TreeWalker` + `Range` pass over `.resume-preview` text nodes.
 *
 * PRIVACY: the JD lives in component state ONLY. No localStorage, no
 * sessionStorage, no URL parameter, no network call. When the disclosure
 * closes or the JD is cleared, the marks are removed and the JD is
 * dropped from memory.
 *
 * CSP: no `style={...}` attributes. The `.tailor-match` styling is
 * static CSS (a green underline). The only ref-driven CSSOM use here is
 * the textarea auto-resize, which writes via `el.style.setProperty`.
 *
 * Trust boundary: the JD is untrusted user input. We render it ONLY
 * inside `.textContent` (the textarea is itself a text input — there is
 * no `innerHTML` path for JD-derived strings). Match overlay marks wrap
 * substrings of resume text, which is already post-DOMPurify.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  extractTerms,
  formatHitRate,
  matchResume,
  summarizeOverlapByCategory,
  type TailorCategory,
  type TailorCategoryStats,
  type TailorMatch,
} from '../utils/tailor';
import Icon from './Icon';

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** Debounce window between textarea edits and recompute. */
const COMPUTE_DEBOUNCE_MS = 400;

/** Class applied to the `<mark>` wrapper inserted into resume text nodes. */
const MARK_CLASS = 'tailor-match';

/** Sentinel attribute used to find/remove our marks without disturbing others. */
const MARK_DATA_ATTR = 'data-tailor-mark';

/**
 * Display labels and stable ordering for the per-category sections.
 * Order is fixed (tech → soft → domain) regardless of which buckets have
 * content; missing-bucket sections are omitted, not hidden, so the visual
 * flow doesn't shift between renders.
 */
const CATEGORY_LABELS: Readonly<Record<TailorCategory, string>> = {
  tech: 'Tech',
  soft: 'Soft',
  domain: 'Domain',
};
const CATEGORY_ORDER: readonly TailorCategory[] = ['tech', 'soft', 'domain'];

/* ------------------------------------------------------------------ */
/* Props                                                               */
/* ------------------------------------------------------------------ */

interface TailorForRoleProps {
  /**
   * The preview pane element. Used to (a) read the rendered resume's
   * `.textContent` for matching, and (b) walk the DOM applying overlay
   * marks. Owned by ResumeStudio.
   */
  previewRef: React.RefObject<HTMLElement | null>;
  /**
   * A version stamp the parent bumps whenever the resume preview's
   * rendered content changes (markdown edit, template swap, anything
   * that re-renders the preview body). We re-run matching when it bumps.
   * In practice ResumeStudio passes `parsed` directly; we read its
   * identity, not its fields.
   */
  resumeVersion: unknown;
  /**
   * Which tab is currently rendered in the preview pane (#108). When the
   * user is on the Health tab the `.resume-preview` article is unmounted,
   * so we (a) skip the JD compute — there is nothing to paint against, and
   * the cached results are still valid — and (b) re-run the paint pass
   * when the tab transitions back to `'preview'` so the marks reappear
   * without waiting for the next JD/resume change.
   */
  previewTab: 'preview' | 'health';
}

/* ------------------------------------------------------------------ */
/* DOM overlay — mark / unmark resume text nodes                       */
/* ------------------------------------------------------------------ */

/**
 * Remove every overlay mark we previously inserted into `root`. Idempotent
 * — safe to call when nothing has been marked yet. Touches only nodes
 * carrying our sentinel attribute so we never disturb DOMPurify-emitted
 * elements (e.g. legitimate `<mark>` from Markdown `==highlight==`).
 */
function clearMarks(root: HTMLElement): void {
  const marks = root.querySelectorAll<HTMLElement>(`mark[${MARK_DATA_ATTR}]`);
  marks.forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    // Unwrap: move children out then drop the mark.
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    // Defragment text nodes so subsequent walks see contiguous strings.
    parent.normalize();
  });
}

/**
 * Walk every text node under `root` and wrap each occurrence of any
 * `needle` (case-insensitive) in `<mark class="tailor-match" data-tailor-mark>`.
 *
 * The walk uses `TreeWalker` so we visit text nodes once in DOM order, and
 * `Range.surroundContents` to slice without re-parsing HTML. This avoids
 * `innerHTML` and any DOM-string concatenation: the JD-derived needle is
 * used only as input to `String.indexOf`; the wrapper element is created
 * with `document.createElement`, so the only text inserted into the DOM
 * is text that was already in the resume's `.textContent`.
 *
 * `needles` is the array of normalized (lowercase) match terms to wrap.
 * Returns the number of marks inserted, mostly for debug / test
 * observability.
 */
function applyMarks(root: HTMLElement, needles: readonly string[]): number {
  if (needles.length === 0) return 0;
  // Sort longest-first so "incident response" wins over "incident" when both
  // are in the needle set — without this, the shorter one would mark first
  // and we'd never wrap the bigram (the inner mark would split the range).
  const sorted = [...needles].sort((a, b) => b.length - a.length);

  // Skip text inside our own marks (defensive — should never recurse since
  // we always clear before applying, but TreeWalker can revisit nested
  // text mid-mutation in some browsers).
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let parent: Node | null = node.parentNode;
      while (parent && parent !== root) {
        if (parent instanceof HTMLElement && parent.hasAttribute(MARK_DATA_ATTR)) {
          return NodeFilter.FILTER_REJECT;
        }
        // Don't mark inside warning banners or other chrome elements.
        if (parent instanceof HTMLElement && parent.classList.contains('preview-warnings')) {
          return NodeFilter.FILTER_REJECT;
        }
        parent = parent.parentNode;
      }
      return node.nodeValue && node.nodeValue.length > 0
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  // Collect the text nodes first — mutating the tree while walking it is
  // a recipe for missed/double visits. The collection is cheap; a typical
  // resume has on the order of 100 text nodes.
  const textNodes: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    textNodes.push(current as Text);
    current = walker.nextNode();
  }

  let total = 0;
  for (const textNode of textNodes) {
    total += markTextNode(textNode, sorted);
  }
  return total;
}

/**
 * Wrap every needle occurrence inside `textNode` in a `<mark>`. We rebuild
 * the node's character stream into alternating "plain" / "match" segments,
 * then replace the original node with a fragment carrying those segments.
 * `Range.surroundContents` would work too but offsets shift after each
 * wrap; the fragment approach is straightforward and a single pass.
 */
function markTextNode(textNode: Text, needles: readonly string[]): number {
  const text = textNode.nodeValue ?? '';
  if (text.length === 0) return 0;
  const lower = text.toLowerCase();

  // Find all non-overlapping match spans across all needles.
  type Span = { start: number; end: number };
  const spans: Span[] = [];
  for (const needle of needles) {
    if (needle.length === 0) continue;
    let from = 0;
    while (true) {
      const idx = lower.indexOf(needle, from);
      if (idx === -1) break;
      spans.push({ start: idx, end: idx + needle.length });
      from = idx + needle.length;
    }
  }
  if (spans.length === 0) return 0;

  // Merge overlapping spans (a later, longer match might subsume an earlier
  // shorter one even with the longest-first sort if two needles share a
  // prefix). Sort by start, then merge adjacent/overlapping.
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start < last.end) {
      if (s.end > last.end) last.end = s.end;
    } else {
      merged.push({ ...s });
    }
  }

  // Build replacement fragment.
  const doc = textNode.ownerDocument ?? document;
  const frag = doc.createDocumentFragment();
  let cursor = 0;
  for (const span of merged) {
    if (span.start > cursor) {
      frag.appendChild(doc.createTextNode(text.slice(cursor, span.start)));
    }
    const mark = doc.createElement('mark');
    mark.className = MARK_CLASS;
    mark.setAttribute(MARK_DATA_ATTR, '');
    mark.appendChild(doc.createTextNode(text.slice(span.start, span.end)));
    frag.appendChild(mark);
    cursor = span.end;
  }
  if (cursor < text.length) {
    frag.appendChild(doc.createTextNode(text.slice(cursor)));
  }

  textNode.parentNode?.replaceChild(frag, textNode);
  return merged.length;
}

/**
 * Read the rendered resume's plain text. Falls back to the empty string
 * when the ref isn't mounted yet. We scope to the `.resume-preview`
 * article inside the pane wrapper so chrome (preview-mode badge, parser
 * warnings) doesn't get folded into the resume body for matching.
 */
function readResumeText(previewEl: HTMLElement | null): string {
  if (!previewEl) return '';
  const article = previewEl.querySelector<HTMLElement>('.resume-preview');
  if (!article) return '';
  // `textContent` collapses element boundaries to nothing — explicitly walk
  // text nodes so we re-introduce a space between adjacent inline elements
  // (e.g. badges, contact-sep glyphs). Without this, "Kubernetes" plus a
  // following badge node would read as `Kubernetesbadge`, breaking matches.
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT, null);
  const parts: string[] = [];
  let node = walker.nextNode();
  while (node) {
    const value = node.nodeValue;
    if (value) parts.push(value);
    node = walker.nextNode();
  }
  // Use spaces as joiners — match-counting on the resume side normalizes
  // whitespace anyway, so this is harmless and gives us reliable token
  // boundaries between adjacent inline nodes.
  return parts.join(' ');
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export default function TailorForRole({
  previewRef,
  resumeVersion,
  previewTab,
}: TailorForRoleProps) {
  const [open, setOpen] = useState<boolean>(false);
  const [jd, setJd] = useState<string>('');
  /* The currently-computed matches and the originating term set. State,
     not memo, because the recompute is debounced — we want a stable
     render between keystrokes rather than a fresh sort on every input.
     `null` means "nothing computed yet" (different from "computed and
     empty", which is `[]`). */
  const [matches, setMatches] = useState<TailorMatch[] | null>(null);

  const detailsRef = useRef<HTMLDetailsElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const helpId = useId();
  const resultsHeadingId = useId();

  /* The set of normalized match needles currently painted onto the
     preview, kept in a ref so we can clear them deterministically on
     unmount / clear / disclosure-close — even if `matches` has already
     been replaced. */
  const paintedNeedlesRef = useRef<string[]>([]);

  /* ----- Debounced recompute ----- */
  useEffect(() => {
    if (!open) return;
    /* #108 — when the preview pane is on the Health tab the
       `.resume-preview` article is unmounted, so the recompute would
       read an empty body and produce a stale-looking zero-match result.
       Skip entirely; the previously-computed Matches/Gaps stay on
       screen, and the paint effect below re-applies the marks the
       moment the user returns to the Preview tab. */
    if (previewTab !== 'preview') return;
    // Empty JD → drop matches and any overlay. No timer needed.
    if (jd.trim().length === 0) {
      setMatches(null);
      return;
    }
    const handle = window.setTimeout(() => {
      const terms = extractTerms(jd);
      const resumeText = readResumeText(previewRef.current);
      const next = matchResume(terms, resumeText);
      setMatches(next);
    }, COMPUTE_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
    // Re-runs on JD change, disclosure open, tab return-to-Preview, and
    // resume re-render.
  }, [jd, open, previewRef, resumeVersion, previewTab]);

  /* ----- Paint / clear overlay marks on the preview ----- */
  useEffect(() => {
    /* #108 — when the user is on the Health tab the article is
       unmounted; nothing to paint, nothing to clear. Bail early so we
       don't churn. The dependency on `previewTab` ensures this effect
       re-runs the moment the user flips back to Preview, at which point
       the freshly-mounted article picks up the marks again. */
    if (previewTab !== 'preview') return;

    const article = previewRef.current?.querySelector<HTMLElement>('.resume-preview') ?? null;
    if (!article) return;

    // Always clear first; idempotent and the only safe way to handle
    // the "resume just re-rendered" case where stale fragments could be
    // floating around the new tree.
    clearMarks(article);
    paintedNeedlesRef.current = [];

    if (!open || !matches || matches.length === 0) return;
    const needles = matches.filter((m) => m.matched).map((m) => m.term.term);
    if (needles.length === 0) return;
    applyMarks(article, needles);
    paintedNeedlesRef.current = needles;

    return () => {
      // On effect re-run / unmount, sweep up. The article ref may itself
      // have been replaced; query fresh inside the cleanup.
      const live = previewRef.current?.querySelector<HTMLElement>('.resume-preview');
      if (live) clearMarks(live);
      paintedNeedlesRef.current = [];
    };
    // We deliberately re-run when `resumeVersion` changes too — a fresh
    // parsed.html replaces the body subtree, dropping our marks; this
    // effect then re-paints them. Same for `previewTab`: returning to
    // Preview mounts a new article DOM that needs the marks re-applied.
  }, [matches, open, previewRef, resumeVersion, previewTab]);

  /* ----- Auto-grow the textarea (CSP-friendly: CSSOM via ref) ----- */
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el || !open) return;
    // Auto-size to content: reset, then size to scrollHeight. Capped by
    // the static max-height in CSS so very long JDs don't push the
    // editor off-screen.
    el.style.setProperty('height', 'auto');
    el.style.setProperty('height', `${el.scrollHeight}px`);
  }, [jd, open]);

  /* ----- Cleanup overlay on unmount (insurance) ----- */
  useEffect(() => {
    return () => {
      const live = previewRef.current?.querySelector<HTMLElement>('.resume-preview');
      if (live) clearMarks(live);
    };
  }, [previewRef]);

  const handleClear = useCallback(() => {
    setJd('');
    setMatches(null);
  }, []);

  const handleToggle = useCallback((event: React.SyntheticEvent<HTMLDetailsElement>) => {
    setOpen(event.currentTarget.open);
  }, []);

  /* Derived results: hits / gaps / summary. Cheap to recompute on
     render — matches is small (typically ≤ 80 terms). */
  const matchedTerms = useMemo<TailorMatch[]>(
    () => (matches ? matches.filter((m) => m.matched) : []),
    [matches],
  );
  /* Per-category roll-up (#116). Cheap; only re-runs when matches change.
     Carries the matches and gaps for each bucket in JD-frequency order,
     so the lists render in stable, predictable sequence. */
  const byCategory = useMemo(
    () => (matches ? summarizeOverlapByCategory(matches) : null),
    [matches],
  );

  const hitRateLabel =
    matches && matches.length > 0 ? formatHitRate(matchedTerms.length, matches.length) : null;

  /* Compact `Tech 5/12 · Soft 3/8 · Domain 2/4` sub-chip. We only render
     categories with at least one term to keep the chip from looking
     padded — a Tech-only JD shouldn't show `Soft 0/0 · Domain 0/0`.
     Two shapes: a string for screen-reader / aria-label use, and a
     parts array so the rendered chip can typeset the bucket NAME in
     serif (it's a category label) and the matched/total readout in
     mono (it's a tabular count). #165 mono-sweep. */
  const categoryChipParts = useMemo(() => {
    if (!byCategory) return null;
    const parts: Array<{ label: string; count: string }> = [];
    for (const cat of CATEGORY_ORDER) {
      const stats = byCategory[cat];
      if (stats.total === 0) continue;
      parts.push({
        label: CATEGORY_LABELS[cat],
        count: `${stats.matched}/${stats.total}`,
      });
    }
    return parts.length > 0 ? parts : null;
  }, [byCategory]);
  const categoryChipText = useMemo(() => {
    if (!categoryChipParts) return null;
    return categoryChipParts.map((p) => `${p.label} ${p.count}`).join(' · ');
  }, [categoryChipParts]);

  /* ----- Render ----- */
  return (
    <details
      ref={detailsRef}
      className="tailor"
      open={open}
      onToggle={handleToggle}
      data-print-hide
    >
      <summary className="tailor__summary">
        <Icon name="search" size={14} />
        <span className="tailor__summary-label">Tailor for a role</span>
        {hitRateLabel && (
          <span className="tailor__summary-chip" aria-label={`Match rate ${hitRateLabel}`}>
            {hitRateLabel}
          </span>
        )}
        <Icon name="chevron-down" size={14} className="tailor__summary-caret" />
      </summary>

      <div className="tailor__body">
        <label className="tailor__field-label" htmlFor={`${helpId}-textarea`}>
          Paste a job description
        </label>
        <textarea
          id={`${helpId}-textarea`}
          ref={textareaRef}
          className="text-input tailor__textarea"
          aria-label="Paste a job description"
          aria-describedby={helpId}
          rows={6}
          value={jd}
          onChange={(event) => setJd(event.target.value)}
          placeholder="Paste the JD here…"
          spellCheck={false}
        />
        <div className="tailor__row">
          <p id={helpId} className="tailor__hint">
            <Icon name="info" size={12} />
            Stays in your browser — never saved or transmitted.
          </p>
          {jd.length > 0 && (
            <button
              type="button"
              className="btn tailor__clear"
              onClick={handleClear}
              aria-label="Clear job description"
            >
              <Icon name="close" size={12} />
              Clear
            </button>
          )}
        </div>

        {/* Polite live region — announces hit rate + category breakdown
            when they resolve so screen-reader users hear the update
            without polling. */}
        <p className="visually-hidden" aria-live="polite" aria-atomic="true">
          {hitRateLabel
            ? `Keyword overlap: ${hitRateLabel}${categoryChipText ? `. ${categoryChipText}` : ''}`
            : ''}
        </p>

        {matches === null || jd.trim().length === 0 ? (
          <p className="tailor__empty">
            Paste a job description above to see which of its keywords your resume already covers
            and which to consider adding.
          </p>
        ) : matches.length === 0 ? (
          <p className="tailor__empty">
            Couldn’t pull recognizable keywords from this text. Try pasting more of the job
            description — the technical sections and required-skills lists are usually the
            highest-signal bits.
          </p>
        ) : (
          <div className="tailor__results" aria-labelledby={resultsHeadingId}>
            <h3 id={resultsHeadingId} className="visually-hidden">
              Keyword overlap results
            </h3>

            {categoryChipParts && categoryChipText && (
              <p className="tailor__category-chip" aria-label={`By category: ${categoryChipText}`}>
                {categoryChipParts.map((part, idx) => (
                  <span key={part.label}>
                    {idx > 0 && (
                      <>
                        {' '}
                        <span className="tailor__category-chip-sep" aria-hidden="true">
                          ·
                        </span>{' '}
                      </>
                    )}
                    <span className="tailor__category-chip-label">{part.label}</span>{' '}
                    <span className="tailor__category-chip-count">{part.count}</span>
                  </span>
                ))}
              </p>
            )}

            {/* Per-category sections (#116). One <details> per non-empty
                bucket, default-open. We render Tech → Soft → Domain in a
                fixed order regardless of which buckets are present, so
                the visual flow doesn't jitter when terms move between
                categories on a JD edit. */}
            {byCategory &&
              CATEGORY_ORDER.map((cat) => {
                const stats = byCategory[cat];
                if (stats.total === 0) return null;
                return (
                  <CategoryGroup
                    key={cat}
                    category={cat}
                    label={CATEGORY_LABELS[cat]}
                    stats={stats}
                  />
                );
              })}
          </div>
        )}
      </div>
    </details>
  );
}

/* ------------------------------------------------------------------ */
/* CategoryGroup — one collapsible bucket (Tech / Soft / Domain)       */
/* ------------------------------------------------------------------ */

interface CategoryGroupProps {
  category: TailorCategory;
  label: string;
  stats: TailorCategoryStats;
}

/**
 * One per-category section. Renders as a `<details>` that is open by
 * default (the ticket's spec: "all groups open if there are any items in
 * them, otherwise collapsed"). The header carries the bucket label and
 * its hit-rate fraction; the body splits into Matches and Gaps lists.
 *
 * We keep the `tailor__list--matches` / `tailor__list--gaps` CSS classes
 * unchanged so the existing chip styling (green / amber tints, print
 * suppression) continues to work — only the layout (now nested under a
 * category disclosure) changes.
 */
function CategoryGroup({ category, label, stats }: CategoryGroupProps): React.JSX.Element {
  const summaryId = useId();
  // "Open by default" is encoded by `defaultOpen`. We don't use
  // controlled state here — the user toggles each bucket independently
  // and the choice should survive recompute as long as the bucket itself
  // survives. Per-bucket open state lives in browser DOM, which is
  // exactly the affordance native `<details>` provides.
  const fractionLabel = `${stats.matched}/${stats.total}`;
  return (
    <details className={`tailor__group tailor__group--${category}`} data-category={category} open>
      <summary className="tailor__group-summary" aria-describedby={summaryId}>
        <Icon name="chevron-down" size={12} className="tailor__group-caret" />
        <span className="tailor__group-label">{label}</span>
        <span id={summaryId} className="tailor__group-count">
          {fractionLabel}
        </span>
      </summary>

      <div className="tailor__group-body">
        <section className="tailor__section">
          <header className="tailor__section-header">
            <h4 className="tailor__section-title">Matches</h4>
            <span className="tailor__section-count" aria-hidden="true">
              {stats.matches.length}
            </span>
          </header>
          {stats.matches.length === 0 ? (
            <p className="tailor__section-empty">
              No JD keywords in this bucket appear in your resume yet.
            </p>
          ) : (
            <ul className="tailor__list tailor__list--matches">
              {stats.matches.map((m) => (
                <li key={m.term.term} className="tailor__list-item">
                  <span className="tailor__list-term">{m.term.displayTerm}</span>
                  <span className="tailor__list-count" aria-label={`${m.occurrences} times`}>
                    ×{m.occurrences}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="tailor__section">
          <header className="tailor__section-header">
            <h4 className="tailor__section-title">Gaps</h4>
            <span className="tailor__section-count" aria-hidden="true">
              {stats.gaps.length}
            </span>
          </header>
          {stats.gaps.length === 0 ? (
            <p className="tailor__section-empty">
              Nothing notable missing in this bucket — every JD keyword we recognized here is in
              your resume.
            </p>
          ) : (
            <ul className="tailor__list tailor__list--gaps">
              {stats.gaps.map((term) => (
                <li key={term.term} className="tailor__list-item">
                  <span className="tailor__list-term">{term.displayTerm}</span>
                  <span
                    className="tailor__list-count tailor__list-count--gap"
                    aria-label={`${term.frequency} times in JD`}
                  >
                    ×{term.frequency}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </details>
  );
}
