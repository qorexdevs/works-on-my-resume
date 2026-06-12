/**
 * ResumeHealth — the stage-aware Resume Health panel (#85).
 *
 * Reads the current Markdown + its `ParsedResume`, runs `analyzeResume`, and
 * surfaces a single composite score plus a list of findings. The author
 * picks a career stage (junior / mid / senior) and the rubric retunes —
 * stage selection is persisted via `setStoredCareerStage` so it survives a
 * reload.
 *
 * UI contract
 * -----------
 * Class names are stable hooks the integration agent will style in
 * `global.css`. The component itself ships zero inline `style=` attributes
 * (CSP: see CONTRIBUTING.md — `style-src` does not allow `'unsafe-inline'`).
 *
 * Privacy
 * -------
 * No resume content is persisted by this component. The career-stage slug is
 * the only thing written to localStorage, matching the project's posture.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ParsedResume } from '../types';
import {
  analyzeResume,
  stageProgress,
  summarizePositives,
  type CareerStage,
  type HealthFinding,
  type StageProgress,
  type Positive,
} from '../utils/health';
import { getRewriteCandidates, type RewriteCandidate } from '../utils/bulletPatterns';
import { getStoredCareerStage, setStoredCareerStage } from '../utils/storage';

interface Props {
  /** Raw Markdown source (current editor contents). */
  markdown: string;
  /** Parsed view of `markdown`, or `null` when nothing has been loaded. */
  parsed: ParsedResume | null;
  /**
   * Hook for "Jump to line N" buttons. The editor focuses the textarea,
   * selects the entire target line, and scrolls into view.
   */
  onJumpToLine?: (line: number) => void;
  /**
   * Hook for clickable findings (#115). Selects the literal offender
   * substring on the target line rather than the whole line. The editor
   * gracefully falls back to whole-line selection when the offender has
   * been edited away since the finding was computed.
   */
  onJumpToOffender?: (line: number, offender: string) => void;
  /**
   * Hook for "Suggest a fix" (#115). Inserts a candidate rewrite as a new
   * bullet directly above the original line. Routed through the editor's
   * value/onChange path — never into the preview DOM, so DOMPurify still
   * owns the trust boundary on the way to rendered HTML.
   */
  onInsertRewrite?: (targetLine: number, rewrittenLine: string) => void;
  /**
   * Hook for "Open an example" (#115, #120). The parent decides what to do
   * with the section name: when the writer's resume already has it, jump
   * the editor textarea to that H2; otherwise open a dialog showing the
   * bundled sample's section so the writer sees a worked example. The
   * Health panel always shows the button — the parent owns the fallback.
   */
  onJumpToSection?: (sectionTitle: string) => void;
}

/** Ordered stage choices for the segmented control. */
const STAGES: ReadonlyArray<{ value: CareerStage; label: string }> = [
  { value: 'junior', label: 'Junior' },
  { value: 'mid', label: 'Mid' },
  { value: 'senior', label: 'Senior' },
];

export default function ResumeHealth({
  markdown,
  parsed,
  onJumpToLine,
  onJumpToOffender,
  onInsertRewrite,
  onJumpToSection,
}: Props) {
  /* ----- Stage state -----
     The initial value is `'mid'` so SSR and the first client paint agree
     (localStorage is client-only). A mount-time effect promotes the stored
     value once the client is alive — same pattern as the shortcuts prefs
     and the ATS mode in ResumeStudio. */
  const [stage, setStage] = useState<CareerStage>('mid');

  useEffect(() => {
    const stored = getStoredCareerStage();
    if (stored) setStage(stored);
  }, []);

  /** Persist on user-initiated change (NOT on the mount-time hydration). */
  function changeStage(next: CareerStage): void {
    setStage(next);
    setStoredCareerStage(next);
  }

  /* ----- Live analysis: pure, cheap, recomputed on input changes.
       The hook MUST run on every render (rules of hooks), so we compute
       a placeholder report when `parsed` is null and short-circuit the
       render below — never inside the hook list. */
  const report = useMemo(() => {
    if (!parsed) return null;
    return analyzeResume(markdown, parsed, stage);
  }, [markdown, parsed, stage]);

  /* ----- Positive signals (#137). Mirror the findings rubric but invert
     each threshold — entries are celebrated, not flagged. */
  const positives = useMemo<readonly Positive[]>(() => {
    if (!parsed) return [];
    return summarizePositives(markdown, parsed, stage);
  }, [markdown, parsed, stage]);

  /* ----- Stage progression meter (#137). Pure derivation off the score
     and the current stage tier — no extra parsing work. */
  const progress = useMemo<StageProgress | null>(() => {
    if (!report) return null;
    return stageProgress(report.score, stage);
  }, [report, stage]);

  /* ----- Next-step suggestion (#137). The single highest-impact finding
     the writer can act on. We pick the first finding that carries a `line`
     (so it's clickable) — findings are emitted in rubric order so the
     first actionable one is the most-impactful one we have. The CTA
     phrasing is derived from the finding's id so the language is concrete
     ("Add a number to your 3rd bullet under …") rather than echoing the
     finding's existing message verbatim. */
  const nextStep = useMemo(() => {
    if (!report) return null;
    const first = report.findings.find((f) => f.line !== undefined);
    if (!first) return null;
    return { finding: first, label: nextStepLabel(first, markdown) };
  }, [report, markdown]);

  /* ----- Empty state: no resume loaded yet ----- */
  if (!parsed || !report) {
    return (
      <section
        className="health"
        aria-label="Resume Health"
        // The empty state still mounts the panel so layout doesn't shift
        // when a resume is loaded — only the body content changes.
      >
        <header className="health__header">
          <p className="health__score-stage">Resume Health</p>
        </header>
        <p className="health__empty">Load a resume to see Health feedback.</p>
      </section>
    );
  }

  return (
    <section className="health" aria-label="Resume Health">
      <header className="health__header">
        <p className="health__score">
          <span className="health__score-num" aria-label={`Score ${report.score} out of 100`}>
            {report.score}
          </span>
          <span className="health__score-stage">Resume Health · {labelFor(stage)}</span>
        </p>

        <div className="health__stage-picker" role="radiogroup" aria-label="Career stage">
          {STAGES.map((opt) => {
            const active = stage === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={active}
                className={
                  active ? 'health__stage-btn health__stage-btn--active' : 'health__stage-btn'
                }
                onClick={() => changeStage(opt.value)}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </header>

      {report.findings.length === 0 ? (
        <p className="health__empty">Looking solid for a {labelFor(stage).toLowerCase()} resume.</p>
      ) : (
        <>
          {/* Small-caps mono kicker (#129) above the findings list — pairs
              with the matching kickers in the toolbar / drawer / tailor
              groups so the panel reads as part of the same typographic
              family. */}
          <h3 className="section-kicker health__findings-kicker">
            Findings ({report.findings.length})
          </h3>
          <ul className="health__list">
            {report.findings.map((finding, i) => (
              <FindingItem
                // The same rule id can fire multiple times (weak-verb on
                // every offending line); include the index for uniqueness.
                key={`${finding.id}-${finding.line ?? 'doc'}-${i}`}
                finding={finding}
                onJumpToLine={onJumpToLine}
                onJumpToOffender={onJumpToOffender}
                onInsertRewrite={onInsertRewrite}
                onJumpToSection={onJumpToSection}
              />
            ))}
          </ul>
        </>
      )}

      {/* ----- (a) What's working strip (#137) -----
           Lifts 3-5 positive signals out of the same heuristics that produce
           findings — inverted thresholds, soft accent tone, mono. The strip
           always renders when ≥ 1 positive is found so even an early draft
           sees one celebrate. Stays hidden on a truly empty parse. */}
      {positives.length > 0 && (
        <section className="resume-health__celebrate" aria-label="What's working">
          <h3 className="section-kicker resume-health__celebrate-kicker">What's working</h3>
          <ul className="resume-health__celebrate-list">
            {positives.map((positive) => (
              <li
                key={positive.id}
                className="resume-health__celebrate-item"
                data-positive={positive.id}
              >
                <span className="resume-health__celebrate-glyph" aria-hidden="true">
                  ✓
                </span>
                <span className="resume-health__celebrate-text">{positive.message}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ----- (b) Stage progress meter (#137) -----
           Thin horizontal meter + tier label + milestone delta. The meter is
           computed off the score and the current stage's threshold; at the top
           tier we render an at-the-top affordance instead of a "→ N" hint. */}
      {progress && (
        <section className="resume-health__progress" aria-label="Stage progress">
          <h3 className="section-kicker resume-health__progress-kicker">Stage progress</h3>
          <ProgressMeter progress={progress} findingsCount={report.findings.length} />
        </section>
      )}

      {/* ----- (c) Next step (#137) -----
           One actionable suggestion lifted from the highest-impact finding.
           Clicking jumps to the offender line via the existing #115
           jumpToOffender plumbing — Health doesn't mutate the source, the
           editor does. The block stays hidden when there is no actionable
           finding (e.g. a clean resume) so it doesn't read as a low-value
           "you're done" line. */}
      {nextStep && (
        <section className="resume-health__next" aria-label="Next step">
          <h3 className="section-kicker resume-health__next-kicker">Next step</h3>
          <button
            type="button"
            className="resume-health__next-cta"
            onClick={() => {
              if (nextStep.finding.line === undefined) return;
              if (nextStep.finding.offender && onJumpToOffender) {
                onJumpToOffender(nextStep.finding.line, nextStep.finding.offender);
              } else if (onJumpToLine) {
                onJumpToLine(nextStep.finding.line);
              }
            }}
          >
            <span className="resume-health__next-glyph" aria-hidden="true">
              ▸
            </span>
            <span className="resume-health__next-text">{nextStep.label}</span>
          </button>
        </section>
      )}
    </section>
  );
}

/**
 * Thin horizontal progress meter (#137). Renders 10 cells out of which a
 * proportional run is filled, mirroring the issue's mock:
 *
 *   `MID  ████████░░  98 → 100 to advance to SENIOR`
 *
 * The fill count is the score scaled to the threshold's window; we use ten
 * cells because it reads as a clean 0-100 ladder in mono.
 */
function ProgressMeter({
  progress,
  findingsCount,
}: {
  progress: StageProgress;
  findingsCount: number;
}) {
  const cells = 10;
  // Fill is the score's fraction of 100 (not of `threshold`) so the meter
  // reads as an absolute scale — 50% always means half-filled regardless of
  // tier. The threshold is rendered as the milestone hint to the right.
  const filled = Math.min(cells, Math.max(0, Math.round((progress.score / 100) * cells)));
  const empty = cells - filled;
  const meterText = '█'.repeat(filled) + '░'.repeat(empty);
  const atTop = progress.next === null;
  // Milestone delta — how many findings the writer would need to clear to
  // reach the threshold. Each finding subtracts 2 points (severity 'warn')
  // on average; we round up to err on the side of "a few more" rather than
  // promising a one-step jump. The hint only renders when there's daylight
  // between score and threshold.
  const findingsToClear = progress.delta > 0 ? Math.max(1, Math.ceil(progress.delta / 2)) : 0;
  return (
    <div className="resume-health__progress-row">
      <span className="resume-health__progress-label">{progress.label}</span>
      <span className="resume-health__progress-meter" aria-hidden="true">
        {meterText}
      </span>
      {atTop ? (
        <span className="resume-health__progress-hint">
          {progress.score} / 100 — at the top tier
        </span>
      ) : (
        <span className="resume-health__progress-hint">
          {progress.score} → {progress.threshold} to advance to {STAGE_LABEL_NEXT[progress.current]}
        </span>
      )}
      {findingsToClear > 0 && findingsCount > 0 && (
        <span className="resume-health__progress-delta">
          Need {findingsToClear} more {findingsToClear === 1 ? 'finding' : 'findings'} cleared
        </span>
      )}
    </div>
  );
}

/** Upper-case label for the NEXT tier — used in the meter's "advance to X" hint. */
const STAGE_LABEL_NEXT: Record<CareerStage, string> = {
  junior: 'MID',
  mid: 'SENIOR',
  senior: 'SENIOR',
};

/**
 * Build the "Next step" CTA copy from the highest-impact finding (#137).
 *
 * The CTA reads as a concrete action the writer can take in their editor,
 * not as a restatement of the finding. The rule id picks the verb/object
 * shape:
 *  - `quantification` / `weak-verb` — point at a specific bullet under the
 *    role heading the finding sits inside.
 *  - everything else — fall back to "Open line N" with the finding message
 *    as the rationale, so the CTA is still actionable.
 */
function nextStepLabel(finding: HealthFinding, markdown: string): string {
  const line = finding.line ?? 0;
  const role = enclosingRole(markdown, line);
  const bulletOrdinal = bulletOrdinalInRole(markdown, line);
  switch (finding.id) {
    case 'quantification':
      return role
        ? `Add a number to your ${bulletOrdinal ?? 'next'} bullet under "${role}"`
        : `Add a number to the bullet on line ${line}`;
    case 'weak-verb':
      return role
        ? `Replace the weak opener in your ${bulletOrdinal ?? 'next'} bullet under "${role}"`
        : `Replace the weak opener on line ${line}`;
    case 'first-person':
      return `Rewrite the first-person bullet on line ${line} in implied first person`;
    case 'buzzwords':
      return `Replace the buzzword on line ${line} with concrete evidence`;
    case 'bullets-per-role':
      return role
        ? `Rebalance bullets under "${role}" — aim for 3–5`
        : `Rebalance bullets near line ${line} — aim for 3–5`;
    case 'repeated-opener':
      return role
        ? `Vary the repeated opener in your ${bulletOrdinal ?? 'next'} bullet under "${role}"`
        : `Vary the repeated opener on line ${line}`;
    case 'sections':
      return finding.message;
    default:
      return `Open line ${line} — ${finding.message}`;
  }
}

/**
 * Return the H3 heading title whose section encloses the given line, or
 * `null` when the line sits outside any H3. Used so the next-step CTA can
 * name the role the writer should edit instead of just a line number.
 */
function enclosingRole(markdown: string, line: number): string | null {
  if (line <= 0) return null;
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  let role: string | null = null;
  for (let i = 0; i < Math.min(lines.length, line - 1); i++) {
    const m = /^###[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(lines[i]);
    if (m) role = m[1].trim();
    const h2 = /^##[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(lines[i]);
    if (h2) role = null; // a new H2 resets the role context
  }
  return role;
}

/** "1st" / "2nd" / "3rd" / "Nth" ordinal for the bullet's position under its H3. */
function bulletOrdinalInRole(markdown: string, line: number): string | null {
  if (line <= 0) return null;
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  let bulletIndex = 0;
  let foundIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (/^###[ \t]+/.test(text) || /^##[ \t]+/.test(text)) {
      bulletIndex = 0;
      continue;
    }
    if (/^[ \t]*[-*][ \t]+/.test(text)) {
      bulletIndex += 1;
      if (i + 1 === line) {
        foundIndex = bulletIndex;
      }
    }
  }
  if (foundIndex <= 0) return null;
  const suffixes = ['th', 'st', 'nd', 'rd'];
  const v = foundIndex % 100;
  return `${foundIndex}${suffixes[(v - 20) % 10] ?? suffixes[v] ?? suffixes[0]}`;
}

/** Human label for a stage, used in the header copy. */
function labelFor(stage: CareerStage): string {
  switch (stage) {
    case 'junior':
      return 'Junior';
    case 'mid':
      return 'Mid';
    case 'senior':
      return 'Senior';
  }
}

/**
 * One finding row (#115). Renders the severity dot + message, then up to
 * two affordance buttons:
 *
 *  - "Jump to line N" — present when the finding carries a `line`. Clicking
 *    selects the offender substring on that line (or the whole line, if no
 *    `offender` was supplied) and scrolls the editor textarea to it.
 *  - Either "Suggest a fix" (templated rewrite tray) or "Open an example"
 *    (jump to a sample section), depending on the finding's `suggest`
 *    shape. Buttons are mutually exclusive — a finding is either
 *    actionable via a mechanical rewrite, or it points at an example. We
 *    never offer both for the same finding because the second option is
 *    always a fallback for findings without a clean templated fix.
 *
 * The "Suggest a fix" tray opens beneath the row and lists 2-3 candidate
 * rewrites derived from `getRewriteCandidates` against the offending
 * bullet source line. Picking one inserts it as a sibling bullet above the
 * original through `onInsertRewrite`; the in-editor rewrite-tray (#93) and
 * this tray share the exact same pattern library, so the two affordances
 * cannot disagree on what a rewrite looks like.
 */
function FindingItem({
  finding,
  onJumpToLine,
  onJumpToOffender,
  onInsertRewrite,
  onJumpToSection,
}: {
  finding: HealthFinding;
  onJumpToLine?: (line: number) => void;
  onJumpToOffender?: (line: number, offender: string) => void;
  onInsertRewrite?: (targetLine: number, rewrittenLine: string) => void;
  onJumpToSection?: (sectionTitle: string) => void;
}) {
  const className = `health__item health__item--${finding.severity}`;
  const dotLabel = severityLabel(finding.severity);

  /* Suggest-a-fix tray state. Closed by default; opens only when the user
     clicks the "Suggest a fix" button. Each tray is per-row so the panel
     can show two open trays at once (rare in practice — most findings of
     the same rule are co-located in the bullet list). */
  const [fixOpen, setFixOpen] = useState(false);
  const trayRef = useRef<HTMLDivElement>(null);

  /* Close the tray when a pointer-down lands outside it. Mirrors the
     pattern the in-editor rewrite tray (#93) and snippet popover use. */
  useEffect(() => {
    if (!fixOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (!trayRef.current?.contains(event.target as Node)) {
        setFixOpen(false);
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [fixOpen]);

  /* Derive the candidate rewrites when the suggest shape is a 'rewrite'.
     useMemo: the bullet text rarely changes for a given finding (it's the
     source line snapshot), and the rewrite library is pure. */
  const rewriteCandidates: RewriteCandidate[] = useMemo(() => {
    if (finding.suggest?.kind !== 'rewrite') return [];
    return getRewriteCandidates(finding.suggest.bulletText);
  }, [finding.suggest]);

  const canJump = finding.line !== undefined && (onJumpToOffender || onJumpToLine);
  const canSuggestFix =
    finding.suggest?.kind === 'rewrite' &&
    rewriteCandidates.length > 0 &&
    onInsertRewrite !== undefined &&
    finding.line !== undefined;
  /* "Open an example" is offered whenever the finding is shaped as an
     example suggestion. We always show the button — the parent (ResumeStudio)
     routes the click: if the writer's resume already has the section, jump
     there in the editor; otherwise open a dialog showing the bundled
     sample's section (#120). The Health panel intentionally doesn't know
     about the dialog fallback — it just hands the section name up. */
  const canOpenExample =
    finding.suggest?.kind === 'example' && onJumpToSection !== undefined;

  /**
   * Apply a candidate rewrite: insert above the offending line, close the
   * tray, and let the editor re-select the inserted text. The Health panel
   * never mutates the markdown directly; the editor owns that path.
   */
  function applyRewrite(candidate: RewriteCandidate) {
    if (finding.line === undefined || !onInsertRewrite) return;
    onInsertRewrite(finding.line, candidate.rewrittenLine);
    setFixOpen(false);
  }

  /** "Jump to line" click. Prefer the offender-aware jump when available. */
  function handleJump() {
    if (finding.line === undefined) return;
    if (finding.offender && onJumpToOffender) {
      onJumpToOffender(finding.line, finding.offender);
    } else if (onJumpToLine) {
      onJumpToLine(finding.line);
    }
  }

  return (
    <li className={className} data-rule={finding.id}>
      <span className="health__item-dot" aria-label={dotLabel} role="img" />
      <div className="health__item-body">
        <span className="health__item-message">{finding.message}</span>
        {(canJump || canSuggestFix || canOpenExample) && (
          <div className="health__item-actions">
            {canJump && (
              <button type="button" className="health__item-jump" onClick={handleJump}>
                Jump to line {finding.line}
              </button>
            )}
            {canSuggestFix && (
              <button
                type="button"
                className="health__item-fix"
                aria-haspopup="menu"
                aria-expanded={fixOpen}
                onClick={() => setFixOpen((open) => !open)}
              >
                Suggest a fix
              </button>
            )}
            {!canSuggestFix && canOpenExample && finding.suggest?.kind === 'example' && (
              <button
                type="button"
                className="health__item-example"
                onClick={() =>
                  finding.suggest?.kind === 'example' &&
                  onJumpToSection?.(finding.suggest.section)
                }
              >
                Open an example
              </button>
            )}
          </div>
        )}
        {canSuggestFix && fixOpen && (
          <div className="health__item-tray" ref={trayRef}>
            <ul
              className="health__item-tray-list"
              role="menu"
              aria-label="Rewrite suggestions"
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation();
                  setFixOpen(false);
                }
              }}
            >
              {rewriteCandidates.map((candidate) => (
                <li key={candidate.id} role="none" className="health__item-tray-li">
                  <button
                    type="button"
                    role="menuitem"
                    className="health__item-tray-item"
                    onClick={() => applyRewrite(candidate)}
                  >
                    <span className="health__item-tray-label">{candidate.label}</span>
                    <span className="health__item-tray-preview">{candidate.rewrittenLine}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </li>
  );
}

/** Accessible label for the severity glyph. */
function severityLabel(severity: HealthFinding['severity']): string {
  switch (severity) {
    case 'good':
      return 'Good';
    case 'warn':
      return 'Warning';
    case 'bad':
      return 'Needs attention';
  }
}
