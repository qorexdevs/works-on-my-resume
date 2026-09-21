/**
 * tailor.ts — local, AI-free job-description keyword overlap (#91).
 *
 * Pure functions, no React, no DOM, no network, no storage. Everything in
 * this file operates on plain strings; the React component owns the lifecycle
 * and feeds rendered preview `.textContent` in / matches out.
 *
 * Algorithm sketch
 * ----------------
 * `extractTerms(jdText)` returns a deduped, frequency-ranked list of terms
 * the JD is "really about". It is intentionally cheap and explainable —
 * stoplist + capitalization heuristic + bigrams — rather than statistical
 * (no TF-IDF corpus, no embeddings). The trade-off is acceptable: we get
 * "Kubernetes" / "incident response" / "Postgres" out of typical SRE / dev
 * job posts, and ignore "looking for a strong, passionate team player".
 *
 *   1. Tokenize on whitespace + punctuation. Keep tokens of length ≥ 2.
 *   2. Drop stopwords — common English words PLUS generic resume / JD
 *      vocabulary (`experience`, `team`, `ability`, `strong`, etc.).
 *   3. Capitalized-noun heuristic: a token that appears capitalized in the
 *      source is kept as a unigram candidate, UNLESS its lowercase form ALSO
 *      appears elsewhere as a regular lowercase word (in which case it was
 *      probably just sentence-starting — demote).
 *   4. Bigrams: every adjacent pair where neither token is a stopword and
 *      at least one is capitalized, OR the bigram appears ≥ 2 times.
 *   5. Sort by frequency desc, then alphabetic.
 *
 * `matchResume(terms, resumeText)` is a case-insensitive substring scan over
 * the resume's rendered text. Resume text is the preview pane's
 * `.textContent`, NOT raw Markdown, because that is what the recruiter
 * actually reads.
 *
 * Trust boundary
 * --------------
 * The JD is user-typed text; treat it as untrusted. This module never emits
 * HTML — it returns `string` and `TailorMatch` objects with primitive
 * fields. The React layer is responsible for rendering JD-derived text only
 * inside `.textContent` (never `innerHTML`).
 */

import techTermsData from '../data/tech-terms.json';
import softSkillsData from '../data/soft-skills.json';

/* ------------------------------------------------------------------ */
/* Public types                                                        */
/* ------------------------------------------------------------------ */

/** Whether a term is a single token or a two-token phrase. */
export type TailorTermKind = 'unigram' | 'bigram';

/**
 * Term categories for the grouped Matches / Gaps UI (#116).
 *
 * - `tech`   programming languages, frameworks, tools, platforms
 * - `soft`   collaboration / people / process vocabulary
 * - `domain` everything else; default bucket for capitalized nouns
 */
export type TailorCategory = 'tech' | 'soft' | 'domain';

/** A term extracted from a JD. */
export interface TailorTerm {
  /** The normalized (lowercase) form used for matching. */
  term: string;
  /** A pretty form to render in the UI — original casing from the JD. */
  displayTerm: string;
  /** Number of times the term appears in the JD. */
  frequency: number;
  /** Whether this is a single token or a bigram phrase. */
  kind: TailorTermKind;
}

/** A term's match status against the resume text. */
export interface TailorMatch {
  /** The originating term. */
  term: TailorTerm;
  /** True iff the term was found in the resume text (case-insensitive). */
  matched: boolean;
  /** Number of occurrences in the resume (0 when `matched` is false). */
  occurrences: number;
}

/** Aggregate over a list of matches — useful for the "hit rate" chip. */
export interface TailorOverlapSummary {
  /** matched-count / total-count, in [0, 1]. */
  hitRate: number;
  /** Up to `n` terms that did NOT match the resume, ranked by JD frequency. */
  topGaps: TailorTerm[];
}

/* ------------------------------------------------------------------ */
/* Stopwords                                                           */
/* ------------------------------------------------------------------ */

/**
 * Stopwords — common English words plus generic resume / JD vocabulary that
 * adds no signal to a tailoring exercise. The list is intentionally
 * hand-curated: a bigger list would start dropping real terms (e.g.
 * "experience" alone is noise, but "data engineer experience" is meaningful
 * — the bigram check catches that since `data` and `engineer` are kept).
 *
 * Lowercase entries only. Lookups are case-insensitive on the normalized
 * token.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  // English function words.
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'if',
  'then',
  'else',
  'when',
  'while',
  'of',
  'at',
  'by',
  'for',
  'with',
  'about',
  'against',
  'between',
  'into',
  'through',
  'during',
  'before',
  'after',
  'above',
  'below',
  'to',
  'from',
  'up',
  'down',
  'in',
  'out',
  'on',
  'off',
  'over',
  'under',
  'again',
  'further',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'having',
  'do',
  'does',
  'did',
  'doing',
  'will',
  'would',
  'should',
  'could',
  'can',
  'may',
  'might',
  'must',
  'shall',
  'as',
  'so',
  'than',
  'too',
  'very',
  'just',
  'now',
  'this',
  'that',
  'these',
  'those',
  'we',
  'you',
  'they',
  'he',
  'she',
  'it',
  'i',
  'me',
  'my',
  'our',
  'your',
  'their',
  'his',
  'her',
  'its',
  'who',
  'what',
  'which',
  'whose',
  'whom',
  'not',
  'no',
  'nor',
  'only',
  'own',
  'same',
  'such',
  'any',
  'each',
  'all',
  'both',
  'most',
  'more',
  'some',
  'few',
  'other',
  'another',
  // Generic resume / JD chrome.
  'experience',
  'experienced',
  'team',
  'teams',
  'ability',
  'abilities',
  'strong',
  'excellent',
  'good',
  'great',
  'proven',
  'role',
  'roles',
  'work',
  'working',
  'works',
  'worked',
  'job',
  'jobs',
  'position',
  'positions',
  'opportunity',
  'opportunities',
  'candidate',
  'candidates',
  'applicant',
  'applicants',
  'looking',
  'seeking',
  'required',
  'requirements',
  'requirement',
  'responsibilities',
  'responsibility',
  'qualifications',
  'qualification',
  'skill',
  'skills',
  'knowledge',
  'understanding',
  'familiar',
  'familiarity',
  'years',
  'year',
  'plus',
  'minimum',
  'preferred',
  'must',
  'should',
  'will',
  'company',
  'companies',
  'environment',
  'environments',
  'culture',
  'business',
  'product',
  'products',
  'project',
  'projects',
  'people',
  'person',
  'member',
  'members',
  'staff',
  'employee',
  'employees',
  'manager',
  'managers',
  'leader',
  'leaders',
  'leadership',
  'including',
  'include',
  'includes',
  'such',
  'etc',
  'e.g',
  'i.e',
  'use',
  'using',
  'used',
  'help',
  'helps',
  'helping',
  'helped',
  'support',
  'supports',
  'supporting',
  'supported',
  'across',
  'within',
  'around',
  'among',
  'new',
  'great',
  'best',
  'top',
  'high',
  'low',
  'level',
  'levels',
  'senior',
  'junior',
  'mid',
  'lead',
  'principal',
  'staff',
  'us',
  'them',
  'about',
  'also',
  'well',
  'like',
  'looking',
  'someone',
  'everyone',
  'anything',
  'something',
  'one',
  'two',
  'three',
  'four',
  'five',
  'many',
  'much',
  'lot',
  'lots',
]);

/* ------------------------------------------------------------------ */
/* Tokenization                                                         */
/* ------------------------------------------------------------------ */

/**
 * A single token from the source plus its original casing. We keep both
 * because the case decides whether the unigram heuristic accepts the token,
 * but match-matching always operates on the normalized lowercase form.
 */
interface Token {
  /** Lowercased form — the key used for stopword lookup and dedupe. */
  norm: string;
  /** Original casing from the source — used for `displayTerm`. */
  raw: string;
  /** True iff the original token started with an uppercase letter. */
  capitalized: boolean;
  /** True iff the original token was ALL uppercase (e.g. `AWS`). */
  allCaps: boolean;
}

/**
 * Tokenize on whitespace + punctuation, keeping tokens of length ≥ 2.
 *
 * Punctuation classes we DO want to keep as token-internal:
 *  - `'` (apostrophe) — preserve `don't`, `team's` so the stopword can match
 *  - `-` (hyphen) — preserve `infrastructure-as-code`, `on-call`
 *  - `+` (plus) — preserve `c++`, `notion+jira`
 *  - `.` (dot) — preserve `node.js`, `next.js`
 *  - `/` (slash) — preserve `ci/cd`, `tcp/ip`
 *
 * Everything else is treated as a token boundary.
 */
function tokenize(text: string): Token[] {
  // The regex describes ONE token: a run of word chars / dots / slashes /
  // pluses / hyphens / apostrophes. The `g` flag steps through the source.
  // `\p{L}` and `\p{N}` (Unicode letters / numbers) cover non-ASCII names
  // gracefully — a JD that mentions `Café` or `Æther` still tokenizes.
  const re = /[\p{L}\p{N}][\p{L}\p{N}.'+/-]*/gu;
  const out: Token[] = [];
  for (const match of text.matchAll(re)) {
    const raw = match[0];
    if (raw.length < 2) continue;
    // Trim trailing punctuation that the regex grabbed at the end —
    // `Kubernetes.` keeps its `s` but drops the `.`. Without this every
    // sentence-final word would become its own variant of itself.
    const trimmed = raw.replace(/[.'+/-]+$/u, '');
    if (trimmed.length < 2) continue;
    const norm = trimmed.toLowerCase();
    const firstChar = trimmed[0];
    const capitalized = firstChar !== firstChar.toLowerCase();
    const allCaps = trimmed.length >= 2 && trimmed === trimmed.toUpperCase();
    out.push({ norm, raw: trimmed, capitalized, allCaps });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Term extraction                                                     */
/* ------------------------------------------------------------------ */

/**
 * Frequency-bucketed running tally for a candidate term. The display form
 * is held alongside the count so we can prefer the prettiest casing we
 * saw (e.g. `AWS` over `aws` if both appear, or `Kubernetes` over
 * `kubernetes`).
 */
interface TermAccumulator {
  norm: string;
  display: string;
  count: number;
  kind: TailorTermKind;
}

/* ------------------------------------------------------------------ */
/* Bundled-phrase lowercase sweep (#121)                                */
/* ------------------------------------------------------------------ */

/**
 * Escape regex special characters in a string so it can be embedded in a
 * `new RegExp(...)` literal. We use the resulting fragment outside a
 * character class with the Unicode (`u`) flag, where `-` is NOT a
 * metacharacter and escaping it produces an `Invalid escape` SyntaxError
 * — hence the deliberate omission. The hyphen in `on-call` /
 * `cross-functional` is matched literally without escaping.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * Pure-acronym detector: ALL-uppercase short strings that the existing
 * extractor's all-caps unigram rule already catches (`AWS`, `SQL`, `GPU`).
 * The sweep skips these to avoid double-counting; the canonical bundled
 * casing for tech entries is lowercase, so we look at the heuristic shape
 * instead of the JSON casing.
 *
 * Single-token entries with ≤ 4 chars and no non-alpha characters are
 * treated as candidate acronyms — these are the ones a human reader would
 * write in CAPS in a JD (`AWS`, `GCP`, `SQL`, `JWT`, `K8S`). Multi-token
 * entries and entries with digits / punctuation (`s3`, `ec2`, `tcp/ip`,
 * `node.js`) are NOT considered acronyms and DO benefit from the sweep
 * because a JD might write `node.js` in lowercase prose.
 */
function isLikelyAcronymTechEntry(entry: string): boolean {
  if (entry.length > 4) return false;
  if (entry.includes(' ')) return false;
  // Pure alphabetic, no punctuation / digits. `c++`, `c#`, `s3`, `ec2` fail.
  return /^[a-z]+$/.test(entry);
}

/**
 * Canonical display casing for a soft-skill entry: Title Case each word.
 * The JSON file stores lowercase entries; we Title-Case at module load so
 * the UI renders `Stakeholder Management` rather than `stakeholder
 * management`.
 *
 * Hyphenated tokens have each segment capitalized (`on-call` →
 * `On-Call`, `cross-functional` → `Cross-Functional`).
 */
function titleCaseSoftEntry(entry: string): string {
  return entry
    .split(/(\s+)/)
    .map((part) => {
      if (/^\s+$/.test(part)) return part;
      return part
        .split('-')
        .map((seg) => (seg.length === 0 ? seg : seg[0].toUpperCase() + seg.slice(1)))
        .join('-');
    })
    .join('');
}

/**
 * A single bundled entry pre-compiled for the lowercase sweep.
 *
 * `regex` is built ONCE at module load (not per `extractTerms` call) — the
 * combined bundled lists are ~440 entries and rebuilding the regex set per
 * call would be measurable on the hot path. The trade-off is that the
 * regexes live for the life of the module; at ~440 small regex objects
 * this is negligible.
 *
 * Word boundaries use `(?<![\\p{L}\\p{N}])` / `(?![\\p{L}\\p{N}])` rather
 * than `\\b` so tokens with embedded punctuation (`node.js`, `tcp/ip`,
 * `c++`) match correctly — `\\b` would split on the `.` / `+` / `/`.
 */
interface BundledEntry {
  /** Lowercase form — used as the `term` field on the produced TailorTerm. */
  norm: string;
  /** Canonical casing used as the `displayTerm`. */
  display: string;
  /** Whether the entry is a single token or a multi-token phrase. */
  kind: TailorTermKind;
  /** Pre-compiled global regex that matches the lowercase form. */
  regex: RegExp;
}

/**
 * Build the swept entry list ONCE per module load. The sweep runs after
 * normal extraction in `extractTerms`, and the inputs (bundled JSON
 * lists) are static — there is no per-call state that would change the
 * regex set.
 *
 * For tech entries we drop pure ASCII-alpha short tokens (acronym shape)
 * because the existing all-caps unigram path already surfaces them and
 * adding a lowercase pass would double-count. Multi-token tech entries
 * (`apache kafka`, `aws lambda`) and entries with digits / punctuation
 * (`s3`, `ec2`, `node.js`, `tcp/ip`) DO sweep — the existing extractor's
 * bigram rule needs capitalization OR a frequency of 2, which a single
 * lowercase mention in JD prose lacks.
 */
function buildBundledEntries(): BundledEntry[] {
  const out: BundledEntry[] = [];
  const seen = new Set<string>();
  for (const entry of softSkillsData as readonly string[]) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    const kind: TailorTermKind = entry.includes(' ') ? 'bigram' : 'unigram';
    out.push({
      norm: entry,
      display: titleCaseSoftEntry(entry),
      kind,
      regex: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(entry)}(?![\\p{L}\\p{N}])`, 'giu'),
    });
  }
  for (const entry of techTermsData as readonly string[]) {
    if (seen.has(entry)) continue;
    if (isLikelyAcronymTechEntry(entry)) continue;
    seen.add(entry);
    const kind: TailorTermKind = entry.includes(' ') ? 'bigram' : 'unigram';
    out.push({
      norm: entry,
      // Bundled tech list is lowercase — preserve as-is.
      display: entry,
      kind,
      regex: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(entry)}(?![\\p{L}\\p{N}])`, 'giu'),
    });
  }
  return out;
}

const BUNDLED_ENTRIES: readonly BundledEntry[] = buildBundledEntries();

/** Stable comparator: frequency desc, then display alphabetic. */
function compareTerms(a: TailorTerm, b: TailorTerm): number {
  if (b.frequency !== a.frequency) return b.frequency - a.frequency;
  return a.displayTerm.localeCompare(b.displayTerm);
}

/**
 * Pick the prettier of two casings for the same lowercase form. The rule:
 * an all-caps form (`AWS`) beats an initial-cap form (`Aws`), which beats
 * a lowercase form (`aws`). Ties go to the longer string, which is a
 * reasonable proxy for "more specific".
 */
function preferredDisplay(a: string, b: string): string {
  const score = (s: string): number => {
    if (s === s.toUpperCase() && /[A-Z]/.test(s)) return 3;
    if (s[0] === s[0].toUpperCase() && s[0] !== s[0].toLowerCase()) return 2;
    return 1;
  };
  const sa = score(a);
  const sb = score(b);
  if (sa !== sb) return sa > sb ? a : b;
  return a.length >= b.length ? a : b;
}

/**
 * Extract a deduped, frequency-ranked list of terms the JD is "about".
 *
 * @example
 *   const terms = extractTerms(`
 *     Senior Platform Engineer. Experience with Kubernetes, Postgres,
 *     and incident response. We use Postgres heavily.
 *   `);
 *   // terms[0].displayTerm === 'Postgres' (frequency 2)
 *   // terms.some(t => t.term === 'kubernetes') === true
 *   // terms.some(t => t.term === 'incident response') === true
 */
export function extractTerms(jdText: string): TailorTerm[] {
  if (!jdText || jdText.trim().length === 0) return [];

  const tokens = tokenize(jdText);

  /* Pass 1: count the lowercase frequency of EVERY non-stopword token.
     We need this to (a) feed unigram candidates and (b) drive the bigram
     "appears ≥ 2 times" rule, and (c) demote capitalized tokens that ALSO
     appear lowercase elsewhere — those are sentence-starters, not nouns. */
  const tokenCounts = new Map<string, number>();
  const lowercaseHits = new Map<string, number>();
  const displays = new Map<string, string>();
  for (const t of tokens) {
    if (STOPWORDS.has(t.norm)) continue;
    tokenCounts.set(t.norm, (tokenCounts.get(t.norm) ?? 0) + 1);
    if (!t.capitalized) {
      lowercaseHits.set(t.norm, (lowercaseHits.get(t.norm) ?? 0) + 1);
    }
    const prev = displays.get(t.norm);
    displays.set(t.norm, prev ? preferredDisplay(prev, t.raw) : t.raw);
  }

  /* Pass 2: collect unigram candidates. A unigram qualifies if it is
     capitalized somewhere AND is NOT predominantly lowercase elsewhere.
     "Predominantly lowercase" = the lowercase form appears at least as
     often as the capitalized form (sentence-starter sniffing). All-caps
     forms (`AWS`, `SLA`) always qualify — they are never sentence-starters
     because acronyms don't lose their caps mid-sentence. */
  const acc = new Map<string, TermAccumulator>();
  const seenCapitalized = new Map<string, { capCount: number; allCapsSeen: boolean }>();
  for (const t of tokens) {
    if (STOPWORDS.has(t.norm)) continue;
    if (!t.capitalized) continue;
    const prev = seenCapitalized.get(t.norm) ?? { capCount: 0, allCapsSeen: false };
    prev.capCount += 1;
    if (t.allCaps) prev.allCapsSeen = true;
    seenCapitalized.set(t.norm, prev);
  }
  for (const [norm, { capCount, allCapsSeen }] of seenCapitalized.entries()) {
    const lower = lowercaseHits.get(norm) ?? 0;
    // Acronyms ALWAYS qualify (allCapsSeen). Otherwise we need the
    // capitalization to dominate — strict greater-than, so a single `In` at
    // the start of a sentence doesn't sneak through.
    if (!allCapsSeen && lower >= capCount) continue;
    acc.set(norm, {
      norm,
      display: displays.get(norm) ?? norm,
      count: tokenCounts.get(norm) ?? capCount,
      kind: 'unigram',
    });
  }

  /* Pass 3: bigrams. Scan adjacent pairs in the token stream; keep the
     pair if neither token is a stopword and (at least one is capitalized
     OR the lowercase pair appears ≥ 2 times). The bigram's display form
     uses the preferred casings of its two parts. */
  const bigramCounts = new Map<string, number>();
  const bigramDisplays = new Map<string, string>();
  const bigramHasCap = new Map<string, boolean>();
  for (let i = 0; i < tokens.length - 1; i++) {
    const a = tokens[i];
    const b = tokens[i + 1];
    if (STOPWORDS.has(a.norm) || STOPWORDS.has(b.norm)) continue;
    const key = `${a.norm} ${b.norm}`;
    bigramCounts.set(key, (bigramCounts.get(key) ?? 0) + 1);
    const display = `${displays.get(a.norm) ?? a.raw} ${displays.get(b.norm) ?? b.raw}`;
    bigramDisplays.set(key, display);
    if (a.capitalized || b.capitalized) bigramHasCap.set(key, true);
  }
  for (const [key, count] of bigramCounts.entries()) {
    const hasCap = bigramHasCap.get(key) ?? false;
    if (!hasCap && count < 2) continue;
    acc.set(key, {
      norm: key,
      display: bigramDisplays.get(key) ?? key,
      count,
      kind: 'bigram',
    });
  }

  /* Pass 4 (#121): lowercase sweep against bundled vocabularies.

     Soft-skill phrases like `stakeholder management` and `incident
     response` routinely appear in lowercase JD prose ("we look for
     someone with strong stakeholder management skills"). The
     capitalization heuristic above misses them — neither token is
     capitalized AND a single occurrence falls below the bigram-frequency
     threshold of 2.

     We sweep the JD lowercased against pre-compiled regexes built once
     at module load. Pure-acronym tech tokens are skipped (the existing
     all-caps unigram path already catches `AWS`, `SQL`, etc.). Any term
     already collected by the normal passes is left alone — we never
     overwrite a count or display we already chose.

     The display casing comes from the bundled list: Title Case for soft
     phrases (the JSON is lowercase but the UI wants "Stakeholder
     Management"), as-is for tech entries (the JSON is the canonical
     casing we want — `node.js`, `cloud run`, `aws lambda`). */
  if (BUNDLED_ENTRIES.length > 0) {
    for (const entry of BUNDLED_ENTRIES) {
      if (acc.has(entry.norm)) continue;
      // Count via `matchAll` — the regex has `/g` so iteration is
      // incremental, and `String.matchAll` returns a fresh iterator
      // each call, which is what we want for parallel sweeps.
      let count = 0;
      for (const _m of jdText.matchAll(entry.regex)) {
        void _m;
        count += 1;
      }
      if (count === 0) continue;
      acc.set(entry.norm, {
        norm: entry.norm,
        display: entry.display,
        count,
        kind: entry.kind,
      });
    }
  }

  /* Materialize and sort. */
  const out: TailorTerm[] = [];
  for (const a of acc.values()) {
    out.push({
      term: a.norm,
      displayTerm: a.display,
      frequency: a.count,
      kind: a.kind,
    });
  }
  out.sort(compareTerms);
  return out;
}

/* ------------------------------------------------------------------ */
/* Resume matching                                                     */
/* ------------------------------------------------------------------ */

/**
 * Case-insensitive substring count of `needle` in `haystack`. Uses a manual
 * `indexOf` scan rather than a regex so JD terms with regex-special
 * characters (`C++`, `.NET`, `Node.js`) match literally — without the
 * scan-then-escape ceremony.
 *
 * Bigrams match across any whitespace run in the resume: we normalize the
 * resume's whitespace to single spaces before counting, so "incident
 * response" matches even if the resume has "incident\n  response" across a
 * line break. Single tokens are unaffected.
 */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  let count = 0;
  let from = 0;
  while (true) {
    const idx = h.indexOf(n, from);
    if (idx === -1) break;
    count += 1;
    from = idx + n.length;
  }
  return count;
}

/**
 * For each term, count its case-insensitive occurrences in the resume.
 *
 * `resumeText` should be the rendered preview's `.textContent` — i.e. what
 * the reader actually sees — NOT the raw Markdown. This keeps the matcher
 * honest about identity-header / frontmatter content that lives outside the
 * Markdown body.
 *
 * @example
 *   const terms = extractTerms('Kubernetes, Postgres, Salesforce.');
 *   const matches = matchResume(terms, 'I have shipped Kubernetes ...');
 *   // matches.find(m => m.term.term === 'kubernetes').matched === true
 *   // matches.find(m => m.term.term === 'salesforce').matched === false
 */
export function matchResume(terms: TailorTerm[], resumeText: string): TailorMatch[] {
  // Collapse whitespace so bigrams match across line breaks.
  const normalizedResume = resumeText.replace(/\s+/g, ' ');
  const out: TailorMatch[] = [];
  for (const term of terms) {
    const occurrences = countOccurrences(normalizedResume, term.term);
    out.push({ term, matched: occurrences > 0, occurrences });
  }
  return out;
}

/**
 * Summarize a list of matches: the overall hit-rate and the top-N gaps
 * (terms NOT in the resume), ranked by JD frequency.
 *
 * @example
 *   const summary = summarizeOverlap(matches, 8);
 *   // summary.hitRate ∈ [0, 1]
 *   // summary.topGaps.length <= 8
 */
export function summarizeOverlap(matches: TailorMatch[], maxGaps = 8): TailorOverlapSummary {
  if (matches.length === 0) return { hitRate: 0, topGaps: [] };
  const matched = matches.filter((m) => m.matched).length;
  const gaps = matches.filter((m) => !m.matched).map((m) => m.term);
  // `matches` is already in extraction order (freq desc, alpha tiebreak),
  // and we filtered without reordering, so slicing is enough.
  return {
    hitRate: matched / matches.length,
    topGaps: gaps.slice(0, Math.max(0, maxGaps)),
  };
}

/**
 * Format a hit-rate as `X / Y (Z%)`. Pure helper, used by the UI chip and
 * the aria-live announcement; lives here so the rounding rule (floor on
 * the percentage, so "34 of 100" reads as 34%, not 34.0%) is colocated
 * with the data it formats.
 *
 * @example
 *   formatHitRate(12, 35) === '12 / 35 (34%)'
 *   formatHitRate(0, 0) === '0 / 0 (0%)'
 */
export function formatHitRate(matched: number, total: number): string {
  const pct = total === 0 ? 0 : Math.floor((matched / total) * 100);
  return `${matched} / ${total} (${pct}%)`;
}

/* ------------------------------------------------------------------ */
/* Classification (#116)                                                */
/* ------------------------------------------------------------------ */

/**
 * Bundled lowercase tech / soft vocabularies. The JSON modules are imported
 * statically at module top — these lists are small enough (~2 KB gzipped
 * combined) that splitting them into a dynamic chunk would cost more in
 * round-trip latency than it saves in initial-bundle bytes. Wrapped in
 * `Set` for O(1) membership checks.
 */
const TECH_TERMS: ReadonlySet<string> = new Set(techTermsData as readonly string[]);
const SOFT_SKILLS: ReadonlySet<string> = new Set(softSkillsData as readonly string[]);

/**
 * Acronym / suffix heuristic for tech tokens not in the bundled list.
 *
 * Catches things like `AWS`, `SLA`, `K8S`, `GPU`, `node.js`, `next.js`,
 * `mongodb`, `nosql`, `graphql`, `tcp/ip`, `c++`, `c#`, `f#`. We keep the
 * suffix family narrow on purpose — `ts`, `qa`, `ci` were considered and
 * dropped because too many everyday English words end that way (`acts`,
 * `tests`, `parts`).
 */
function looksLikeTechToken(displayToken: string, normToken: string): boolean {
  // All-caps acronym: ≥ 2 chars, only A-Z / 0-9, at least one letter.
  // Acronyms are by far the strongest tech signal in a JD.
  if (displayToken.length >= 2 && /^[A-Z0-9]+$/.test(displayToken) && /[A-Z]/.test(displayToken)) {
    return true;
  }
  // Tech-shape suffixes on tokens that either have tech-like punctuation /
  // digits or are long enough that the suffix is unlikely to be English
  // morphology. `mongodb`, `cosmosdb`, `graphql`, `nosql`, `nextjs`,
  // `node.js`, `vue.js`, `pgsql` all pass; `pubs`, `tabs`, `mods`, `webs`
  // don't.
  const hasTechShape = normToken.includes('.') || normToken.includes('-') || /\d/.test(normToken);
  if (hasTechShape || normToken.length >= 5) {
    if (/(?:\.js|js|sql|db|ql|api)$/.test(normToken)) return true;
  }
  // Embedded special characters that practically only appear in tech tokens:
  // `+` (`c++`), `#` (`c#`, `f#`), `/` (`tcp/ip`, `ci/cd`).
  if (/[+#/]/.test(displayToken)) return true;
  // Dotted names mid-token (`node.js`, `next.js`, `vue.js`).
  if (normToken.includes('.') && /[a-z]\.[a-z]/.test(normToken)) return true;
  return false;
}

/**
 * Categorize a single term into `tech` / `soft` / `domain`.
 *
 * Order of precedence:
 *   1. Exact lowercase membership in the bundled soft-skill list.
 *   2. Exact lowercase membership in the bundled tech list.
 *   3. Heuristic acronym / suffix pattern → tech. For bigrams, classify as
 *      tech if EITHER component is a known tech term or looks tech.
 *   4. Default → domain.
 *
 * Soft is checked first because a soft phrase might also collide with
 * neighboring industry vocabulary in some future tech-list expansion; the
 * bundled vocabularies are curated so this is mostly a tie-breaker, not a
 * substantive override.
 *
 * @example
 *   classifyTerm({ term: 'kubernetes', ... })           === 'tech'
 *   classifyTerm({ term: 'incident response', ... })    === 'soft'
 *   classifyTerm({ term: 'aws lambda', ... })           === 'tech'
 *   classifyTerm({ term: 'clinical trials', ... })      === 'domain'
 */
export function classifyTerm(term: TailorTerm): TailorCategory {
  const norm = term.term;
  if (SOFT_SKILLS.has(norm)) return 'soft';
  if (TECH_TERMS.has(norm)) return 'tech';

  // Bigram: check each half separately. Tech wins on either half because
  // tech tokens are far rarer in everyday vocabulary than soft phrases,
  // so a tech hit on either side is the more informative signal.
  if (term.kind === 'bigram') {
    const parts = norm.split(' ');
    const displayParts = term.displayTerm.split(/\s+/);
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const dp = displayParts[i] ?? p;
      if (TECH_TERMS.has(p)) return 'tech';
      if (looksLikeTechToken(dp, p)) return 'tech';
    }
    // Soft phrases live in the bundled list as full bigrams (`team lead`,
    // `incident response`) — covered by the exact-match step above. No
    // half-token soft check; would be too noisy.
    return 'domain';
  }

  if (looksLikeTechToken(term.displayTerm, norm)) return 'tech';
  return 'domain';
}

/** Per-category roll-up: matched / total + the gap and match lists. */
export interface TailorCategoryStats {
  /** Number of terms in this category. */
  total: number;
  /** Number of those terms that were found in the resume. */
  matched: number;
  /** Terms NOT in the resume, in JD-frequency order. */
  gaps: TailorTerm[];
  /** Terms that DID match, in JD-frequency order. */
  matches: TailorMatch[];
}

/** Summary of matches grouped by category. Stable order: tech → soft → domain. */
export interface TailorCategorySummary {
  tech: TailorCategoryStats;
  soft: TailorCategoryStats;
  domain: TailorCategoryStats;
}

const EMPTY_STATS = (): TailorCategoryStats => ({
  total: 0,
  matched: 0,
  gaps: [],
  matches: [],
});

/**
 * Group a list of matches by category, producing per-bucket hit rates and
 * gap / match lists. Order within each bucket preserves the input order
 * (which is frequency-desc, alpha tiebreak from `extractTerms`).
 *
 * Sum invariants:
 *   tech.total + soft.total + domain.total === matches.length
 *   tech.matched + soft.matched + domain.matched
 *     === matches.filter(m => m.matched).length
 *
 * @example
 *   const terms = extractTerms(jd);
 *   const matches = matchResume(terms, resumeText);
 *   const byCat = summarizeOverlapByCategory(matches);
 *   // byCat.tech.matched / byCat.tech.total → the Tech sub-chip
 *   // byCat.tech.matches[0].term.displayTerm → first tech match
 *   // byCat.tech.gaps[0]?.displayTerm → first tech gap
 */
export function summarizeOverlapByCategory(matches: TailorMatch[]): TailorCategorySummary {
  const summary: TailorCategorySummary = {
    tech: EMPTY_STATS(),
    soft: EMPTY_STATS(),
    domain: EMPTY_STATS(),
  };
  for (const m of matches) {
    const cat = classifyTerm(m.term);
    const bucket = summary[cat];
    bucket.total += 1;
    if (m.matched) {
      bucket.matched += 1;
      bucket.matches.push(m);
    } else {
      bucket.gaps.push(m.term);
    }
  }
  return summary;
}
