/**
 * jsonresume.ts — bridge between Works on My Resume's Markdown format and the
 * JSON Resume schema (https://jsonresume.org/schema/).
 *
 * Two directions, two contracts:
 *
 *   toJsonResume(parsed, markdown) — lossless-enough export
 *     ----------------------------------------------------------------
 *     Reads the YAML frontmatter we already produce (`name`, `role`,
 *     `location`, `email`, `phone`, `links`) and the rendered HTML structure
 *     to fill in the JSON Resume `basics` block, then walks the Markdown body
 *     to extract Experience / Education / Skills / Summary into the relevant
 *     schema arrays. The full Markdown body is ALSO preserved verbatim under
 *     `meta.womr.markdownBody`, so a third-party tool can stash a copy that
 *     `fromJsonResume` can later restore byte-for-byte.
 *
 *   fromJsonResume(json) — defensive import from untrusted user files
 *     ----------------------------------------------------------------
 *     Validates the input is an object, then reads only the fields it
 *     recognizes. Never throws — every shape problem becomes a warning. Two
 *     fast paths:
 *       1. If `meta.womr.markdownBody` is present, restore it directly. This
 *          is the round-trip path for a document we exported earlier.
 *       2. Otherwise, synthesize Markdown from `basics` + `work` + `education`
 *          + `skills` + `basics.summary`. The output is recognizably the
 *          same resume; it will not byte-match the original.
 *
 *  This module is pure data manipulation — no DOM, no network, no I/O. The
 *  download helper at the bottom is the one browser-touching function and
 *  guards `document`/`window` access defensively.
 */

import type {
  JsonResume,
  JsonResumeBasics,
  JsonResumeEducation,
  JsonResumeLocation,
  JsonResumeProfile,
  JsonResumeSkill,
  JsonResumeWork,
  ParsedResume,
  ResumeLink,
} from '../types';

/* ------------------------------------------------------------------ */
/* Small shared utilities                                              */
/* ------------------------------------------------------------------ */

/** Trim and return a non-empty string, or `undefined`. Forgiving of types. */
function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
}

// An ongoing role writes "Present" (or a synonym) as its end. JSON Resume has
// no such value: a current entry just omits endDate, so drop the marker here
// instead of emitting endDate: "Present", which fails schema validation and
// trips consumers that parse the field as a date.
function normalizeEndDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return /^(present|current|now|ongoing|to date|to present)$/i.test(value.trim())
    ? undefined
    : value;
}

/** A pragmatic plain-object check that excludes arrays and null. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Filename-safe slug (lowercase, [a-z0-9-]) with a sensible fallback. */
function slugify(input: string | undefined): string {
  if (!input) return 'resume';
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'resume';
}

/**
 * Pull every plain-text fragment out of a Markdown line so we can match
 * heading text without choking on bold/italic/links. We deliberately do NOT
 * run the body through `marked` here — this module is the export side and
 * works on the raw source, where headings are unambiguous.
 */
function stripInlineMarkdown(source: string): string {
  return source
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // image
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // link → text
    .replace(/[*_`~]+/g, '') // emphasis/code
    .trim();
}

/* ------------------------------------------------------------------ */
/* Markdown → JSON Resume                                              */
/* ------------------------------------------------------------------ */

/**
 * Map a `ResumeLink` to a JSON Resume profile. We use `label` as the
 * network name; if it matches a known social network (case-insensitively)
 * we keep that capitalization. Anything else is passed through as written.
 */
function linkToProfile(link: ResumeLink): JsonResumeProfile {
  return {
    network: link.label,
    url: link.url,
  };
}

/**
 * Decompose a "City, Region" location string into JSON Resume location
 * fields. Heuristic: split on the first comma. We never invent a country
 * code; if the input has none, none is set.
 */
function splitLocation(value: string | undefined): JsonResumeLocation | undefined {
  if (!value) return undefined;
  const parts = value
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return undefined;
  const [city, region, countryCode] = parts;
  const out: JsonResumeLocation = {};
  if (city) out.city = city;
  if (region) out.region = region;
  if (countryCode) out.countryCode = countryCode;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Find the index of the first line that looks like an H2 with `name` as its
 * text. Case-insensitive, tolerant of leading/trailing whitespace and inline
 * Markdown decoration. Returns `-1` if the section is absent.
 */
function findH2(lines: string[], name: string): number {
  const target = name.toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('## ')) continue;
    if (stripInlineMarkdown(line.slice(3)).toLowerCase() === target) return i;
  }
  return -1;
}

/**
 * Return the half-open range `[start, end)` of lines that belong to the
 * section beginning at `lines[startIndex]` — i.e. everything until the next
 * H2 (or EOF). `startIndex` points AT the H2 line; the returned start is
 * one past it.
 */
function sectionRange(lines: string[], startIndex: number): { start: number; end: number } {
  if (startIndex < 0) return { start: 0, end: 0 };
  const start = startIndex + 1;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/** Coalesce blank-line-separated paragraphs from `lines[start..end)`. */
function joinParagraphs(lines: string[], start: number, end: number): string {
  return lines
    .slice(start, end)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Parse `### Position — Company\n_Dates · Location_\n- bullet\n- bullet`
 * blocks under an H2. Returns one entry per H3.
 */
function parseExperienceSection(lines: string[], start: number, end: number): JsonResumeWork[] {
  const work: JsonResumeWork[] = [];

  // Each H3 starts a new entry; everything before the next H3 (or end) is
  // its body. The first non-bullet, non-blank line is the date/location
  // italic line; remaining lines are summary paragraphs and `-` bullets.
  let cursor = start;
  while (cursor < end) {
    const line = lines[cursor];
    if (!line.startsWith('### ')) {
      cursor++;
      continue;
    }
    const heading = stripInlineMarkdown(line.slice(4));
    // Find the next H3 or the section end.
    let entryEnd = end;
    for (let j = cursor + 1; j < end; j++) {
      if (lines[j].startsWith('### ')) {
        entryEnd = j;
        break;
      }
    }

    // Heading: "Position — Company" / "Position - Company" / just "Title".
    let position: string | undefined;
    let company: string | undefined;
    const dashSplit = heading.split(/\s+[—–-]\s+/);
    if (dashSplit.length >= 2) {
      position = dashSplit[0].trim();
      company = dashSplit.slice(1).join(' — ').trim();
    } else {
      position = heading;
    }

    // Walk the entry body to find the meta line and collect bullets.
    let startDate: string | undefined;
    let endDate: string | undefined;
    let location: string | undefined;
    const highlights: string[] = [];
    const summaryLines: string[] = [];

    for (let j = cursor + 1; j < entryEnd; j++) {
      const raw = lines[j];
      const trimmed = raw.trim();
      if (trimmed.length === 0) continue;

      // Italicized meta line: `_Mar 2021 – Present · Portland, OR_`
      const italicMatch = /^_(.+)_$/.exec(trimmed);
      if (italicMatch && startDate === undefined) {
        const meta = italicMatch[1];
        // Split on the centered-dot bullet first, then on the date range dash.
        const segments = meta.split(/\s·\s|\s\|\s/).map((s) => s.trim());
        const dateSeg = segments.shift();
        if (dateSeg) {
          // En/em dash anywhere, but a plain hyphen only when spaced, so ISO
          // dates like 2021-03-01 are not torn apart at their own hyphens.
          const dateParts = dateSeg.split(/\s*[–—]\s*|\s+-\s+/);
          if (dateParts[0]) startDate = dateParts[0].trim();
          if (dateParts[1]) endDate = normalizeEndDate(dateParts[1].trim());
        }
        if (segments.length > 0) {
          location = segments.join(' · ');
        }
        continue;
      }

      if (/^[-*+]\s+/.test(trimmed)) {
        highlights.push(stripInlineMarkdown(trimmed.replace(/^[-*+]\s+/, '')));
      } else {
        summaryLines.push(raw);
      }
    }

    const entry: JsonResumeWork = {};
    if (position) entry.position = position;
    if (company) entry.name = company;
    if (startDate) entry.startDate = startDate;
    if (endDate) entry.endDate = endDate;
    if (location) entry.location = location;
    if (highlights.length > 0) entry.highlights = highlights;
    const summary = summaryLines.join('\n').trim();
    if (summary) entry.summary = summary;
    work.push(entry);

    cursor = entryEnd;
  }

  return work;
}

/**
 * Parse `### Degree — Institution\n_Dates · Location_\n- bullet` blocks.
 * Same shape as experience but mapped to `JsonResumeEducation`.
 */
function parseEducationSection(lines: string[], start: number, end: number): JsonResumeEducation[] {
  const education: JsonResumeEducation[] = [];

  let cursor = start;
  while (cursor < end) {
    const line = lines[cursor];
    if (!line.startsWith('### ')) {
      cursor++;
      continue;
    }
    const heading = stripInlineMarkdown(line.slice(4));
    let entryEnd = end;
    for (let j = cursor + 1; j < end; j++) {
      if (lines[j].startsWith('### ')) {
        entryEnd = j;
        break;
      }
    }

    // "Degree — Institution" / "Institution" only.
    const dashSplit = heading.split(/\s+[—–-]\s+/);
    let studyType: string | undefined;
    let institution: string | undefined;
    if (dashSplit.length >= 2) {
      studyType = dashSplit[0].trim();
      institution = dashSplit.slice(1).join(' — ').trim();
    } else {
      institution = heading;
    }

    let startDate: string | undefined;
    let endDate: string | undefined;
    const courses: string[] = [];

    for (let j = cursor + 1; j < entryEnd; j++) {
      const trimmed = lines[j].trim();
      if (trimmed.length === 0) continue;
      const italicMatch = /^_(.+)_$/.exec(trimmed);
      if (italicMatch && startDate === undefined) {
        const meta = italicMatch[1].split(/\s·\s|\s\|\s/)[0]?.trim() ?? '';
        const dateParts = meta.split(/\s*[–—]\s*|\s+-\s+/);
        if (dateParts[0]) startDate = dateParts[0].trim();
        if (dateParts[1]) endDate = normalizeEndDate(dateParts[1].trim());
        continue;
      }
      if (/^[-*+]\s+/.test(trimmed)) {
        courses.push(stripInlineMarkdown(trimmed.replace(/^[-*+]\s+/, '')));
      }
    }

    const entry: JsonResumeEducation = {};
    if (institution) entry.institution = institution;
    if (studyType) entry.studyType = studyType;
    if (startDate) entry.startDate = startDate;
    if (endDate) entry.endDate = endDate;
    if (courses.length > 0) entry.courses = courses;
    education.push(entry);

    cursor = entryEnd;
  }

  return education;
}

/**
 * Parse a Skills section. We support two shapes:
 *   - A pipe-table with at least two columns; column 1 is the skill `name`
 *     and column 2 (whitespace-split) becomes `keywords`. A "Depth" column
 *     becomes `level`.
 *   - A plain bullet list, where each bullet is one skill (no keywords).
 */
function parseSkillsSection(lines: string[], start: number, end: number): JsonResumeSkill[] {
  const skills: JsonResumeSkill[] = [];

  // Detect the table block, if any.
  const tableStart = lines.findIndex((line, i) => i >= start && i < end && /^\s*\|.*\|/.test(line));

  if (tableStart >= 0 && tableStart < end) {
    // Walk until the table ends (blank line or non-pipe line).
    const rows: string[][] = [];
    for (let i = tableStart; i < end; i++) {
      const raw = lines[i];
      if (!/^\s*\|.*\|/.test(raw)) break;
      // Drop leading/trailing pipes, then split.
      const cells = raw
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => c.trim());
      rows.push(cells);
    }

    if (rows.length >= 2) {
      const header = rows[0].map((h) => h.toLowerCase());
      const isSeparator = (row: string[]) => row.every((c) => /^:?-+:?$/.test(c));
      // Detect and skip the alignment row.
      const dataRows = rows.slice(1).filter((r) => !isSeparator(r));

      const toolsIdx = header.findIndex((h) => /tool/i.test(h) || /keyword/i.test(h));
      const depthIdx = header.findIndex((h) => /depth|level/i.test(h));

      for (const row of dataRows) {
        const name = row[0] ? stripInlineMarkdown(row[0]) : undefined;
        if (!name) continue;
        const skill: JsonResumeSkill = { name };
        if (toolsIdx > 0 && row[toolsIdx]) {
          // Split on commas; secondary fallback to "/" and "|".
          const keywords = stripInlineMarkdown(row[toolsIdx])
            .split(/[,/]/)
            .map((k) => k.trim())
            .filter(Boolean);
          if (keywords.length > 0) skill.keywords = keywords;
        }
        if (depthIdx > 0 && row[depthIdx]) {
          const level = stripInlineMarkdown(row[depthIdx]);
          if (level) skill.level = level;
        }
        skills.push(skill);
      }
    }
  }

  // Bullet fallback (and supplements after the table) — pick up `- Skill` lines.
  // A `- Category: a, b, c` bullet splits into a named skill with keywords,
  // mirroring how skillsToMarkdown renders the Area/Tools columns.
  if (skills.length === 0) {
    for (let i = start; i < end; i++) {
      const trimmed = lines[i].trim();
      if (/^[-*+]\s+/.test(trimmed)) {
        const text = stripInlineMarkdown(trimmed.replace(/^[-*+]\s+/, ''));
        if (!text) continue;
        const colon = text.indexOf(':');
        if (colon > 0 && colon < text.length - 1) {
          const name = text.slice(0, colon).trim();
          if (!name) continue;
          const keywords = text
            .slice(colon + 1)
            .split(',')
            .map((k) => k.trim())
            .filter(Boolean);
          const skill: JsonResumeSkill = { name };
          if (keywords.length > 0) skill.keywords = keywords;
          skills.push(skill);
        } else {
          skills.push({ name: text });
        }
      }
    }
  }

  return skills;
}

/** Find an H2 named "Summary" / "About" / "Profile" and return its body. */
function findSummaryText(lines: string[]): string | undefined {
  for (const heading of ['Summary', 'About', 'Profile']) {
    const idx = findH2(lines, heading);
    if (idx >= 0) {
      const { start, end } = sectionRange(lines, idx);
      const text = joinParagraphs(lines, start, end);
      if (text) return text;
    }
  }
  return undefined;
}

/**
 * Convert a `ParsedResume` (the Markdown-side model) into a JSON Resume
 * document. The full Markdown body is preserved on `meta.womr.markdownBody`
 * so an exported JSON Resume can later round-trip back without loss.
 */
export function toJsonResume(parsed: ParsedResume, markdown: string): JsonResume {
  const frontmatter = parsed.frontmatter;
  const lines = parsed.body.split('\n');

  /* ----- basics ----- */
  const basics: JsonResumeBasics = {};
  if (frontmatter.name) basics.name = frontmatter.name;
  if (frontmatter.role) basics.label = frontmatter.role;
  if (frontmatter.email) basics.email = frontmatter.email;
  if (frontmatter.phone) basics.phone = frontmatter.phone;
  const location = splitLocation(frontmatter.location);
  if (location) basics.location = location;
  const profiles = (frontmatter.links ?? []).map(linkToProfile);
  if (profiles.length > 0) basics.profiles = profiles;
  const summary = findSummaryText(lines);
  if (summary) basics.summary = summary;

  /* ----- work / education / skills ----- */
  const workIdx = findH2(lines, 'Experience');
  let work: JsonResumeWork[] = [];
  if (workIdx >= 0) {
    const { start, end } = sectionRange(lines, workIdx);
    work = parseExperienceSection(lines, start, end);
  }

  const eduIdx = findH2(lines, 'Education');
  let education: JsonResumeEducation[] = [];
  if (eduIdx >= 0) {
    const { start, end } = sectionRange(lines, eduIdx);
    education = parseEducationSection(lines, start, end);
  }

  const skillsIdx = findH2(lines, 'Skills');
  let skills: JsonResumeSkill[] = [];
  if (skillsIdx >= 0) {
    const { start, end } = sectionRange(lines, skillsIdx);
    skills = parseSkillsSection(lines, start, end);
  }

  /* ----- assemble ----- */
  const out: JsonResume = {
    $schema: 'https://raw.githubusercontent.com/jsonresume/resume-schema/v1.0.0/schema.json',
  };
  if (Object.keys(basics).length > 0) out.basics = basics;
  if (work.length > 0) out.work = work;
  if (education.length > 0) out.education = education;
  if (skills.length > 0) out.skills = skills;

  // Preserve the original Markdown verbatim for a lossless round-trip.
  out.meta = {
    version: 'v1.0.0',
    lastModified: new Date().toISOString(),
    womr: {
      markdownBody: markdown,
    },
  };

  return out;
}

/* ------------------------------------------------------------------ */
/* JSON Resume → Markdown                                              */
/* ------------------------------------------------------------------ */

/** Escape `:` so it never accidentally becomes a YAML mapping. */
function yamlString(value: string): string {
  // Quote any value containing characters that would confuse YAML, or a leading/trailing space.
  if (/[:#&*?{}[\],!|>%@`"]/.test(value) || /^\s|\s$/.test(value) || value.includes('\n')) {
    return JSON.stringify(value);
  }
  return value;
}

/** Build YAML frontmatter from the JSON Resume `basics` block. */
function basicsToFrontmatter(basics: JsonResumeBasics, warnings: string[]): string {
  const lines: string[] = ['---'];

  if (basics.name) lines.push(`name: ${yamlString(basics.name)}`);
  if (basics.label) lines.push(`role: ${yamlString(basics.label)}`);

  // Re-assemble a "City, Region" location string from the structured value.
  if (basics.location && isPlainObject(basics.location)) {
    const loc = basics.location;
    const parts = [loc.city, loc.region, loc.countryCode]
      .map(asNonEmptyString)
      .filter((p): p is string => p !== undefined);
    if (parts.length > 0) lines.push(`location: ${yamlString(parts.join(', '))}`);
  }

  if (basics.email) lines.push(`email: ${yamlString(basics.email)}`);
  if (basics.phone) lines.push(`phone: ${yamlString(basics.phone)}`);

  if (Array.isArray(basics.profiles) && basics.profiles.length > 0) {
    const goodProfiles = basics.profiles.filter(
      (p): p is JsonResumeProfile =>
        isPlainObject(p) && (p.network !== undefined || p.url !== undefined),
    );
    if (goodProfiles.length > 0) {
      lines.push('links:');
      for (const p of goodProfiles) {
        const label = asNonEmptyString(p.network) ?? asNonEmptyString(p.username);
        const url = asNonEmptyString(p.url);
        if (!label || !url) {
          warnings.push('A JSON Resume profile was missing network/url and was skipped.');
          continue;
        }
        lines.push(`  - label: ${yamlString(label)}`);
        lines.push(`    url: ${yamlString(url)}`);
      }
    }
  }

  lines.push('---');
  // Empty frontmatter still emits the fences — keeps the body offset stable —
  // but only when at least one key was actually written.
  if (lines.length === 2) return '';
  return lines.join('\n');
}

/** Render a single work entry back into the Markdown shape we expect. */
function workEntryToMarkdown(entry: JsonResumeWork): string {
  const position = asNonEmptyString(entry.position);
  const company = asNonEmptyString(entry.name) ?? asNonEmptyString(entry.company);
  const heading = [position, company].filter(Boolean).join(' — ') || 'Position';
  const startDate = asNonEmptyString(entry.startDate);
  const endDate = asNonEmptyString(entry.endDate);
  const location = asNonEmptyString(entry.location);

  const out: string[] = [`### ${heading}`, ''];
  const metaParts: string[] = [];
  if (startDate || endDate) {
    const displayEnd = endDate ?? (startDate ? 'Present' : undefined);
    metaParts.push([startDate, displayEnd].filter(Boolean).join(' – '));
  }
  if (location) metaParts.push(location);
  if (metaParts.length > 0) {
    out.push(`_${metaParts.join(' · ')}_`);
    out.push('');
  }
  const summary = asNonEmptyString(entry.summary);
  if (summary) {
    out.push(summary);
    out.push('');
  }
  if (Array.isArray(entry.highlights)) {
    for (const h of entry.highlights) {
      const text = asNonEmptyString(h);
      if (text) out.push(`- ${text}`);
    }
  }
  return out.join('\n').trimEnd();
}

/** Render a single education entry. */
function educationEntryToMarkdown(entry: JsonResumeEducation): string {
  const studyType = asNonEmptyString(entry.studyType);
  const area = asNonEmptyString(entry.area);
  const institution = asNonEmptyString(entry.institution);
  const degree = [studyType, area].filter(Boolean).join(' ');
  const heading = [degree || undefined, institution].filter(Boolean).join(' — ') || 'Education';

  const startDate = asNonEmptyString(entry.startDate);
  const endDate = asNonEmptyString(entry.endDate);
  const out: string[] = [`### ${heading}`, ''];
  if (startDate || endDate) {
    const displayEnd = endDate ?? (startDate ? 'Present' : undefined);
    out.push(`_${[startDate, displayEnd].filter(Boolean).join(' – ')}_`);
    out.push('');
  }
  if (Array.isArray(entry.courses)) {
    for (const c of entry.courses) {
      const text = asNonEmptyString(c);
      if (text) out.push(`- ${text}`);
    }
  }
  const score = asNonEmptyString(entry.score);
  if (score) {
    out.push(`- Score: ${score}`);
  }
  return out.join('\n').trimEnd();
}

/** Render the skills array as a small pipe-table. */
function skillsToMarkdown(skills: JsonResumeSkill[]): string {
  const cleaned = skills.filter(
    (s): s is JsonResumeSkill => isPlainObject(s) && !!asNonEmptyString(s.name),
  );
  if (cleaned.length === 0) return '';

  // Decide which columns to show: name is always present; tools only if any
  // skill has keywords; depth only if any skill has a level.
  const showTools = cleaned.some((s) => Array.isArray(s.keywords) && s.keywords.length > 0);
  const showDepth = cleaned.some((s) => asNonEmptyString(s.level) !== undefined);

  const headers = ['Area'];
  if (showTools) headers.push('Tools');
  if (showDepth) headers.push('Depth');

  const sep = headers.map(() => '---');
  const rows = cleaned.map((s) => {
    const cells = [asNonEmptyString(s.name) ?? ''];
    if (showTools) {
      const tools = Array.isArray(s.keywords) ? s.keywords.filter(Boolean).join(', ') : '';
      cells.push(tools);
    }
    if (showDepth) cells.push(asNonEmptyString(s.level) ?? '');
    return cells;
  });

  const renderRow = (cells: string[]) => `| ${cells.join(' | ')} |`;

  return [renderRow(headers), renderRow(sep), ...rows.map(renderRow)].join('\n');
}

/**
 * Convert a parsed JSON Resume into Markdown. Returns the body text along
 * with non-fatal warnings about anything that could not be cleanly mapped.
 *
 * Defensive by design: any structural surprise (e.g. `work` is not an array)
 * is converted into a warning rather than an exception. The output is always
 * a string, never `undefined`.
 */
export function fromJsonResume(json: unknown): { markdown: string; warnings: string[] } {
  const warnings: string[] = [];

  if (json === null || typeof json !== 'object') {
    warnings.push('That file did not contain a JSON Resume document (expected a JSON object).');
    return { markdown: '', warnings };
  }

  if (Array.isArray(json)) {
    warnings.push(
      'That JSON file is an array. JSON Resume documents are objects with a `basics` block.',
    );
    return { markdown: '', warnings };
  }

  const resume = json as Record<string, unknown>;

  /* ----- Round-trip fast path ----- */
  // If this document was originally exported by Works on My Resume, it
  // carries the verbatim Markdown body and we use it as-is for fidelity.
  const meta = isPlainObject(resume.meta) ? resume.meta : undefined;
  const womr = meta && isPlainObject(meta.womr) ? meta.womr : undefined;
  const preservedBody = womr && asNonEmptyString(womr.markdownBody);
  if (preservedBody) {
    return { markdown: preservedBody, warnings };
  }

  /* ----- Synthesize Markdown from the schema sections ----- */
  const basics = isPlainObject(resume.basics) ? (resume.basics as JsonResumeBasics) : {};

  const parts: string[] = [];
  const frontmatter = basicsToFrontmatter(basics, warnings);
  if (frontmatter) {
    parts.push(frontmatter);
    parts.push(''); // blank line between frontmatter and the body
  }

  // Summary
  const summary = asNonEmptyString(basics.summary);
  if (summary) {
    parts.push('## Summary', '', summary, '');
  }

  // Work
  const workList = Array.isArray(resume.work) ? resume.work : undefined;
  if (workList && workList.length > 0) {
    parts.push('## Experience', '');
    for (const entry of workList) {
      if (!isPlainObject(entry)) {
        warnings.push('A `work` entry was not an object and was skipped.');
        continue;
      }
      parts.push(workEntryToMarkdown(entry as JsonResumeWork));
      parts.push('');
    }
  } else if (resume.work !== undefined && !Array.isArray(resume.work)) {
    warnings.push('`work` should be a list of jobs — it was not, so the section was skipped.');
  }

  // Skills
  const skillsList = Array.isArray(resume.skills) ? resume.skills : undefined;
  if (skillsList && skillsList.length > 0) {
    const skillsMd = skillsToMarkdown(skillsList as JsonResumeSkill[]);
    if (skillsMd) {
      parts.push('## Skills', '', skillsMd, '');
    }
  } else if (resume.skills !== undefined && !Array.isArray(resume.skills)) {
    warnings.push('`skills` should be a list — it was not, so the section was skipped.');
  }

  // Education
  const eduList = Array.isArray(resume.education) ? resume.education : undefined;
  if (eduList && eduList.length > 0) {
    parts.push('## Education', '');
    for (const entry of eduList) {
      if (!isPlainObject(entry)) {
        warnings.push('An `education` entry was not an object and was skipped.');
        continue;
      }
      parts.push(educationEntryToMarkdown(entry as JsonResumeEducation));
      parts.push('');
    }
  } else if (resume.education !== undefined && !Array.isArray(resume.education)) {
    warnings.push('`education` should be a list — it was not, so the section was skipped.');
  }

  // Note un-mapped sections so the user knows nothing was silently dropped.
  const skipSections = [
    'projects',
    'awards',
    'certificates',
    'publications',
    'volunteer',
    'references',
  ];
  for (const key of skipSections) {
    const value = resume[key];
    if (Array.isArray(value) && value.length > 0) {
      warnings.push(
        `Your JSON Resume includes a "${key}" section that this app does not currently render — it was kept out of the Markdown.`,
      );
    }
  }

  const markdown =
    parts
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd() + '\n';
  return { markdown, warnings };
}

/* ------------------------------------------------------------------ */
/* Download helper                                                     */
/* ------------------------------------------------------------------ */

/** True only in a real browser environment (not during SSR / build). */
function isBrowser(): boolean {
  return typeof document !== 'undefined' && typeof window !== 'undefined';
}

/**
 * Trigger a client-side download of a JSON Resume document. Mirrors the
 * Blob + `<a download>` pattern used by `export.ts`; we replicate the
 * helper here (rather than reaching into a file we don't own) so this
 * module remains the single source of truth for the JSON Resume path.
 *
 * Filename is `<slug-from-name>-resume.json`, e.g. `avery-quinn-resume.json`.
 */
export function downloadJsonResume(jsonResume: JsonResume): void {
  if (!isBrowser()) return;

  const name = jsonResume.basics?.name;
  const filename = `${slugify(name)}-resume.json`;
  const content = JSON.stringify(jsonResume, null, 2);
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  } finally {
    URL.revokeObjectURL(url);
  }
}
