/**
 * bulletPatterns — pure-function pattern library for rewriting Experience
 * bullets in the Markdown editor (#93).
 *
 * The editor uses this library to surface 2-3 candidate rewrites whenever
 * the caret lands on a bullet line inside an Experience-style section. The
 * rewrites are deliberately mechanical — they are scaffolds the writer
 * fills in, not "AI-generated" prose:
 *
 *   1. Add a metric — appends ", reducing X by Y%" so the writer is
 *      prompted to attach a measurable result to a verb/object phrase.
 *   2. Lead with outcome — rotates "{action}" into "[Result], by {action}"
 *      so the bullet leads with the impact rather than the activity.
 *   3. Verb upgrade — replaces a weak opener (Helped, Worked on,
 *      Responsible for, Assisted, Participated in) with a stronger verb
 *      suggestion drawn from a small curated list.
 *
 * Every function in this module is a pure transform on strings. No DOM,
 * no React, no global state — the editor calls in, gets candidates back,
 * and is responsible for inserting them as new sibling bullets.
 *
 * Detection of "this bullet sits inside an Experience H2" is also done
 * here (`isUnderExperienceHeading`) because the rule is small, stable,
 * and benefits from being unit-testable in isolation from the editor.
 */

/* ------------------------------------------------------------------ */
/* Bullet shape                                                        */
/* ------------------------------------------------------------------ */

/**
 * A parsed Markdown bullet line. `indent` is the literal leading
 * whitespace (so nested bullets round-trip), `marker` is "- " or "* ",
 * and `text` is the bullet body with any trailing newline stripped.
 */
export interface ParsedBullet {
  indent: string;
  marker: '- ' | '* ';
  text: string;
}

/**
 * Parse a single line as a Markdown bullet, or return `null` if the line
 * is not a top-level or nested bullet of the form `- foo` / `* foo`. We
 * deliberately accept any leading whitespace so nested list items qualify,
 * and we trim the bullet text on the right so a trailing space doesn't
 * leak into rewrites.
 */
export function parseBullet(line: string): ParsedBullet | null {
  const match = /^([ \t]*)([-*])\s+(.*)$/.exec(line);
  if (!match) return null;
  const [, indent, bullet, rest] = match;
  return {
    indent,
    marker: bullet === '-' ? '- ' : '* ',
    text: rest.replace(/\s+$/u, ''),
  };
}

/**
 * Re-assemble a `ParsedBullet` back into its source-line form. Pairs with
 * `parseBullet` so callers can edit the text and serialize.
 */
export function formatBullet(bullet: ParsedBullet): string {
  return `${bullet.indent}${bullet.marker}${bullet.text}`;
}

/* ------------------------------------------------------------------ */
/* Section detection                                                   */
/* ------------------------------------------------------------------ */

/**
 * The H2 section names we treat as "Experience-style". The rewrites only
 * make sense for sections that read as accomplishment lists — Summary
 * bullets are short prose, Skills bullets are noun phrases. Keep the list
 * conservative and case-insensitive.
 */
const EXPERIENCE_HEADINGS = [
  'experience',
  'work experience',
  'professional experience',
  'relevant experience',
  'work history',
  'career history',
  'professional background',
  'employment',
  'employment history',
  'selected impact',
  'impact',
  'projects',
  'selected projects',
];

/**
 * True iff `lines[lineIndex]` sits beneath the nearest preceding H2 whose
 * title (lower-cased, trimmed) matches one of the experience-style names
 * above. Walks backward from the given line — the first H2 we hit decides
 * the section, so a `## Skills` later in the file doesn't affect a bullet
 * that lives under `## Experience`. H3s and lower never qualify; the
 * question is which H2 section the bullet is in.
 */
export function isUnderExperienceHeading(lines: string[], lineIndex: number): boolean {
  for (let i = Math.min(lineIndex, lines.length - 1); i >= 0; i--) {
    const line = lines[i];
    // Match "## Heading" but not "### Heading" — H2 only.
    const h2 = /^##\s+(?!#)(.+?)\s*$/.exec(line);
    if (h2) {
      const title = h2[1].toLowerCase().trim();
      return EXPERIENCE_HEADINGS.includes(title);
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Pattern 1: Add a metric                                             */
/* ------------------------------------------------------------------ */

/**
 * Append a metric-placeholder clause to a bullet. We strip any trailing
 * period before adding the clause and reinstate one at the end so the
 * resulting sentence reads cleanly. If the bullet already ends with a
 * percentage or a clear metric phrase ("by 30%", "reducing X by Y%",
 * "X%"), we skip — there's nothing to add.
 */
export function addMetric(text: string): string | null {
  const trimmed = text.replace(/\s+$/u, '');
  if (trimmed.length === 0) return null;
  // Skip if the bullet already carries an obvious numeric metric.
  if (/\b\d+(\.\d+)?\s*%/u.test(trimmed)) return null;
  if (/\breducing\b[^.]*\bby\b/iu.test(trimmed)) return null;

  // Drop a trailing terminator before splicing in the clause; restore "." after.
  const body = trimmed.replace(/[.!?,;]+$/u, '');
  return `${body}, reducing X by Y%.`;
}

/* ------------------------------------------------------------------ */
/* Pattern 2: Lead with outcome                                        */
/* ------------------------------------------------------------------ */

/**
 * Rotate a bullet so the outcome lands first: `Action, increasing X` →
 * `Increased X, by action`. Heuristic: we look for a bullet shaped like
 * "{action clause}, {result clause}" where the result clause opens with
 * a participle like "reducing", "increasing", "saving", "cutting",
 * "delivering", etc. — these are exactly the bullets where the writer
 * already knows the outcome and is burying it.
 *
 * When the heuristic doesn't match (no comma-result clause), we fall
 * back to a generic scaffold: `[Result], by {original bullet}` — still
 * mechanical, still safe, still useful as a prompt the writer fills in.
 */
const RESULT_PARTICIPLES: Record<string, string> = {
  reducing: 'Reduced',
  cutting: 'Cut',
  decreasing: 'Decreased',
  lowering: 'Lowered',
  increasing: 'Increased',
  growing: 'Grew',
  doubling: 'Doubled',
  tripling: 'Tripled',
  saving: 'Saved',
  improving: 'Improved',
  delivering: 'Delivered',
  shipping: 'Shipped',
  accelerating: 'Accelerated',
  unlocking: 'Unlocked',
  eliminating: 'Eliminated',
  enabling: 'Enabled',
  driving: 'Drove',
};

export function leadWithOutcome(text: string): string | null {
  const trimmed = text.replace(/\s+$/u, '').replace(/[.!?]+$/u, '');
  if (trimmed.length === 0) return null;

  // Look for "..., <participle> <rest>" at the end of the bullet.
  const commaSplit =
    /^(.+?),\s+(reducing|cutting|decreasing|lowering|increasing|growing|doubling|tripling|saving|improving|delivering|shipping|accelerating|unlocking|eliminating|enabling|driving)\s+(.+)$/iu.exec(
      trimmed,
    );
  if (commaSplit) {
    const [, actionRaw, participleRaw, restRaw] = commaSplit;
    const participle = participleRaw.toLowerCase();
    const verb = RESULT_PARTICIPLES[participle] ?? capitalize(participle);
    const action = lowercaseFirst(actionRaw.trim());
    const rest = restRaw.trim();
    return `${verb} ${rest}, by ${action}.`;
  }

  // Generic fallback scaffold — leaves "[Result]" for the writer to fill.
  const action = lowercaseFirst(trimmed);
  return `[Result], by ${action}.`;
}

/* ------------------------------------------------------------------ */
/* Pattern 3: Verb upgrade                                             */
/* ------------------------------------------------------------------ */

/**
 * Map of weak verb openers → a curated set of stronger replacements. The
 * replacements are picked because they are unambiguously ownership verbs
 * (Led, Built, Shipped) rather than vague intensifiers (Spearheaded,
 * Leveraged). One replacement is offered per call — keeping the affordance
 * a small inline tray of 2-3 entries.
 */
const WEAK_VERBS: { pattern: RegExp; replacement: string; original: string }[] = [
  // "Helped lead X" before bare "Helped" so it doesn't become "Led lead X".
  { original: 'Helped lead', pattern: /^Helped lead\b/u, replacement: 'Led' },
  // "Helped with X" before bare "Helped" so it doesn't become "Led with X".
  { original: 'Helped with', pattern: /^Helped with\b/u, replacement: 'Led' },
  // "Helped to X" before bare "Helped" too, so it doesn't become "Led to X".
  { original: 'Helped to', pattern: /^Helped to\b/u, replacement: 'Led' },
  // "Helped in X" before bare "Helped" so it doesn't become "Led in X".
  { original: 'Helped in', pattern: /^Helped in\b/u, replacement: 'Led' },
  // "Helped out with X" / "Helped out X" before bare "Helped" so neither
  // collapses into "Led out ...".
  { original: 'Helped out with', pattern: /^Helped out with\b/u, replacement: 'Led' },
  { original: 'Helped out', pattern: /^Helped out\b/u, replacement: 'Led' },
  // "Helped build/develop/create/design/manage/implement X" keep the object verb
  // instead of collapsing into bare "Helped" -> "Led build X", which reads wrong.
  { original: 'Helped build', pattern: /^Helped build\b/u, replacement: 'Built' },
  { original: 'Helped develop', pattern: /^Helped develop\b/u, replacement: 'Developed' },
  { original: 'Helped create', pattern: /^Helped create\b/u, replacement: 'Created' },
  { original: 'Helped design', pattern: /^Helped design\b/u, replacement: 'Designed' },
  { original: 'Helped manage', pattern: /^Helped manage\b/u, replacement: 'Managed' },
  { original: 'Helped implement', pattern: /^Helped implement\b/u, replacement: 'Implemented' },
  // same shape — keep the object verb instead of "Led launch X" / "Led ship X" etc.
  { original: 'Helped launch', pattern: /^Helped launch\b/u, replacement: 'Launched' },
  { original: 'Helped maintain', pattern: /^Helped maintain\b/u, replacement: 'Maintained' },
  { original: 'Helped deliver', pattern: /^Helped deliver\b/u, replacement: 'Delivered' },
  { original: 'Helped ship', pattern: /^Helped ship\b/u, replacement: 'Shipped' },
  { original: 'Helped run', pattern: /^Helped run\b/u, replacement: 'Ran' },
  { original: 'Helped test', pattern: /^Helped test\b/u, replacement: 'Tested' },
  { original: 'Helped grow', pattern: /^Helped grow\b/u, replacement: 'Grew' },
  { original: 'Helped drive', pattern: /^Helped drive\b/u, replacement: 'Drove' },
  { original: 'Helped improve', pattern: /^Helped improve\b/u, replacement: 'Improved' },
  { original: 'Helped coordinate', pattern: /^Helped coordinate\b/u, replacement: 'Coordinated' },
  { original: 'Helped organize', pattern: /^Helped organize\b/u, replacement: 'Organized' },
  { original: 'Helped oversee', pattern: /^Helped oversee\b/u, replacement: 'Oversaw' },
  { original: 'Helped ensure', pattern: /^Helped ensure\b/u, replacement: 'Ensured' },
  { original: 'Helped train', pattern: /^Helped train\b/u, replacement: 'Trained' },
  // more object verbs that read wrong as "Led scale X" / "Led reduce X" if they
  // collapsed into bare "Helped"; keep the object verb in past tense instead.
  { original: 'Helped scale', pattern: /^Helped scale\b/u, replacement: 'Scaled' },
  { original: 'Helped reduce', pattern: /^Helped reduce\b/u, replacement: 'Reduced' },
  { original: 'Helped increase', pattern: /^Helped increase\b/u, replacement: 'Increased' },
  { original: 'Helped automate', pattern: /^Helped automate\b/u, replacement: 'Automated' },
  { original: 'Helped migrate', pattern: /^Helped migrate\b/u, replacement: 'Migrated' },
  { original: 'Helped optimize', pattern: /^Helped optimize\b/u, replacement: 'Optimized' },
  // engineering object verbs in the same family; "Led deploy X" / "Led debug X"
  // read wrong, so keep the object verb in past tense instead of bare "Helped".
  { original: 'Helped deploy', pattern: /^Helped deploy\b/u, replacement: 'Deployed' },
  { original: 'Helped integrate', pattern: /^Helped integrate\b/u, replacement: 'Integrated' },
  { original: 'Helped refactor', pattern: /^Helped refactor\b/u, replacement: 'Refactored' },
  { original: 'Helped debug', pattern: /^Helped debug\b/u, replacement: 'Debugged' },
  { original: 'Helped configure', pattern: /^Helped configure\b/u, replacement: 'Configured' },
  { original: 'Helped review', pattern: /^Helped review\b/u, replacement: 'Reviewed' },
  // "Helped onboard X" before bare "Helped" so it doesn't become "Led onboard X".
  { original: 'Helped onboard', pattern: /^Helped onboard\b/u, replacement: 'Onboarded' },
  // "Helped support X" double-hedges; keep it ahead of bare "Helped" and "Supported".
  { original: 'Helped support', pattern: /^Helped support\b/u, replacement: 'Drove' },
  // "Helped X" → "Led X" (the most common case in early-career bullets).
  { original: 'Helped', pattern: /^Helped\b/u, replacement: 'Led' },
  // "Worked on X" → "Built X" — strips the activity-phrasing and ascribes ownership.
  { original: 'Worked on', pattern: /^Worked on\b/u, replacement: 'Built' },
  // "Worked closely with" / "Worked alongside" read as presence; neither matches
  // bare "Worked with" below, but keep them grouped with the other Worked openers.
  {
    original: 'Worked closely with',
    pattern: /^Worked closely with\b/u,
    replacement: 'Partnered with',
  },
  { original: 'Worked alongside', pattern: /^Worked alongside\b/u, replacement: 'Partnered with' },
  // "Responsible for X" → "Owned X" — collapses a noun-phrase opener to a verb.
  { original: 'Responsible for', pattern: /^Responsible for\b/u, replacement: 'Owned' },
  // job-description leftovers that list duties instead of claiming them.
  { original: 'Duties included', pattern: /^Duties included\b/u, replacement: 'Owned' },
  {
    original: 'Responsibilities included',
    pattern: /^Responsibilities included\b/u,
    replacement: 'Owned',
  },
  { original: 'Assisted with', pattern: /^Assisted with\b/u, replacement: 'Drove' },
  { original: 'Assisted in', pattern: /^Assisted in\b/u, replacement: 'Drove' },
  { original: 'Assisted', pattern: /^Assisted\b/u, replacement: 'Drove' },
  { original: 'Participated in', pattern: /^Participated in\b/u, replacement: 'Led' },
  { original: 'Contributed to', pattern: /^Contributed to\b/u, replacement: 'Shipped' },
  // "Assigned to X" / "Brought on to X" describe being placed on work, not owning it.
  { original: 'Assigned to', pattern: /^Assigned to\b/u, replacement: 'Owned' },
  { original: 'Brought on to', pattern: /^Brought on to\b/u, replacement: 'Led' },
  { original: 'Tasked with', pattern: /^Tasked with\b/u, replacement: 'Owned' },
  { original: 'Tasked to', pattern: /^Tasked to\b/u, replacement: 'Owned' },
  // "Was tasked with X" is the past-tense twin of "Tasked with".
  { original: 'Was tasked with', pattern: /^Was tasked with\b/u, replacement: 'Owned' },
  { original: 'Involved in', pattern: /^Involved in\b/u, replacement: 'Led' },
  // "Was involved in X" is the past-tense twin of "Involved in".
  { original: 'Was involved in', pattern: /^Was involved in\b/u, replacement: 'Led' },
  // "Played a key role in X" before bare "Played a role in" can't shadow it
  // (the "key" stops that match), but keep the more specific phrasing first.
  { original: 'Played a key role in', pattern: /^Played a key role in\b/u, replacement: 'Led' },
  { original: 'Played a role in', pattern: /^Played a role in\b/u, replacement: 'Led' },
  { original: 'Was part of', pattern: /^Was part of\b/u, replacement: 'Led' },
  { original: 'Collaborated on', pattern: /^Collaborated on\b/u, replacement: 'Built' },
  { original: 'Engaged in', pattern: /^Engaged in\b/u, replacement: 'Led' },
  { original: 'Took part in', pattern: /^Took part in\b/u, replacement: 'Led' },
  // "Pitched in on X" before bare "Pitched in" so it doesn't become "Drove on X".
  { original: 'Pitched in on', pattern: /^Pitched in on\b/u, replacement: 'Drove' },
  { original: 'Pitched in', pattern: /^Pitched in\b/u, replacement: 'Drove' },
  { original: 'Chipped in', pattern: /^Chipped in\b/u, replacement: 'Drove' },
  { original: 'Stepped in to', pattern: /^Stepped in to\b/u, replacement: 'Led' },
  { original: 'Aided', pattern: /^Aided\b/u, replacement: 'Drove' },
  // "Worked with X" reads as presence, not ownership — distinct from "Worked on".
  { original: 'Worked with', pattern: /^Worked with\b/u, replacement: 'Partnered with' },
  { original: 'Supported', pattern: /^Supported\b/u, replacement: 'Drove' },
  { original: 'Handled', pattern: /^Handled\b/u, replacement: 'Owned' },
  // "Was responsible for X" is the past-tense twin of "Responsible for".
  { original: 'Was responsible for', pattern: /^Was responsible for\b/u, replacement: 'Owned' },
  { original: 'Facilitated', pattern: /^Facilitated\b/u, replacement: 'Led' },
  // "Provided support for X" before bare "Provided" so it doesn't become "Delivered support for X".
  { original: 'Provided support for', pattern: /^Provided support for\b/u, replacement: 'Drove' },
  { original: 'Provided', pattern: /^Provided\b/u, replacement: 'Delivered' },
  { original: 'Performed', pattern: /^Performed\b/u, replacement: 'Ran' },
];

/**
 * Inspect the first verb of a bullet. If it matches a known weak opener,
 * return the upgraded line and the labels for both the original and the
 * replacement so the UI can describe the change. Returns `null` when the
 * bullet doesn't open with a tracked weak verb.
 */
export interface VerbUpgrade {
  /** The bullet text with the weak opener replaced. */
  upgraded: string;
  /** The matched weak opener, e.g. "Helped". */
  original: string;
  /** The stronger replacement, e.g. "Led". */
  replacement: string;
}

export function upgradeVerb(text: string): VerbUpgrade | null {
  const trimmed = text.replace(/^\s+/u, '');
  if (trimmed.length === 0) return null;
  for (const entry of WEAK_VERBS) {
    if (entry.pattern.test(trimmed)) {
      const upgraded = trimmed.replace(entry.pattern, entry.replacement);
      return {
        upgraded,
        original: entry.original,
        replacement: entry.replacement,
      };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Public: getRewriteCandidates                                        */
/* ------------------------------------------------------------------ */

/**
 * A rewrite candidate surfaced to the UI tray. `id` is stable across
 * calls so the renderer can use it as the React `key`; `label` and
 * `description` are short, human strings; `rewrittenLine` is the
 * full source-line shape to insert verbatim above the original.
 */
export interface RewriteCandidate {
  id: 'add-metric' | 'lead-with-outcome' | 'verb-upgrade';
  label: string;
  description: string;
  rewrittenLine: string;
}

/**
 * Given a single source line, return 0-3 rewrite candidates. The line must
 * parse as a bullet; otherwise an empty array is returned. The candidate
 * order is stable — Add metric, Lead with outcome, Verb upgrade — so the
 * tray UI is predictable. Each `rewrittenLine` preserves the original
 * bullet's indentation and marker so it can be inserted as a sibling
 * bullet without disturbing the surrounding list structure.
 */
export function getRewriteCandidates(line: string): RewriteCandidate[] {
  const parsed = parseBullet(line);
  if (!parsed) return [];

  const candidates: RewriteCandidate[] = [];

  // Pattern 1 — add a metric placeholder.
  const metric = addMetric(parsed.text);
  if (metric) {
    candidates.push({
      id: 'add-metric',
      label: 'Add a metric',
      description: 'Append a placeholder you can fill in with a measurable result.',
      rewrittenLine: formatBullet({ ...parsed, text: metric }),
    });
  }

  // Pattern 2 — rotate to lead with the outcome.
  const outcome = leadWithOutcome(parsed.text);
  if (outcome && outcome !== parsed.text) {
    candidates.push({
      id: 'lead-with-outcome',
      label: 'Lead with outcome',
      description: 'Rotate the sentence so the result comes first.',
      rewrittenLine: formatBullet({ ...parsed, text: outcome }),
    });
  }

  // Pattern 3 — verb upgrade (only when the bullet opens with a weak verb).
  const upgrade = upgradeVerb(parsed.text);
  if (upgrade) {
    candidates.push({
      id: 'verb-upgrade',
      label: `Verb upgrade: ${upgrade.original} → ${upgrade.replacement}`,
      description: `Replace "${upgrade.original}" with the stronger "${upgrade.replacement}".`,
      rewrittenLine: formatBullet({ ...parsed, text: upgrade.upgraded }),
    });
  }

  return candidates;
}

/* ------------------------------------------------------------------ */
/* Small string helpers                                                */
/* ------------------------------------------------------------------ */

function capitalize(s: string): string {
  if (s.length === 0) return s;
  return s[0].toUpperCase() + s.slice(1);
}

function lowercaseFirst(s: string): string {
  if (s.length === 0) return s;
  // Don't lowercase ALL-CAPS acronyms (e.g. "API integration"); only the
  // first character when it's the start of a normal sentence.
  if (s.length > 1 && s[0] === s[0].toUpperCase() && s[1] === s[1].toUpperCase()) {
    return s;
  }
  return s[0].toLowerCase() + s.slice(1);
}
