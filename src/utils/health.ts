/**
 * health.ts — Resume Health analysis (#85).
 *
 * Pure, browser-and-node-safe heuristics that read a Markdown resume plus
 * its `ParsedResume` and emit a stage-aware `HealthReport`. Every check is
 * intentionally permissive: when a signal can't be evaluated (e.g. there
 * is no Experience section, so "bullets per role" doesn't apply) the
 * heuristic returns no findings rather than throwing.
 *
 * Design notes
 * ------------
 * - The rubric is opinion, not law. Findings are surfaced as warnings the
 *   author can dismiss in their head — never blocking, never destructive.
 * - The score is a quick at-a-glance number, not a job verdict. We start
 *   at 100, subtract per finding, and floor at 0. The formula is below.
 * - Stage tuning lives next to the thresholds it tunes (`STAGE_LIMITS`,
 *   weight knobs at the bottom) so the rubric reads top-to-bottom rather
 *   than scattering its calibration across the file.
 * - Operates on the raw Markdown string for line-accurate findings; the
 *   `ParsedResume` is only used for `frontmatter` shape.
 */

import type { ParsedResume } from '../types';

/* ------------------------------------------------------------------ */
/* Public types                                                        */
/* ------------------------------------------------------------------ */

/** Career-stage rubric the Resume Health panel scores against. */
export type CareerStage = 'junior' | 'mid' | 'senior';

/** Severity of a single finding, from "you're good" to "fix this". */
export type HealthSeverity = 'good' | 'warn' | 'bad';

/**
 * Hint to the UI about what action to surface alongside a finding (#115).
 *
 * Two shapes:
 *  - `rewrite` — the finding has a templated fix. The `bulletText` is the
 *    full bullet source line the editor should rewrite through
 *    `getRewriteCandidates`. The Health panel surfaces a "Suggest a fix"
 *    affordance that opens an inline tray of 2-3 candidate rewrites;
 *    clicking a candidate inserts a sibling bullet through the same
 *    value/onChange path the in-editor rewrite tray (#93) uses. Nothing
 *    is mutated until the user picks.
 *  - `example` — the finding has no templated fix, but a hand-picked
 *    section name from the bundled sample resume teaches the pattern.
 *    The Health panel surfaces an "Open an example" affordance that
 *    selects/scrolls the example section into view in the editor textarea.
 */
export type HealthSuggestion =
  | { kind: 'rewrite'; bulletText: string }
  | { kind: 'example'; section: string };

/** A single piece of feedback from the analyzer. */
export interface HealthFinding {
  /** Stable id of the rule that produced this finding (e.g. `weak-verb`). */
  id: string;
  severity: HealthSeverity;
  message: string;
  /** 1-based line in the source Markdown, when the finding has a location. */
  line?: number;
  /**
   * Exact substring of the source line the UI should highlight (selection +
   * scroll). Optional: when omitted the UI falls back to selecting the
   * entire line at `line`.
   */
  offender?: string;
  /**
   * UI-facing hint for "Suggest a fix" / "Open an example" affordances
   * (#115). Optional: omitted on findings the UI cannot act on directly
   * (e.g. frontmatter missing-key warnings — the user fixes those in the
   * frontmatter block, which the UI already jumps to).
   */
  suggest?: HealthSuggestion;
}

/** The full output of `analyzeResume`. */
export interface HealthReport {
  stage: CareerStage;
  /** Composite score, 0–100. Higher is better. */
  score: number;
  findings: HealthFinding[];
}

/**
 * A single "What's working" entry surfaced alongside the findings list (#137).
 *
 * Positives are the inverted complement of the findings rubric: when a check
 * COULD have flagged the resume but didn't (e.g. quantification rate ≥ floor),
 * we lift the same evidence into a celebratory line. The `id` mirrors the
 * finding rule it inverts so the UI can render a deterministic icon/order.
 */
export interface Positive {
  /** Stable id of the rule this positive inverts (e.g. `quantification`). */
  id: string;
  /** Short mono label shown after the ✓ glyph. */
  message: string;
}

/**
 * Career-stage progress meter (#137). The Health pane renders this as a
 * tier label + thin horizontal meter + delta hint so the writer can see the
 * next milestone at a glance.
 *
 * `delta` is the points away from `next` (always non-negative). When the
 * writer is already at the top tier (`senior` + score 100) `next` is `null`
 * and `delta` is `0` — the UI renders an at-the-top affordance.
 */
export interface StageProgress {
  /** Current stage tier the rubric is evaluating against. */
  current: CareerStage;
  /** Next tier the writer can advance to, or `null` when at the top. */
  next: CareerStage | null;
  /** Score the writer must reach to advance. `100` when at the top. */
  threshold: number;
  /** Current score (mirrored from the report). */
  score: number;
  /** Points away from `threshold`. `0` when at the top or already past it. */
  delta: number;
  /** Human label for the current tier (e.g. `MID`). */
  label: string;
}

/* ------------------------------------------------------------------ */
/* Constants — thresholds and word lists                               */
/* ------------------------------------------------------------------ */

/**
 * Rough words-per-page estimate. ~475 is industry shorthand.
 *
 * Exported so the modeline's WORDS meter (#155) shares the same anchor the
 * length heuristic uses — there is exactly one source of truth for "how
 * many words is a page".
 */
export const WORDS_PER_PAGE = 475;

/**
 * Target page count by stage, mirroring `STAGE_LIMITS` (#155).
 *
 * The WORDS meter renders the denominator as `WORDS_PER_PAGE * targetPages`
 * and the trailing `· N page(s)` suffix off the same value. The mapping is
 * intentionally aligned with the length rubric:
 *
 *   - junior → 1 page (`STAGE_LIMITS.junior.warn = 1.0`)
 *   - mid    → 2 pages (`STAGE_LIMITS.mid.warn = 1.9`, rounds up)
 *   - senior → 2 pages (`STAGE_LIMITS.senior.warn = 1.9`)
 *
 * Keeping this beside `STAGE_LIMITS` ensures any future calibration of the
 * length envelope sweeps both the analyzer and the modeline in lockstep.
 */
export function targetPages(stage: CareerStage): number {
  switch (stage) {
    case 'junior':
      return 1;
    case 'mid':
    case 'senior':
      return 2;
  }
}

/**
 * Target word count for a stage = `WORDS_PER_PAGE * targetPages(stage)` (#155).
 *
 * Used by the modeline's WORDS segment as the denominator and as the
 * threshold for ok / warn / danger colouring.
 */
export function wordsTarget(stage: CareerStage): number {
  return WORDS_PER_PAGE * targetPages(stage);
}

/**
 * Severity for the WORDS meter (#155).
 *
 *   - `ok`     — at or under the stage's target word count
 *   - `warn`   — 10–25% over the target
 *   - `danger` — more than 25% over the target
 *
 * Mirrors the Fit chip's three-tier vocabulary so the two readouts agree
 * on what "too long" looks like. `total === 0` short-circuits to `ok`
 * (an empty buffer has nothing to flag).
 */
export type WordsSeverity = 'ok' | 'warn' | 'danger';
export function wordsSeverity(total: number, target: number): WordsSeverity {
  if (target <= 0 || total <= target) return 'ok';
  const ratio = total / target;
  if (ratio > 1.25) return 'danger';
  if (ratio > 1.1) return 'warn';
  return 'ok';
}

/** Required frontmatter fields. `links` is "at least one entry". */
const REQUIRED_FRONTMATTER_KEYS = ['name', 'role', 'email'] as const;

/** Stage-specific section requirements. Keys are matched case-insensitively. */
const REQUIRED_SECTIONS_BY_STAGE: Record<CareerStage, readonly string[]> = {
  junior: ['Education', 'Projects', 'Experience'],
  mid: ['Summary', 'Experience', 'Skills'],
  senior: ['Summary', 'Experience', 'Skills'],
};

/**
 * "Experience" and "Work" are interchangeable — the writing guide
 * recommends "Experience" but plenty of resumes ship "Work Experience"
 * or just "Work". `experienceLikeHeadings` covers all common variants
 * so the section check doesn't penalize idiomatic alternate spellings.
 */
const EXPERIENCE_LIKE = [
  'experience',
  'work experience',
  'work',
  'employment',
  'professional experience',
];

/** Page-length envelopes by stage. Values are float pages. */
const STAGE_LIMITS: Record<CareerStage, { warn: number; bad: number; label: string }> = {
  // Junior should fit on one page; we allow a smidge of slack before warning.
  junior: { warn: 1.0, bad: 1.1, label: '1 page' },
  mid: { warn: 1.9, bad: 2.0, label: '1–2 pages' },
  senior: { warn: 1.9, bad: 2.0, label: '1–2 pages' },
};

/** Quantification floors. Below the floor → warn. */
const QUANT_FLOOR: Record<CareerStage, number> = {
  junior: 0.35,
  mid: 0.5,
  senior: 0.5,
};

/**
 * Bullet phrases that signal a passive, low-impact description. Matched
 * case-insensitively at the start of a bullet.
 *
 * Kept in step with `bulletPatterns`' `WEAK_VERBS` rewrite map: every opener
 * the rewrite tray can upgrade should also be flagged here, otherwise the
 * "Suggest a fix" affordance never appears for it.
 */
const WEAK_VERB_PHRASES = [
  // Longer phrases come before their shorter prefixes so the offender
  // highlight lands on the full opener (e.g. "Provided support for" before
  // "Provided", "Pitched in on" before "Pitched in").
  'Responsible for',
  'Was responsible for',
  'Helped',
  'Worked on',
  'Worked closely with',
  'Worked alongside',
  'Worked with',
  'Assisted',
  'Participated in',
  'Was involved in',
  'Involved in',
  'Collaborated on',
  'Engaged in',
  'Took part in',
  'Duties included',
  'Responsibilities included',
  'Was tasked with',
  'Tasked with',
  'Tasked to',
  'Assigned to',
  'Brought on to',
  'Contributed to',
  'Handled',
  'Provided support for',
  'Provided',
  'Supported',
  'Aided',
  'Facilitated',
  'Performed',
  'Played a key role in',
  'Played a role in',
  'Was part of',
  'Pitched in on',
  'Pitched in',
  'Chipped in',
  'Stepped in to',
];

/** First-person pronouns. `I` is case-sensitive; everything else is case-insensitive. */
const FIRST_PERSON_CI = ['my', 'we', 'our', "i'm"];

/** Buzzwords. Two or more hits across the whole document trips the finding. */
const BUZZWORDS = [
  'synergy',
  'synergize',
  'ninja',
  'rockstar',
  'guru',
  '10x',
  'evangelize',
  'leverage',
  'utilize',
  'passionate about',
  'team player',
  'detail-oriented',
  'results-driven',
  'go-getter',
  'thought leader',
  'self-starter',
  'self-motivated',
  'proactive',
  'hardworking',
];

/**
 * Vague magnitude words that gesture at scale without committing to a number.
 * "Reduced load times" is fine; "Reduced load times for many users" pretends to
 * quantify and says nothing. Flagged only on bullets with no digit of their own,
 * so "cut p95 by 40% for many users" isn't nagged when the number is already
 * there. Multi-word entries are matched as phrases.
 */
const VAGUE_QUANTIFIERS = [
  'many',
  'several',
  'various',
  'numerous',
  'multiple',
  'a lot of',
  'lots of',
  'a number of',
  'a variety of',
  'a range of',
  'countless',
  'tons of',
];

/**
 * Objective-statement openers. A line that leads with what the candidate WANTS
 * ("Seeking a challenging role to apply my skills") spends the most-read lines
 * on the job hunt instead of the work. Modern resumes open with evidence, not
 * an objective. Matched only when one of these starts a body line (after the
 * bullet / emphasis markers), so a bullet like "Shipped a refund flow for users
 * seeking a faster path" — where the phrase sits mid-sentence — is left alone.
 */
const OBJECTIVE_OPENERS = [
  'seeking',
  'looking for',
  'in search of',
  'to obtain',
  'aspiring',
  'eager to',
  'desire to',
];

/**
 * Personal details a modern resume should not carry: date of birth, marital
 * status, nationality, gender, religion. In most markets they invite bias and
 * never help the hiring case, so they only waste a line. Matched as a labeled
 * field ("label:") so the words used naturally inside a bullet don't trip it.
 */
const PERSONAL_DETAIL_LABELS = [
  'date of birth',
  'd\\.?o\\.?b\\.?',
  'place of birth',
  'marital status',
  'nationality',
  'gender',
  'religion',
];

/**
 * Filler adverbs that pad a bullet without adding information. "Successfully
 * delivered" says nothing "Delivered" doesn't — the success is implied by the
 * outcome. "Very", "really", "highly" inflate without quantifying. Flagged as a
 * whole word anywhere in a bullet, one finding per bullet. Distinct from
 * `VAGUE_QUANTIFIERS` (fake scale) and `BUZZWORDS` (empty nouns): these are the
 * adverbs that survive a delete with no loss of meaning.
 */
const FILLER_ADVERBS = [
  'successfully',
  'effectively',
  'efficiently',
  'very',
  'really',
  'highly',
  'greatly',
  'extremely',
  'quite',
  'basically',
  'actually',
  'simply',
];

/**
 * Open-ended list tails. A bullet that trails off into "etc" or "and so on"
 * waves at work it can't be bothered to name — the recruiter reads it as "ran
 * out of concrete things to say". Pin the last item or drop the tail. Matched
 * as a phrase anywhere in a bullet; "etc" also catches the "etc." spelling
 * because the trailing dot sits outside the word boundary.
 */
const OPEN_ENDED_TAILS = [
  'etc',
  'and so on',
  'and so forth',
  'and more',
  'and others',
  'and the like',
  'among others',
];

/**
 * Literal leftover-template tokens. A resume that still carries `TODO` or
 * `lorem ipsum` was shipped half-finished. Matched case-insensitively on a
 * word boundary anywhere in the document, frontmatter included.
 */
const PLACEHOLDER_TOKENS = ['todo', 'fixme', 'tbd', 'lorem ipsum'];

/**
 * Keywords that mark a bracketed or braced span as an unfilled template slot
 * rather than real content. `[Company Name]`, `{{ email }}` read as slots a
 * writer forgot to fill; a Markdown link `[label](url)` does not and is
 * excluded by the trailing-paren guard in `checkPlaceholders`.
 */
const PLACEHOLDER_SLOT_WORDS = [
  'your name',
  'full name',
  'name here',
  'company',
  'company name',
  'employer',
  'job title',
  'title here',
  'role here',
  'position',
  'email',
  'phone',
  'address',
  'city',
  'state',
  'location',
  'date',
  'dates',
  'start date',
  'end date',
  'school',
  'university',
  'degree',
  'gpa',
  'website',
  'link',
];

/** Bullets-per-role envelope. Below `min` → thin, above `max` → noisy. */
const BULLETS_PER_ROLE = { min: 2, max: 6 };

/**
 * A bullet over this many words has spilled past the ~two lines a recruiter
 * skims and reads as a paragraph. Tuned generously so only genuine run-ons
 * trip it, not a normal outcome-and-context bullet.
 */
const MAX_BULLET_WORDS = 32;

/**
 * A bullet joining this many or more achievements with "and" has stopped being
 * one accomplishment and turned into a run of them. One or two "and"s read as a
 * normal sentence ("designed and shipped X"); three is where the bullet should
 * split so each outcome stands on its own line.
 */
const MAX_BULLET_ANDS = 3;

/* ------------------------------------------------------------------ */
/* Small parsers — operate on raw Markdown                             */
/* ------------------------------------------------------------------ */

/** One Markdown line annotated with its 1-based line number. */
interface LineInfo {
  /** 1-based line number in the original source. */
  line: number;
  /** Line content, verbatim. */
  text: string;
}

/** A bullet line + its 1-based source line + its content with the marker stripped. */
interface Bullet extends LineInfo {
  /** The bullet's content (text after `- ` or `* `). */
  content: string;
}

/** Split Markdown into line records (1-based line numbers). */
function splitLines(markdown: string): LineInfo[] {
  // Normalize CRLF so the splitter returns one record per visual line.
  const normalized = markdown.replace(/\r\n?/g, '\n');
  const out: LineInfo[] = [];
  const parts = normalized.split('\n');
  for (let i = 0; i < parts.length; i++) {
    out.push({ line: i + 1, text: parts[i] });
  }
  return out;
}

/** Extract every `- ` / `* ` bullet at any indent, with its line number. */
function findBullets(lines: LineInfo[]): Bullet[] {
  const out: Bullet[] = [];
  // We don't bother distinguishing fenced code blocks here: a resume rarely
  // includes a long fenced block, and if it does the bullet rules are still
  // a reasonable read on the prose around it.
  for (const li of lines) {
    const m = /^[ \t]*[-*][ \t]+(.*)$/.exec(li.text);
    if (!m) continue;
    out.push({ line: li.line, text: li.text, content: m[1] });
  }
  return out;
}

/** A heading line with its level (1-6) and trimmed text. */
interface Heading extends LineInfo {
  level: number;
  title: string;
}

/** Extract every ATX heading (`# ` through `###### `). */
function findHeadings(lines: LineInfo[]): Heading[] {
  const out: Heading[] = [];
  for (const li of lines) {
    const m = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(li.text);
    if (!m) continue;
    out.push({ line: li.line, text: li.text, level: m[1].length, title: m[2].trim() });
  }
  return out;
}

/**
 * Count words via the same simple split the spec calls for.
 *
 * Exported so the modeline's WORDS meter (#155) shares the same algorithm
 * the length heuristic uses — the two readouts can never drift on what
 * "a word" is. The frontmatter strip mirrors `markdown.ts`'s
 * `FRONTMATTER_RE` so a long YAML header isn't double-counted as prose.
 */
export function wordCount(markdown: string): number {
  // Strip the frontmatter block before counting so a long YAML header isn't
  // double-counted as resume prose. Matches the FRONTMATTER_RE in markdown.ts.
  const body = markdown.replace(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '');
  return body.split(/\s+/).filter(Boolean).length;
}

/* ------------------------------------------------------------------ */
/* Heuristic implementations                                           */
/* ------------------------------------------------------------------ */

/** #1 length. */
function checkLength(markdown: string, stage: CareerStage): HealthFinding[] {
  const pages = Math.ceil(wordCount(markdown) / WORDS_PER_PAGE);
  // `pages` is integer-rounded; the threshold expression uses the raw float
  // so a 1.1-page resume reads as "1 page" but a 1.4-page one warns.
  const rawPages = wordCount(markdown) / WORDS_PER_PAGE;
  const limits = STAGE_LIMITS[stage];

  // No content yet — nothing to warn about.
  if (wordCount(markdown) === 0) return [];

  if (rawPages > limits.bad) {
    return [
      {
        id: 'length',
        severity: 'bad',
        message: `Your resume runs ~${pages}p. For a ${stage} resume, aim for ${limits.label}.`,
      },
    ];
  }
  if (rawPages > limits.warn) {
    return [
      {
        id: 'length',
        severity: 'warn',
        message: `Your resume runs ~${pages}p. For a ${stage} resume, aim for ${limits.label}.`,
      },
    ];
  }
  return [];
}

/** #2 frontmatter completeness. */
function checkFrontmatter(parsed: ParsedResume): HealthFinding[] {
  const findings: HealthFinding[] = [];
  const fm = parsed.frontmatter;

  for (const key of REQUIRED_FRONTMATTER_KEYS) {
    const value = fm[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      findings.push({
        id: 'frontmatter',
        severity: 'warn',
        message: `Missing \`${key}\` — recruiters and ATS expect it in the header.`,
      });
    }
  }

  // `links` should be present and have at least one entry.
  const links = fm.links;
  if (!Array.isArray(links) || links.length === 0) {
    findings.push({
      id: 'frontmatter',
      severity: 'warn',
      message: 'Missing `links` — recruiters and ATS expect it in the header.',
    });
  }

  return findings;
}

/** #3 sections. */
function checkSections(markdown: string, stage: CareerStage): HealthFinding[] {
  const lines = splitLines(markdown);
  const headings = findHeadings(lines).filter((h) => h.level === 1 || h.level === 2);
  // Lowercase set of every H1/H2 heading title.
  const titles = new Set(headings.map((h) => h.title.toLowerCase()));

  const requirements = REQUIRED_SECTIONS_BY_STAGE[stage];
  const findings: HealthFinding[] = [];

  for (const required of requirements) {
    const want = required.toLowerCase();
    let present: boolean;
    if (want === 'experience' || want === 'work') {
      // Either heading satisfies the experience requirement.
      present = EXPERIENCE_LIKE.some((alt) => titles.has(alt));
    } else {
      present = titles.has(want);
    }
    if (!present) {
      findings.push({
        id: 'sections',
        severity: 'warn',
        message: `A ${stage} resume should include a ${required} section.`,
      });
    }
  }

  return findings;
}

/**
 * #4 quantification.
 *
 * Counts only bullets that live under an Experience-style H2 heading, so a
 * clean senior resume doesn't get dinged because its Skills table, Selected
 * Writing list, or Education capstone bullets happen not to carry numbers.
 *
 * Section headings that qualify as Experience (case-insensitive, exact H2
 * title match): `Experience`, `Work`, `Work Experience`, `Employment`,
 * `Professional Experience`. See `EXPERIENCE_LIKE` for the canonical list.
 *
 * Back-compat: if the resume has NO Experience-style H2 at all (early
 * drafts, projects-only resumes, junior portfolios), the rule falls back
 * to its original behavior of counting every bullet in the document. This
 * keeps the heuristic useful before the Experience section is written.
 *
 * See issue #105 for the reasoning behind this scoping change.
 */
function checkQuantification(markdown: string, stage: CareerStage): HealthFinding[] {
  const lines = splitLines(markdown);
  const headings = findHeadings(lines);
  const allBullets = findBullets(lines);
  if (allBullets.length === 0) return [];

  // Walk the document and tag each bullet with the title of the H2 it sits
  // under. We don't need an H2→bullets map — a single pass that records
  // "current H2" while scanning is enough.
  const experienceBullets: Bullet[] = [];
  let hasExperienceH2 = false;
  const headingByLine = new Map<number, Heading>();
  for (const h of headings) headingByLine.set(h.line, h);

  let currentH2: Heading | null = null;
  for (const li of lines) {
    const h = headingByLine.get(li.line);
    if (h && h.level === 2) {
      currentH2 = h;
      if (isExperienceLikeH2(h)) hasExperienceH2 = true;
      continue;
    }
    if (h) continue; // ignore H1, H3+; only H2 toggles section context
    if (!isExperienceLikeH2(currentH2)) continue;
    const bullet = findBulletInLine(li);
    if (bullet) experienceBullets.push(bullet);
  }

  // Pick the bullet pool the ratio is computed against. With at least one
  // Experience H2 we only score the bullets inside those sections; without
  // one we fall back to every bullet so the heuristic still gives feedback
  // on partial drafts.
  const pool = hasExperienceH2 ? experienceBullets : allBullets;
  if (pool.length === 0) return [];

  const withDigits = pool.filter((b) => /\d/.test(b.content)).length;
  const ratio = withDigits / pool.length;
  const floor = QUANT_FLOOR[stage];

  if (ratio < floor) {
    const pct = Math.round(ratio * 100);
    return [
      {
        id: 'quantification',
        severity: 'warn',
        message: `Only ${pct}% of your bullets contain a number. Quantify outcomes where you can.`,
      },
    ];
  }
  return [];
}

/** True when an H2 heading reads as Experience-like (see `EXPERIENCE_LIKE`). */
function isExperienceLikeH2(h: Heading | null): boolean {
  if (!h || h.level !== 2) return false;
  return EXPERIENCE_LIKE.includes(h.title.toLowerCase());
}

/** #5 weak-verb openings. One finding per offending line. */
function checkWeakVerbs(markdown: string): HealthFinding[] {
  const lines = splitLines(markdown);
  const bullets = findBullets(lines);
  const findings: HealthFinding[] = [];

  for (const bullet of bullets) {
    // Skip Markdown emphasis markers (`**`, `_`) at the start so a bullet
    // that opens with **Bold** isn't excused from the weak-verb check.
    const content = bullet.content.replace(/^[*_~`]+/, '').trimStart();
    for (const phrase of WEAK_VERB_PHRASES) {
      // Case-insensitive prefix match on a word boundary.
      const re = new RegExp(`^${escapeRegExp(phrase)}\\b`, 'i');
      if (re.test(content)) {
        // The offender is the matched prefix from the ORIGINAL source line
        // (case preserved), so the editor selection lands on the exact span
        // the user typed — not on a normalized lowercase echo of it.
        const offender = findOffenderInLine(bullet.text, phrase);
        findings.push({
          id: 'weak-verb',
          severity: 'warn',
          message: `Line ${bullet.line} starts with '${phrase}' — replace with an outcome verb like Shipped, Reduced, Built.`,
          line: bullet.line,
          offender,
          // The full bullet source line is what bulletPatterns rewrites
          // (it parses the `- ` / `* ` prefix itself), so the editor can
          // re-derive the bullet shape without us re-encoding it here.
          suggest: { kind: 'rewrite', bulletText: bullet.text },
        });
        // Don't double-fire for a single bullet that matches more than one phrase.
        break;
      }
    }
  }

  return findings;
}

/**
 * Find a case-insensitive occurrence of `needle` inside `line` and return the
 * exact-cased slice from `line`. Used so the editor selection highlights the
 * substring the writer actually typed, not a normalized echo of the rule's
 * pattern. Returns `undefined` when the needle does not appear (defensive —
 * the caller has already proven a regex match).
 */
function findOffenderInLine(line: string, needle: string): string | undefined {
  const idx = line.toLowerCase().indexOf(needle.toLowerCase());
  if (idx === -1) return undefined;
  return line.slice(idx, idx + needle.length);
}

/** #6 first person. One finding per offending bullet line. */
function checkFirstPerson(markdown: string): HealthFinding[] {
  const lines = splitLines(markdown);
  const bullets = findBullets(lines);
  const findings: HealthFinding[] = [];

  // Case-sensitive `I` on a word boundary, plus case-insensitive `my|we|our|I'm`.
  // Done as two passes so the case rules stay obvious to a reader.
  for (const bullet of bullets) {
    const hit = findFirstPersonWord(bullet.content);
    if (hit) {
      findings.push({
        id: 'first-person',
        severity: 'warn',
        message: `Line ${bullet.line} uses first person ('${hit}'). Resumes are written in implied first person.`,
        line: bullet.line,
        offender: hit,
        // First-person doesn't have a one-shot mechanical rewrite — but the
        // sample resume's Selected Impact section is an opinionated example
        // of outcome-led, impersonal phrasing.
        suggest: { kind: 'example', section: 'Selected Impact' },
      });
    }
  }

  return findings;
}

/**
 * Find the first first-person token in a piece of text, or `null` for none.
 * Returns the exact-cased match so the warning quotes what the user wrote.
 */
function findFirstPersonWord(text: string): string | null {
  // Case-sensitive `I` (and `I'm` / `I'll` / `I'd` etc.).
  const sensitive = /\bI('m|'ll|'d|'ve)?\b/.exec(text);
  // Case-insensitive `my | we | our`.
  const insensitive = /\b(my|we|our)\b/i.exec(text);

  // If both matched, return whichever came first in the string.
  if (sensitive && insensitive) {
    return sensitive.index <= insensitive.index ? sensitive[0] : insensitive[0];
  }
  if (sensitive) return sensitive[0];
  if (insensitive) return insensitive[0];
  // Fall back to a case-insensitive `I'm` scan for completeness (covered by
  // `sensitive` above, but documented here so future readers don't wonder).
  for (const word of FIRST_PERSON_CI) {
    if (word === "i'm") continue; // handled by `sensitive` above
    const re = new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i');
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

/** #7 buzzwords. Two or more hits → one finding listing them. */
function checkBuzzwords(markdown: string): HealthFinding[] {
  const hits: string[] = [];
  // Strip the frontmatter so a link labelled "Leverage" can't trip it.
  const body = markdown.replace(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '');
  for (const word of BUZZWORDS) {
    const re = new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i');
    if (re.test(body)) hits.push(word);
  }
  if (hits.length >= 2) {
    // Walk the body lines to attach the first hit's source line + literal
    // offender so the finding's "Jump to line" lands somewhere useful (#115).
    const fmEnd = frontmatterEndLine(markdown);
    const lines = splitLines(markdown);
    let firstHitLine: number | undefined;
    let firstHitOffender: string | undefined;
    outer: for (const li of lines) {
      if (li.line <= fmEnd) continue;
      for (const word of hits) {
        const re = new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i');
        const m = re.exec(li.text);
        if (m) {
          firstHitLine = li.line;
          firstHitOffender = m[0];
          break outer;
        }
      }
    }
    return [
      {
        id: 'buzzwords',
        severity: 'warn',
        message: `Buzzwords detected (${hits.join(', ')}). Replace with concrete evidence.`,
        line: firstHitLine,
        offender: firstHitOffender,
        // Buzzwords don't carry a one-shot mechanical rewrite — point the
        // user at the sample's Summary, which deliberately avoids them.
        suggest: { kind: 'example', section: 'Summary' },
      },
    ];
  }
  return [];
}

/**
 * #8 vague quantifiers. A bullet that leans on "many" or "several" to imply
 * scale reads as a number the writer didn't have. We flag any bullet carrying
 * one of `VAGUE_QUANTIFIERS` while holding no digit of its own, one finding per
 * offending bullet. Key-value bullets (`- label: value`) are left alone.
 */
function checkVagueQuantifiers(markdown: string): HealthFinding[] {
  const bullets = findBullets(splitLines(markdown));
  const findings: HealthFinding[] = [];
  for (const bullet of bullets) {
    const content = bullet.content.replace(/^[*_~`]+/, '').trimStart();
    if (/^[A-Za-z][A-Za-z'-]*:/.test(content)) continue;
    if (/\d/.test(content)) continue;
    for (const word of VAGUE_QUANTIFIERS) {
      const re = new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i');
      const m = re.exec(content);
      if (!m) continue;
      findings.push({
        id: 'vague-quantifier',
        severity: 'warn',
        message: `Line ${bullet.line} says '${m[0]}' instead of a number. Put the real figure in or drop the word.`,
        line: bullet.line,
        offender: findOffenderInLine(bullet.text, m[0]),
        suggest: { kind: 'example', section: 'Experience' },
      });
      break;
    }
  }
  return findings;
}

/**
 * #13 filler adverbs. A bullet leaning on "successfully", "effectively", or
 * "very" pads itself with words a recruiter reads past. We flag any bullet
 * carrying one of `FILLER_ADVERBS` as a whole word, one finding per offending
 * bullet (first hit). Key-value bullets (`- label: value`) are left alone.
 */
function checkFillerAdverbs(markdown: string): HealthFinding[] {
  const bullets = findBullets(splitLines(markdown));
  const findings: HealthFinding[] = [];
  for (const bullet of bullets) {
    const content = bullet.content.replace(/^[*_~`]+/, '').trimStart();
    if (/^[A-Za-z][A-Za-z'-]*:/.test(content)) continue;
    for (const word of FILLER_ADVERBS) {
      const re = new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i');
      const m = re.exec(content);
      if (!m) continue;
      findings.push({
        id: 'filler-adverb',
        severity: 'warn',
        message: `Line ${bullet.line} uses the filler '${m[0]}'. Cut it — the outcome carries the weight on its own.`,
        line: bullet.line,
        offender: findOffenderInLine(bullet.text, m[0]),
        suggest: { kind: 'example', section: 'Experience' },
      });
      break;
    }
  }
  return findings;
}

/**
 * Open-ended list tails. A bullet ending in "etc" or "and so on" gestures at
 * work it never names. We flag any bullet carrying one of `OPEN_ENDED_TAILS` as
 * a phrase, one finding per bullet (first hit). Key-value bullets
 * (`- label: value`) are left alone like the other phrase checks.
 */
function checkOpenEndedLists(markdown: string): HealthFinding[] {
  const bullets = findBullets(splitLines(markdown));
  const findings: HealthFinding[] = [];
  for (const bullet of bullets) {
    const content = bullet.content.replace(/^[*_~`]+/, '').trimStart();
    if (/^[A-Za-z][A-Za-z'-]*:/.test(content)) continue;
    for (const tail of OPEN_ENDED_TAILS) {
      const re = new RegExp(`\\b${escapeRegExp(tail)}\\b`, 'i');
      const m = re.exec(content);
      if (!m) continue;
      findings.push({
        id: 'open-ended-list',
        severity: 'warn',
        message: `Line ${bullet.line} trails off with '${m[0]}'. Name the last item or cut it — a vague tail adds nothing.`,
        line: bullet.line,
        offender: findOffenderInLine(bullet.text, m[0]),
        suggest: { kind: 'example', section: 'Experience' },
      });
      break;
    }
  }
  return findings;
}

/**
 * Passive voice in bullets. "Sales were increased 20%" hides who did the work;
 * recruiters want the active "Increased sales 20%". We look for a `was`/`were`
 * auxiliary followed by an -ed participle anywhere in the bullet. Bullets that
 * already open with a weak-verb phrase (`Was tasked with`, `Was responsible
 * for`) are left to checkWeakVerbs so one line isn't flagged twice. One finding
 * per offending bullet.
 */
function checkPassiveVoice(markdown: string): HealthFinding[] {
  const lines = splitLines(markdown);
  const bullets = findBullets(lines);
  const findings: HealthFinding[] = [];
  // {2,} before "ed" keeps short adjectives like "red" from reading as participles.
  const re = /\b(was|were)\s+[a-z]{2,}ed\b/i;

  for (const bullet of bullets) {
    const content = bullet.content.replace(/^[*_~`]+/, '').trimStart();
    const ownedByWeakVerb = WEAK_VERB_PHRASES.some((phrase) =>
      new RegExp(`^${escapeRegExp(phrase)}\\b`, 'i').test(content),
    );
    if (ownedByWeakVerb) continue;
    const m = re.exec(bullet.content);
    if (!m) continue;
    findings.push({
      id: 'passive-voice',
      severity: 'warn',
      message: `Line ${bullet.line} uses passive voice ('${m[0]}') — rewrite it active, like 'Increased sales 20%', so the win is clearly yours.`,
      line: bullet.line,
      offender: findOffenderInLine(bullet.text, m[0]),
      suggest: { kind: 'rewrite', bulletText: bullet.text },
    });
  }
  return findings;
}

/**
 * "References available upon request" and its kin. The line is a relic — every
 * employer assumes you'll hand over references when asked, so it spends a line
 * saying nothing. Flag the first occurrence in the body. We scope the match to
 * `references` + a "you'll get them later" verb so a real References section
 * that actually lists people doesn't trip it. One finding, no rewrite — the
 * fix is to delete the line.
 */
function checkReferencesLine(markdown: string): HealthFinding[] {
  const fmEnd = frontmatterEndLine(markdown);
  const re = /\breferences\b[^.\n]*?\b(available|furnished|provided|supplied)\b/i;
  for (const li of splitLines(markdown)) {
    if (li.line <= fmEnd) continue;
    const m = re.exec(li.text);
    if (!m) continue;
    return [
      {
        id: 'references-line',
        severity: 'warn',
        message: `Line ${li.line} says references are available on request. Drop it — it's assumed, and the line is better spent on your work.`,
        line: li.line,
        offender: findOffenderInLine(li.text, m[0]),
      },
    ];
  }
  return [];
}

/**
 * Objective statement. A body line that opens with what the writer wants from
 * the job ("Seeking...", "Looking for...") instead of what they bring. Scoped
 * to the line opener so the phrase mid-bullet doesn't trip it. First match only
 * — point at the Summary sample, which leads with evidence rather than an ask.
 */
function checkObjectiveStatement(markdown: string): HealthFinding[] {
  const fmEnd = frontmatterEndLine(markdown);
  const opener = new RegExp(
    `^(?:${OBJECTIVE_OPENERS.map(escapeRegExp).join('|')})\\b`,
    'i',
  );
  for (const li of splitLines(markdown)) {
    if (li.line <= fmEnd) continue;
    // Strip a leading bullet marker and any emphasis so the opener is tested
    // against the first real word of the sentence.
    const head = li.text.replace(/^\s*(?:[-*+]\s+)?[*_~`]*/, '');
    const m = opener.exec(head);
    if (!m) continue;
    return [
      {
        id: 'objective-statement',
        severity: 'warn',
        message: `Line ${li.line} opens with '${m[0]}' — that reads as an objective. Lead with what you've shipped, not what you're after.`,
        line: li.line,
        offender: findOffenderInLine(li.text, m[0]),
        suggest: { kind: 'example', section: 'Summary' },
      },
    ];
  }
  return [];
}

/**
 * Personal details (date of birth, marital status, nationality, gender,
 * religion). Matched as a labeled field — the label followed by a colon — so
 * the same words used inside a normal bullet are left alone. One finding per
 * line, no rewrite: the fix is to delete it.
 */
function checkPersonalDetails(markdown: string): HealthFinding[] {
  const fmEnd = frontmatterEndLine(markdown);
  const re = new RegExp(
    `\\b(${PERSONAL_DETAIL_LABELS.join('|')})\\b[*_~\`]*\\s*:`,
    'i',
  );
  const findings: HealthFinding[] = [];
  for (const li of splitLines(markdown)) {
    if (li.line <= fmEnd) continue;
    const m = re.exec(li.text);
    if (!m) continue;
    findings.push({
      id: 'personal-details',
      severity: 'warn',
      message: `Line ${li.line} lists a personal detail ('${m[1]}'). Drop it — it invites bias and doesn't help your case, so the line is better spent on your work.`,
      line: li.line,
      offender: findOffenderInLine(li.text, m[0]),
    });
  }
  return findings;
}

/**
 * #9 repeated openers. Recruiters skim the left edge of every bullet, so a
 * column of "Led / Led / Led" reads as a thin vocabulary even when the verbs
 * are strong. We group bullets by their opening word and, once the same word
 * starts three or more, flag the third and later ones (using a verb twice is
 * fine). Key-value bullets like `- label: GitHub` are skipped: their first
 * word is a field name, not a sentence opener.
 */
function checkRepeatedOpeners(markdown: string): HealthFinding[] {
  const bullets = findBullets(splitLines(markdown));
  const groups = new Map<string, { word: string; bullets: Bullet[] }>();
  for (const bullet of bullets) {
    const content = bullet.content.replace(/^[*_~`]+/, '').trimStart();
    const m = /^([A-Za-z][A-Za-z'-]*)(:?)/.exec(content);
    if (!m || m[2] === ':') continue;
    const key = m[1].toLowerCase();
    const group = groups.get(key);
    if (group) group.bullets.push(bullet);
    else groups.set(key, { word: m[1], bullets: [bullet] });
  }

  const findings: HealthFinding[] = [];
  for (const { word, bullets: hits } of groups.values()) {
    if (hits.length < 3) continue;
    // First two uses are fine; the third onward is what reads as repetitive.
    for (const bullet of hits.slice(2)) {
      findings.push({
        id: 'repeated-opener',
        severity: 'warn',
        message: `Line ${bullet.line} also opens with '${word}' — you've used it ${hits.length} times. Vary the verb so the bullets don't blur together.`,
        line: bullet.line,
        offender: findOffenderInLine(bullet.text, word),
        suggest: { kind: 'rewrite', bulletText: bullet.text },
      });
    }
  }

  return findings;
}

/**
 * #10 run-on bullets. Recruiters skim a bullet in well under a second, so one
 * that spills past two lines stops being scannable and turns into a paragraph.
 * Flag any bullet over `MAX_BULLET_WORDS` words. Key-value bullets
 * (`- label: value`) are left alone — they're metadata, not prose, and a long
 * value there is fine.
 */
function checkLongBullets(markdown: string): HealthFinding[] {
  const bullets = findBullets(splitLines(markdown));
  const findings: HealthFinding[] = [];
  for (const bullet of bullets) {
    const content = bullet.content.replace(/^[*_~`]+/, '').trimStart();
    // Same `label:` carve-out as repeated openers — a field bullet isn't prose.
    if (/^[A-Za-z][A-Za-z'-]*:/.test(content)) continue;
    const words = content.split(/\s+/).filter(Boolean).length;
    if (words <= MAX_BULLET_WORDS) continue;
    findings.push({
      id: 'long-bullet',
      severity: 'warn',
      message: `Line ${bullet.line} runs ${words} words. Tighten it to one or two lines so a recruiter can scan it.`,
      line: bullet.line,
      // No one-shot rewrite — the sample's Experience bullets model the
      // tight, one-outcome-per-line shape to aim for.
      suggest: { kind: 'example', section: 'Experience' },
    });
  }
  return findings;
}

/**
 * Stuffed bullets. A line that chains "designed X and built Y and shipped Z"
 * has crammed several achievements into one bullet, so the strongest one gets
 * buried in the middle. Distinct from `long-bullet`, which counts words — a
 * short line can still stuff three outcomes. Flag any bullet carrying
 * `MAX_BULLET_ANDS` or more standalone "and"s. Key-value bullets
 * (`- label: value`) are skipped: a value listing tools with "and" is fine.
 */
function checkStuffedBullets(markdown: string): HealthFinding[] {
  const bullets = findBullets(splitLines(markdown));
  const findings: HealthFinding[] = [];
  for (const bullet of bullets) {
    const content = bullet.content.replace(/^[*_~`]+/, '').trimStart();
    if (/^[A-Za-z][A-Za-z'-]*:/.test(content)) continue;
    const ands = content.match(/\band\b/gi);
    if (!ands || ands.length < MAX_BULLET_ANDS) continue;
    findings.push({
      id: 'stuffed-bullet',
      severity: 'warn',
      message: `Line ${bullet.line} chains ${ands.length} achievements with 'and'. Split it so each outcome gets its own bullet.`,
      line: bullet.line,
      offender: findOffenderInLine(bullet.text, 'and'),
      suggest: { kind: 'rewrite', bulletText: bullet.text },
    });
  }
  return findings;
}

/**
 * A bullet plus the source line its prose actually ends on. Markdown bullets
 * soft-wrap across physical lines, so the period that closes a bullet often
 * lives a line or two below the `- ` marker — `endLine` follows the lazy
 * continuation to that final line.
 */
interface LogicalBullet {
  /** 1-based line of the `- ` / `* ` marker (where the UI jumps to). */
  line: number;
  /** Marker-stripped content of the first physical line. */
  firstContent: string;
  /** Verbatim text of the last physical line the bullet spans. */
  endLine: string;
}

/** Lines that end a bullet's lazy continuation: another bullet, heading, ordered item, table, quote. */
const BULLET_BREAK_RE = /^[ \t]*(?:[-*][ \t]|#{1,6}[ \t]|\d+\.[ \t]|\||>)/;

/**
 * Collect every bullet under an Experience-style H2 as a `LogicalBullet`,
 * mirroring the scoping `checkQuantification` uses. Unlike that check there's
 * no all-bullets fallback: a draft with no Experience section yet has no
 * settled bullet convention to enforce. Each bullet absorbs the soft-wrapped
 * continuation lines below it so callers can read the prose's true end.
 */
function collectExperienceBullets(markdown: string): LogicalBullet[] {
  const lines = splitLines(markdown);
  const headings = findHeadings(lines);
  const headingByLine = new Map<number, Heading>();
  for (const h of headings) headingByLine.set(h.line, h);

  let currentH2: Heading | null = null;
  const out: LogicalBullet[] = [];
  for (let i = 0; i < lines.length; i++) {
    const li = lines[i];
    const h = headingByLine.get(li.line);
    if (h && h.level === 2) {
      currentH2 = h;
      continue;
    }
    if (h) continue;
    if (!isExperienceLikeH2(currentH2)) continue;
    const b = findBulletInLine(li);
    if (!b) continue;
    let endLine = li.text;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].text;
      if (t.trim() === '' || BULLET_BREAK_RE.test(t)) break;
      endLine = t;
    }
    out.push({ line: b.line, firstContent: b.content, endLine });
  }
  return out;
}

/** True when a line's prose ends in `.`, `!`, or `?` (trailing emphasis/space ignored). */
function endsWithSentencePunct(text: string): boolean {
  return /[.!?]$/.test(text.replace(/[*_~`\s]+$/, ''));
}

/**
 * #12 bullet-punctuation consistency. A resume that ends some Experience
 * bullets with a period and leaves others bare reads as unproofed. We take the
 * majority convention among the experience-style bullets and flag the minority
 * that breaks it, one finding per offending bullet. The rule stays quiet unless
 * there's a clear majority: a tie (3 with, 3 without) means no settled
 * convention, so nothing fires. Key-value bullets (`- label: value`) and
 * lead-in bullets ending with a colon are skipped — neither is a sentence the
 * convention applies to.
 */
function checkBulletPunctuation(markdown: string): HealthFinding[] {
  const pool = collectExperienceBullets(markdown).filter((b) => {
    const content = b.firstContent.replace(/^[*_~`]+/, '').trimStart();
    if (/^[A-Za-z][A-Za-z'-]*:/.test(content)) return false; // label: value
    if (/:[ \t]*$/.test(b.endLine)) return false; // lead-in to a sub-list
    return content.length > 0;
  });
  if (pool.length < 4) return [];

  const withPeriod: LogicalBullet[] = [];
  const without: LogicalBullet[] = [];
  for (const b of pool) {
    (endsWithSentencePunct(b.endLine) ? withPeriod : without).push(b);
  }
  if (withPeriod.length === 0 || without.length === 0) return [];
  if (withPeriod.length === without.length) return [];

  const majorityHasPeriod = withPeriod.length > without.length;
  const offenders = majorityHasPeriod ? without : withPeriod;
  return offenders.map((b) => ({
    id: 'bullet-punctuation',
    severity: 'warn' as const,
    message: majorityHasPeriod
      ? `Line ${b.line} ends without a period while most of your bullets do. Pick one and stick with it.`
      : `Line ${b.line} ends with a period while most of your bullets don't. Pick one and stick with it.`,
    line: b.line,
    offender: /(\S+)\s*$/.exec(b.endLine)?.[1],
  }));
}

/**
 * #11 leftover placeholders. Flags a line that still carries a template
 * token (`TODO`, `lorem ipsum`) or an unfilled `[...]` / `{{...}}` slot whose
 * inside names a placeholder field. Markdown links (`[label](url)`) are left
 * alone via the `(?!\()` guard. One finding per offending line, `bad`
 * severity — unlike the stylistic checks a placeholder shipped to a recruiter
 * is a plain mistake, not a matter of taste.
 */
function checkPlaceholders(markdown: string): HealthFinding[] {
  const lines = splitLines(markdown);
  const findings: HealthFinding[] = [];
  // Braces or non-link brackets. The `(?!\()` drops `[label](url)` links.
  const slotRe = /\{\{[^}]+\}\}|\[[^\]]+\](?!\()/g;

  for (const li of lines) {
    let offender: string | undefined;

    for (const token of PLACEHOLDER_TOKENS) {
      const m = new RegExp(`\\b${escapeRegExp(token)}\\b`, 'i').exec(li.text);
      if (m) {
        offender = m[0];
        break;
      }
    }

    if (!offender) {
      slotRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = slotRe.exec(li.text)) !== null) {
        const inner = m[0].toLowerCase();
        if (
          PLACEHOLDER_SLOT_WORDS.some((w) => new RegExp(`\\b${escapeRegExp(w)}\\b`).test(inner))
        ) {
          offender = m[0];
          break;
        }
      }
    }

    if (offender) {
      findings.push({
        id: 'placeholder',
        severity: 'bad',
        message: `Line ${li.line} still has a template placeholder ('${offender}'). Fill it in or delete it before sending.`,
        line: li.line,
        offender,
      });
    }
  }

  return findings;
}

/**
 * 1-based line number where the YAML frontmatter block ends, or `0` when the
 * document has no frontmatter. Used by checks that want to ignore the
 * frontmatter block without re-running the strip regex.
 */
function frontmatterEndLine(markdown: string): number {
  const re = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
  const m = re.exec(markdown);
  if (!m) return 0;
  // Count newlines in the matched span; the trailing `---` line is the last
  // frontmatter line and we want its 1-based line number.
  const normalized = m[0].replace(/\r/g, '');
  const lineCount = normalized.split('\n').length;
  return normalized.endsWith('\n') ? lineCount - 1 : lineCount;
}

/** #8 bullets per role. Groups bullets between H3 (or H2 if no H3). */
function checkBulletsPerRole(markdown: string): HealthFinding[] {
  const lines = splitLines(markdown);
  const headings = findHeadings(lines);
  const bullets = findBullets(lines);
  if (headings.length === 0 || bullets.length === 0) return [];

  // Walk top-down. Bullets belong to the nearest preceding H3, falling back
  // to the nearest preceding H2 when no H3 is open yet. Headings deeper than
  // H3 are ignored — they're sub-sections, not role boundaries.
  interface RoleGroup {
    heading: Heading;
    bullets: Bullet[];
  }
  const groups: RoleGroup[] = [];
  let currentH2: Heading | null = null;
  let currentH3: Heading | null = null;
  const headingByLine = new Map<number, Heading>();
  for (const h of headings) headingByLine.set(h.line, h);

  // Helper: open a new group keyed by the active heading (H3 if present, H2 otherwise).
  function openGroup(h: Heading): RoleGroup {
    const g: RoleGroup = { heading: h, bullets: [] };
    groups.push(g);
    return g;
  }

  let currentGroup: RoleGroup | null = null;
  const seenH3UnderH2 = new Set<number>();

  for (const li of lines) {
    const h = headingByLine.get(li.line);
    if (h) {
      if (h.level === 2) {
        currentH2 = h;
        currentH3 = null;
        currentGroup = null; // wait until we see a bullet to materialize a group
      } else if (h.level === 3) {
        currentH3 = h;
        currentGroup = openGroup(h);
        if (currentH2) seenH3UnderH2.add(currentH2.line);
      }
      continue;
    }
    // A bullet — attribute it to the current group.
    const bullet = findBulletInLine(li);
    if (!bullet) continue;
    // Only count bullets inside an Experience-flavored section. Without this
    // guard a Skills bulleted list, a "Selected Impact" feature list, or a
    // closing notes section would all be flagged "thin role" / "noisy role".
    if (!isExperienceLikeH2(currentH2)) continue;
    if (currentH3) {
      // Already in an H3 group — append.
      if (!currentGroup || currentGroup.heading !== currentH3) {
        currentGroup = openGroup(currentH3);
      }
      currentGroup.bullets.push(bullet);
    } else if (currentH2) {
      // Bullets directly under H2 (no H3 yet) — group at H2.
      if (!currentGroup || currentGroup.heading !== currentH2) {
        currentGroup = openGroup(currentH2);
      }
      currentGroup.bullets.push(bullet);
    }
  }

  const findings: HealthFinding[] = [];
  for (const g of groups) {
    const count = g.bullets.length;
    // Skip empty groups (a heading with no bullets is a section, not a role).
    if (count === 0) continue;
    if (count > BULLETS_PER_ROLE.max) {
      findings.push({
        id: 'bullets-per-role',
        severity: 'warn',
        message: `${g.heading.title} has ${count} bullets. Aim for 3–5.`,
        line: g.heading.line,
        offender: g.heading.title,
        // Point the user at the sample's Experience section — the canonical
        // shape for 3-5 outcome-led bullets per role.
        suggest: { kind: 'example', section: 'Experience' },
      });
    } else if (count < BULLETS_PER_ROLE.min) {
      findings.push({
        id: 'bullets-per-role',
        severity: 'warn',
        message: `${g.heading.title} has ${count} bullets. Aim for 3–5.`,
        line: g.heading.line,
        offender: g.heading.title,
        suggest: { kind: 'example', section: 'Experience' },
      });
    }
  }
  return findings;
}

/** Return the bullet for a line, or null when the line isn't a bullet. */
function findBulletInLine(li: LineInfo): Bullet | null {
  const m = /^[ \t]*[-*][ \t]+(.*)$/.exec(li.text);
  if (!m) return null;
  return { line: li.line, text: li.text, content: m[1] };
}

/** Escape a literal string for use inside a RegExp. */
function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ------------------------------------------------------------------ */
/* Scoring                                                             */
/* ------------------------------------------------------------------ */

/**
 * Per-rule weight multipliers, indexed by stage. Junior is more forgiving on
 * weak verbs (`× 0.5`) because early-career bullets often describe team
 * work; senior is stricter on buzzwords (`× 2`) because a senior resume that
 * leans on "rockstar / leverage / synergy" is signalling something.
 */
const RULE_WEIGHT: Record<CareerStage, Partial<Record<string, number>>> = {
  junior: { 'weak-verb': 0.5 },
  mid: {},
  senior: { buzzwords: 2 },
};

/** Per-finding score delta before stage-weighting and the per-rule cap. */
const SEVERITY_DELTA: Record<HealthSeverity, number> = {
  good: 0,
  warn: -2,
  bad: -10,
};

/** Maximum total points any single rule may subtract from the score. */
const PER_RULE_FLOOR = -20;

/**
 * Compose the score:
 *   1. Start at 100.
 *   2. For each rule with findings, sum its findings' deltas
 *      (`warn` → −2, `bad` → −10), multiply by the stage's per-rule weight,
 *      then cap that rule's contribution at `PER_RULE_FLOOR` (−20).
 *   3. Subtract every rule's capped contribution from 100. Floor at 0.
 *
 * The cap keeps a single noisy rule (e.g. ten weak-verb hits) from
 * dominating the score, while the stage weights bake in the rubric
 * differences without forking the rule code.
 */
function computeScore(findings: HealthFinding[], stage: CareerStage): number {
  const byRule = new Map<string, number>();
  for (const f of findings) {
    const prev = byRule.get(f.id) ?? 0;
    byRule.set(f.id, prev + SEVERITY_DELTA[f.severity]);
  }

  let score = 100;
  for (const [ruleId, raw] of byRule) {
    const weight = RULE_WEIGHT[stage][ruleId] ?? 1;
    const weighted = raw * weight;
    // `weighted` is non-positive; the cap is the more-negative of the two.
    const capped = Math.max(weighted, PER_RULE_FLOOR);
    score += capped;
  }

  return Math.max(0, Math.round(score));
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Stage progression — score thresholds the meter reads against        */
/* ------------------------------------------------------------------ */

/**
 * Score floors that gate "you're ready for the next tier." Tuned to roughly
 * match the rubric's intuition: a clean junior resume scores in the high 70s
 * at its own stage; mid hovers near 90; senior approaches 100. The meter is
 * coaching, not a verdict — `delta` of zero just means the writer has hit
 * the threshold, not that they should now retitle themselves.
 */
const STAGE_NEXT_THRESHOLD: Record<CareerStage, number> = {
  junior: 80,
  mid: 90,
  senior: 100,
};

/** Tier order the meter steps through. `null` past the last entry. */
const NEXT_STAGE: Record<CareerStage, CareerStage | null> = {
  junior: 'mid',
  mid: 'senior',
  senior: null,
};

/** Upper-case stage labels matching the issue's mock (`MID`, `SENIOR`). */
const STAGE_LABEL: Record<CareerStage, string> = {
  junior: 'JUNIOR',
  mid: 'MID',
  senior: 'SENIOR',
};

/**
 * Compute the stage-progression meter (#137).
 *
 * Returns the current tier label + the next tier's score threshold + how many
 * points away. At the top tier (`senior`) `next` is `null` and `delta` is
 * `0`. The UI uses `delta` to render the milestone hint:
 *
 *   `MID  ████████░░  98 → 100 to advance to SENIOR`
 */
export function stageProgress(score: number, stage: CareerStage): StageProgress {
  const next = NEXT_STAGE[stage];
  // `STAGE_NEXT_THRESHOLD[stage]` is the bar for the writer's CURRENT tier —
  // they've cleared it by definition. The meter measures distance to the
  // NEXT tier, so look up the next stage's bar (a `mid` writer aims for
  // the senior bar = 100, not their own bar = 90). Without this lookup
  // chain the meter rendered "98 → 90 to advance to SENIOR" — wrong
  // direction, wrong number. At the top tier `next` is null and the
  // threshold falls back to 100 with delta 0.
  const threshold = next === null ? 100 : STAGE_NEXT_THRESHOLD[next];
  const delta = next === null ? 0 : Math.max(0, threshold - score);
  return {
    current: stage,
    next,
    threshold,
    score,
    delta,
    label: STAGE_LABEL[stage],
  };
}

/* ------------------------------------------------------------------ */
/* Positives — inverted complement of the findings rubric              */
/* ------------------------------------------------------------------ */

/**
 * Bullets-per-role count for "What's working" output.
 *
 * Mirrors `checkBulletsPerRole` but returns the role groups instead of
 * findings — used to celebrate balanced roles (every group is in the
 * 2–6 envelope).
 */
function countRoleGroups(markdown: string): { total: number; inRange: number } {
  const lines = splitLines(markdown);
  const headings = findHeadings(lines);
  const bullets = findBullets(lines);
  if (headings.length === 0 || bullets.length === 0) return { total: 0, inRange: 0 };

  const headingByLine = new Map<number, Heading>();
  for (const h of headings) headingByLine.set(h.line, h);

  interface Group {
    heading: Heading;
    bullets: number;
  }
  const groups: Group[] = [];
  let currentH2: Heading | null = null;
  let currentH3: Heading | null = null;
  let currentGroup: Group | null = null;

  for (const li of lines) {
    const h = headingByLine.get(li.line);
    if (h) {
      if (h.level === 2) {
        currentH2 = h;
        currentH3 = null;
        currentGroup = null;
      } else if (h.level === 3) {
        currentH3 = h;
        currentGroup = { heading: h, bullets: 0 };
        groups.push(currentGroup);
      }
      continue;
    }
    const bullet = findBulletInLine(li);
    if (!bullet) continue;
    if (!isExperienceLikeH2(currentH2)) continue;
    if (currentH3) {
      if (!currentGroup || currentGroup.heading !== currentH3) {
        currentGroup = { heading: currentH3, bullets: 0 };
        groups.push(currentGroup);
      }
      currentGroup.bullets += 1;
    } else if (currentH2) {
      if (!currentGroup || currentGroup.heading !== currentH2) {
        currentGroup = { heading: currentH2, bullets: 0 };
        groups.push(currentGroup);
      }
      currentGroup.bullets += 1;
    }
  }

  const populated = groups.filter((g) => g.bullets > 0);
  const inRange = populated.filter(
    (g) => g.bullets >= BULLETS_PER_ROLE.min && g.bullets <= BULLETS_PER_ROLE.max,
  ).length;
  return { total: populated.length, inRange };
}

/** Count quantified bullets in the experience-style scope, mirroring `checkQuantification`. */
function countExperienceBullets(markdown: string): {
  total: number;
  withDigits: number;
  activeOpeners: number;
} {
  const lines = splitLines(markdown);
  const headings = findHeadings(lines);
  const allBullets = findBullets(lines);
  if (allBullets.length === 0) return { total: 0, withDigits: 0, activeOpeners: 0 };

  const headingByLine = new Map<number, Heading>();
  for (const h of headings) headingByLine.set(h.line, h);

  let currentH2: Heading | null = null;
  let hasExperienceH2 = false;
  const experienceBullets: Bullet[] = [];

  for (const li of lines) {
    const h = headingByLine.get(li.line);
    if (h && h.level === 2) {
      currentH2 = h;
      if (isExperienceLikeH2(h)) hasExperienceH2 = true;
      continue;
    }
    if (h) continue;
    if (!isExperienceLikeH2(currentH2)) continue;
    const bullet = findBulletInLine(li);
    if (bullet) experienceBullets.push(bullet);
  }

  const pool = hasExperienceH2 ? experienceBullets : allBullets;
  if (pool.length === 0) return { total: 0, withDigits: 0, activeOpeners: 0 };

  const withDigits = pool.filter((b) => /\d/.test(b.content)).length;
  // Active-verb opener: starts with a capitalized verb (any single capitalized
  // word) AND does not match any of the WEAK_VERB_PHRASES. The check mirrors
  // checkWeakVerbs' inversion — passing both is what "active opener" means.
  let activeOpeners = 0;
  for (const bullet of pool) {
    const content = bullet.content.replace(/^[*_~`]+/, '').trimStart();
    if (!/^[A-Z][a-zA-Z]+\b/.test(content)) continue;
    let weak = false;
    for (const phrase of WEAK_VERB_PHRASES) {
      const re = new RegExp(`^${escapeRegExp(phrase)}\\b`, 'i');
      if (re.test(content)) {
        weak = true;
        break;
      }
    }
    if (!weak) activeOpeners += 1;
  }
  return { total: pool.length, withDigits, activeOpeners };
}

/** Extract numeric tokens from experience-style bullets ("8 years", "140 services", "4x"). */
function countNumericClaims(markdown: string): number {
  const lines = splitLines(markdown);
  const headings = findHeadings(lines);
  const headingByLine = new Map<number, Heading>();
  for (const h of headings) headingByLine.set(h.line, h);

  let currentH2: Heading | null = null;
  let count = 0;
  for (const li of lines) {
    const h = headingByLine.get(li.line);
    if (h && h.level === 2) {
      currentH2 = h;
      continue;
    }
    if (h) continue;
    if (!isExperienceLikeH2(currentH2)) continue;
    const bullet = findBulletInLine(li);
    if (!bullet) continue;
    const numbers = bullet.content.match(/\d+/g);
    if (numbers) count += numbers.length;
  }
  return count;
}

/** First-person hits across all bullets, for the "no first person" positive. */
function countFirstPersonBullets(markdown: string): number {
  const lines = splitLines(markdown);
  const bullets = findBullets(lines);
  let count = 0;
  for (const bullet of bullets) {
    if (findFirstPersonWord(bullet.content)) count += 1;
  }
  return count;
}

/**
 * Lift 3–5 positive signals out of the same heuristics that produce findings
 * (#137). Each entry inverts a finding rule: when the rule WOULD have fired
 * but didn't, we celebrate it.
 *
 * Returns at most five entries so the strip stays a celebrate, not a victory
 * lap. The order mirrors the findings rubric (length → frontmatter → sections
 * → quantification → active verbs → ...) so the same writer sees a stable
 * shape between sessions.
 *
 * Pure: same inputs → same output. Never throws — when a check can't run
 * cleanly (no bullets, no Experience section) it simply contributes nothing.
 */
export function summarizePositives(
  markdown: string,
  parsed: ParsedResume,
  stage: CareerStage,
): readonly Positive[] {
  const positives: Positive[] = [];

  // 1. Quantification rate ≥ floor → "N quantified bullets".
  const { total: bulletTotal, withDigits, activeOpeners } = countExperienceBullets(markdown);
  if (bulletTotal > 0) {
    const ratio = withDigits / bulletTotal;
    if (ratio >= QUANT_FLOOR[stage] && withDigits >= 2) {
      positives.push({
        id: 'quantification',
        message: `${withDigits} quantified bullets`,
      });
    }
  }

  // 2. Active-verb opener rate ≥ 60% → "active-verb openers".
  if (bulletTotal >= 3) {
    const ratio = activeOpeners / bulletTotal;
    if (ratio >= 0.6) {
      positives.push({
        id: 'active-verb',
        message: 'active-verb openers',
      });
    }
  }

  // 3. Years of progression — derived from the volume of numeric claims in
  //    experience bullets. "8 years" / "140 services" / "4x" all count; the
  //    threshold is intentionally low (≥ 4 numeric tokens) so a draft with
  //    even modest evidence gets celebrated.
  const numericClaims = countNumericClaims(markdown);
  if (numericClaims >= 4) {
    positives.push({
      id: 'numeric-claims',
      message: `${numericClaims} numeric claims`,
    });
  }

  // 4. Required sections present → "all required sections".
  const sectionFindings = checkSections(markdown, stage);
  if (sectionFindings.length === 0) {
    const required = REQUIRED_SECTIONS_BY_STAGE[stage];
    positives.push({
      id: 'sections',
      message: `${required.length} required sections present`,
    });
  }

  // 5. Frontmatter complete → "frontmatter complete".
  if (checkFrontmatter(parsed).length === 0) {
    positives.push({
      id: 'frontmatter',
      message: 'frontmatter complete',
    });
  }

  // 6. No first-person voice in bullets → "third-person voice".
  const lines = splitLines(markdown);
  if (findBullets(lines).length >= 3 && countFirstPersonBullets(markdown) === 0) {
    positives.push({
      id: 'first-person',
      message: 'consistent third-person voice',
    });
  }

  // 7. Bullets-per-role envelope clean → "N balanced roles".
  const { total: roleTotal, inRange } = countRoleGroups(markdown);
  if (roleTotal >= 1 && inRange === roleTotal) {
    positives.push({
      id: 'bullets-per-role',
      message:
        roleTotal === 1
          ? '1 balanced role (2–6 bullets)'
          : `${roleTotal} balanced roles (2–6 bullets)`,
    });
  }

  // Cap at five so the strip stays compact. Order is preserved from the list
  // above — the most-impactful signals (quantification, active verbs) lead.
  return positives.slice(0, 5);
}

/**
 * Analyze a Markdown resume and produce a stage-aware `HealthReport`.
 *
 * Pure: same inputs → same output. Never throws — heuristics that can't run
 * cleanly return zero findings. Safe to call in a `useMemo`.
 */
export function analyzeResume(
  markdown: string,
  parsed: ParsedResume,
  stage: CareerStage,
): HealthReport {
  const findings: HealthFinding[] = [];

  // The rules are listed in the same order as the rubric table so the
  // findings list reads top-to-bottom in a predictable shape.
  findings.push(...checkLength(markdown, stage));
  findings.push(...checkFrontmatter(parsed));
  findings.push(...checkSections(markdown, stage));
  findings.push(...checkQuantification(markdown, stage));
  findings.push(...checkWeakVerbs(markdown));
  findings.push(...checkPassiveVoice(markdown));
  findings.push(...checkFirstPerson(markdown));
  findings.push(...checkBuzzwords(markdown));
  findings.push(...checkVagueQuantifiers(markdown));
  findings.push(...checkFillerAdverbs(markdown));
  findings.push(...checkOpenEndedLists(markdown));
  findings.push(...checkReferencesLine(markdown));
  findings.push(...checkObjectiveStatement(markdown));
  findings.push(...checkPersonalDetails(markdown));
  findings.push(...checkRepeatedOpeners(markdown));
  findings.push(...checkBulletsPerRole(markdown));
  findings.push(...checkLongBullets(markdown));
  findings.push(...checkStuffedBullets(markdown));
  findings.push(...checkBulletPunctuation(markdown));
  findings.push(...checkPlaceholders(markdown));

  const score = computeScore(findings, stage);
  return { stage, score, findings };
}
