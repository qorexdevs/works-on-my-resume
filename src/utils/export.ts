/**
 * Export & download utilities for Works on My Resume.
 *
 * Everything in this module happens locally, in the browser. Nothing is
 * uploaded, stored on a server, or transmitted anywhere: each export builds
 * a string in memory, wraps it in a Blob, and hands it to the browser's
 * download mechanism via an object URL. There is no network involvement.
 *
 * The module is import-safe during SSR / static build: it never touches
 * `document` or `window` at module scope, and every browser-only function
 * guards those globals before use.
 *
 * Print-mode contract (#82). The standalone HTML export mirrors the in-app
 * print modes so a downloaded file behaves the same way the studio does when
 * the recipient prints it.
 *   - The export ALWAYS embeds the active theme's `--resume-*` variables so
 *     the document renders themed when opened normally in a browser.
 *   - The `<body>` carries `data-print-mode="<mode>"` and the embedded print
 *     block branches on that attribute, exactly like `src/styles/print.css`
 *     branches on `body[data-print-mode]` in the live app.
 *   - The default is `'conservative'`: a downloaded file should print
 *     black-on-white by default — the same safer default the in-app panel
 *     ships with, and the one that respects the user's ink and ATS parsers.
 *     Callers who want themed print explicitly pass `'theme'`.
 */

import type { PrintMode, ResumeTheme, ResumeFrontmatter, ResumeTemplate } from '../types';
import { DEFAULT_RESUME_TEMPLATE } from '../types';
import { themeCssVariables } from './themes';

/*
 * Single source of truth for resume-document styling.
 *
 * `resume.css` styles the in-app preview (it is `@import`ed by global.css).
 * The standalone-HTML export needs the SAME styling, so rather than keeping
 * a hand-maintained copy here — which inevitably drifts — we import the
 * exact same stylesheet as a raw string via Vite's `?raw` suffix and inline
 * it into the exported document.
 *
 * `resume.css` is written to be self-contained for exactly this use: it is
 * fully scoped under `.resume-preview`, carries its own `--resume-*` color
 * fallbacks, its own type tokens, and a `box-sizing` reset, so it renders
 * correctly embedded in a bare exported `<body>` with no other CSS.
 *
 * The only resume styling NOT in `resume.css` is `STANDALONE_EXPORT_CSS`
 * below: the bare-document framing (page background, centering) and a print
 * block that the export needs but the in-app build gets from `print.css`.
 */
import resumeCss from '../styles/resume.css?raw';

/* ------------------------------------------------------------------ */
/* Internal helpers                                                    */
/* ------------------------------------------------------------------ */

/** True only in a real browser environment (not during SSR / build). */
function isBrowser(): boolean {
  return typeof document !== 'undefined' && typeof window !== 'undefined';
}

/**
 * Slugify a candidate string for use in a filename: lowercase, with every
 * run of non-alphanumeric characters collapsed to a single hyphen and any
 * leading/trailing hyphens trimmed. Falls back to `resume` when the input
 * is empty or yields nothing usable.
 */
function slugify(input: string | undefined): string {
  if (!input) return 'resume';
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'resume';
}

/**
 * Minimal HTML-escape for text interpolated into markup (e.g. the document
 * title derived from frontmatter). Keeps the standalone export XSS-safe even
 * though the resume body itself is already sanitized upstream.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Build the contact-header HTML block from frontmatter, mirroring the JSX
 * `ResumePreview.tsx` renders for the in-app preview (#124).
 *
 * Was missing from the standalone export: only the markdown body was
 * embedded, so downloaded HTML jumped straight into `<h2>Summary</h2>`
 * with no name / role / contact card. This restores parity with the
 * preview a user sees in the app.
 *
 * Safety:
 *   - Every interpolated frontmatter value is run through `escapeHtml`.
 *   - Link hrefs are validated by `safeContactHref` — only `mailto:`,
 *     `tel:`, `http:`, and `https:` survive; anything else (including
 *     `javascript:` and `data:`) is dropped so a malicious frontmatter
 *     value can't smuggle a payload through the exported file.
 */
function safeContactHref(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  // Lower-case the scheme for the comparison only; preserve the original
  // casing of the rest of the URL.
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  if (!schemeMatch) {
    // Protocol-relative ("//host/…") and bare paths are not safe to expose
    // in a downloaded standalone file (the recipient's origin is unknown).
    return null;
  }
  const scheme = schemeMatch[1].toLowerCase();
  if (scheme !== 'http' && scheme !== 'https' && scheme !== 'mailto' && scheme !== 'tel') {
    return null;
  }
  return trimmed;
}

function buildContactHeaderHtml(frontmatter: ResumeFrontmatter): string {
  const name = frontmatter.name?.trim() ?? '';
  const role = frontmatter.role?.trim() ?? '';
  const location = frontmatter.location?.trim() ?? '';
  const email = frontmatter.email?.trim() ?? '';
  const phone = frontmatter.phone?.trim() ?? '';
  const links = Array.isArray(frontmatter.links) ? frontmatter.links : [];

  type MetaItem = { key: string; html: string };
  const items: MetaItem[] = [];

  if (location) {
    items.push({ key: 'loc', html: escapeHtml(location) });
  }
  if (email) {
    const href = safeContactHref(`mailto:${email}`);
    if (href) {
      items.push({
        key: 'email',
        html: `<a href="${escapeHtml(href)}">${escapeHtml(email)}</a>`,
      });
    }
  }
  if (phone) {
    // Phones are surfaced as plain text — `tel:` links are visually noisy
    // in print and the in-app preview renders them as text too.
    items.push({ key: 'phone', html: escapeHtml(phone) });
  }
  for (const link of links) {
    if (!link || typeof link !== 'object') continue;
    const label = typeof link.label === 'string' ? link.label.trim() : '';
    const rawUrl = typeof link.url === 'string' ? link.url.trim() : '';
    if (!label || !rawUrl) continue;
    const href = safeContactHref(rawUrl);
    if (!href) continue;
    items.push({
      key: `link-${label}`,
      html: `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`,
    });
  }

  const hasAny = Boolean(name || role || items.length);
  if (!hasAny) return '';

  const parts: string[] = ['<header class="resume-preview__contact">'];
  if (name) {
    parts.push(`  <p class="resume-preview__contact-name">${escapeHtml(name)}</p>`);
  }
  if (role) {
    parts.push(`  <p class="resume-preview__contact-role">${escapeHtml(role)}</p>`);
  }
  if (items.length) {
    const metaInner = items
      .map((item, index) => {
        // Match the React component: the `·` separator only precedes items
        // at index ≥ 1, never the first item.
        const sep =
          index > 0 ? '<span class="resume-preview__contact-sep" aria-hidden="true">·</span>' : '';
        return `<span class="resume-preview__contact-meta-item">${sep}${item.html}</span>`;
      })
      .join('');
    parts.push(`  <p class="resume-preview__contact-meta">${metaInner}</p>`);
  }
  parts.push('</header>');
  return parts.join('\n');
}

/**
 * Trigger a client-side download of `content` as `filename`.
 *
 * Wraps the content in a Blob, mints a temporary object URL, clicks a
 * detached `<a download>`, then cleans up both the element and the URL.
 * No-ops during SSR / build so callers need not guard themselves.
 */
function triggerDownload(content: string, filename: string, mimeType: string): void {
  if (!isBrowser()) return;

  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);

  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    // Detached anchors are not part of the layout; appending is only needed
    // for broad cross-browser compatibility of the synthetic click.
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  } finally {
    // Always release the object URL so the Blob can be garbage-collected.
    URL.revokeObjectURL(url);
  }
}

/* ------------------------------------------------------------------ */
/* Export-only stylesheet supplement                                   */
/* ------------------------------------------------------------------ */

/**
 * The SMALL slice of styling that the standalone export needs but the
 * in-app build gets from elsewhere.
 *
 * The bulk of the resume styling is `resumeCss` (the shared `resume.css`).
 * That file styles the `.resume-preview` document but deliberately says
 * nothing about the page it sits on — in the app that framing comes from
 * `global.css` / `.preview-frame`, and print handling comes from `print.css`.
 *
 * An exported document has neither, so this supplement provides exactly two
 * things and nothing more:
 *   - bare-document framing: a reset, a page background, and centering the
 *     `.resume-preview` sheet on the page;
 *   - a print block, so the downloaded HTML prints cleanly (drop the page
 *     chrome, avoid awkward page breaks, keep links readable).
 *
 * The print block branches on `body[data-print-mode]`, mirroring the live
 * app's `src/styles/print.css`:
 *   - `theme`: keep the embedded theme's colors in print, and tell the
 *     browser to actually paint them (`print-color-adjust: exact`).
 *   - any other value (`conservative` or missing): force black-on-white ink,
 *     readable underlined links, and neutralize the `modern` layout's
 *     decorative mono uppercase headings so an exported file prints the same
 *     ATS-plain output the studio's conservative mode produces.
 */
const STANDALONE_EXPORT_CSS = `
/* Bare-document framing — the page the resume sheet rests on. */
*,
*::before,
*::after {
  box-sizing: border-box;
}

body {
  margin: 0;
  padding: 2.5rem 1rem;
  background: var(--resume-bg, #ffffff);
  color: var(--resume-fg, #1f2328);
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}

/* Center the resume sheet; resume.css owns the sheet's own appearance. */
.resume-preview {
  margin-inline: auto;
}

/* Print: visible page margins live on @page so every page (1, 2, 3, …) gets
   identical insets. The previous #106 setup pushed the margin onto body
   padding to let the themed bg bleed to the page edges, but body padding
   only paints once — multi-page resumes lost their top/bottom margins on
   every page after page 1 (#133). The themed bleed is preserved by the
   html-element background rule for theme print mode — the canvas root paints
   across the @page margin region on modern browsers. */
@page {
  size: letter;
  margin: 0.6in;
}

/* Multi-page footer (#109) — see src/styles/print.css for the full rationale.
   Conservative-mode default is "Page X of Y"; theme mode suppresses it; page 1
   is always blank so single-page resumes show nothing at all. */
:root {
  --print-page-footer: 'Page ' counter(page) ' of ' counter(pages);
}

html:has(body[data-print-mode='theme']) {
  --print-page-footer: '';
}

@page {
  @bottom-right {
    content: var(--print-page-footer);
    font: 10pt 'Source Serif 4', Charter, 'Iowan Old Style', Georgia, serif;
    color: rgb(0 0 0 / 0.6);
    padding: 0 0.6in 0.4in 0;
  }
}

@page :first {
  @bottom-right {
    content: none;
  }
}

@media print {
  body {
    /* No padding here — visible margin lives on @page above (#133). */
    padding: 0;
  }

  .resume-preview {
    max-width: none;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: 0;
    box-shadow: none;
  }

  .resume-preview h1,
  .resume-preview h2,
  .resume-preview h3,
  .resume-preview h4 {
    page-break-after: avoid;
    break-after: avoid;
  }

  .resume-preview li,
  .resume-preview p,
  .resume-preview blockquote,
  .resume-preview pre,
  .resume-preview table,
  .resume-preview img {
    page-break-inside: avoid;
    break-inside: avoid;
  }

  /* ----------------------------------------------------------------
   * THEME mode — print with the embedded theme's colors. The browser
   * has to be told to actually paint background colors in print.
   *
   * The html-level background is what makes the themed colour reach the
   * page edges through the @page margin region on every printer page
   * (#133). Without it, the body's bg only paints inside the content area
   * @page reserves, and the margin bands print on the printer's default
   * paper colour.
   * -------------------------------------------------------------- */
  html:has(body[data-print-mode='theme']) {
    background: var(--resume-bg, #ffffff) !important;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  body[data-print-mode='theme'] {
    background: var(--resume-bg, #ffffff);
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  body[data-print-mode='theme'] .resume-preview {
    /* Repaint the card to match the body bg so the printed page is uniform
       (#123). On screen --resume-card lifts the resume off the app shell;
       in print, the page IS the document and that lift becomes a visible
       color gap. */
    background: var(--resume-bg, #ffffff) !important;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  /* ----------------------------------------------------------------
   * CONSERVATIVE mode (also covers a missing attribute). Black ink on
   * white paper, underlined links, no decorative color. Mirrors the
   * conservative branch of src/styles/print.css.
   * -------------------------------------------------------------- */
  body:not([data-print-mode='theme']) {
    background: #ffffff;
  }

  body:not([data-print-mode='theme']) .resume-preview {
    background: #ffffff !important;
    color: #000 !important;
  }

  body:not([data-print-mode='theme']) .resume-preview :is(h1, h2, h3, h4),
  body:not([data-print-mode='theme']) .resume-preview strong,
  body:not([data-print-mode='theme']) .resume-preview li::marker,
  body:not([data-print-mode='theme']) .resume-preview th {
    color: #000 !important;
    background: none !important;
  }

  /* Italic body emphasis — pin to a print-safe shade on white (#113). */
  body:not([data-print-mode='theme']) .resume-preview :is(em, i) {
    color: #222 !important;
  }

  body:not([data-print-mode='theme']) .resume-preview h2 {
    border-bottom-color: #000 !important;
  }

  body:not([data-print-mode='theme']) .resume-preview a {
    color: #000 !important;
    text-decoration: underline;
  }

  body:not([data-print-mode='theme']) .resume-preview :is(blockquote, hr) {
    background: none !important;
    border-color: #000 !important;
    color: #222 !important;
  }

  body:not([data-print-mode='theme']) .resume-preview :is(code, pre, table, th, td) {
    background: #fff !important;
    border-color: #000 !important;
  }

  body:not([data-print-mode='theme']) .resume-preview__contact-name {
    color: #000 !important;
  }

  body:not([data-print-mode='theme']) .resume-preview__contact-role {
    color: #222 !important;
  }

  body:not([data-print-mode='theme'])
    .resume-preview
    :is(.resume-preview__contact, .resume-preview__contact-meta) {
    color: #222 !important;
    border-color: #000 !important;
  }

  body:not([data-print-mode='theme']) .resume-preview__contact-meta a {
    color: #000 !important;
  }

  /* Conservative × modern layout: neutralize the mono uppercase overlay
     so a downloaded modern-layout resume prints ATS-plain serif.
     Mirrors the same #81 block in src/styles/print.css. */
  body:not([data-print-mode='theme']) .resume-preview[data-template='modern'] :is(h1, h2, h3, h4) {
    font-family: 'Source Serif 4', Charter, 'Iowan Old Style', Georgia, serif !important;
    text-transform: none !important;
    letter-spacing: 0 !important;
    color: #000 !important;
  }

  body:not([data-print-mode='theme']) .resume-preview[data-template='modern'] h2 {
    border-bottom-color: #000 !important;
  }

  body:not([data-print-mode='theme'])
    .resume-preview[data-template='modern']
    :is(h3 + p em, h4 + p em) {
    font-family: 'Source Serif 4', Charter, 'Iowan Old Style', Georgia, serif !important;
    text-transform: none !important;
    letter-spacing: 0 !important;
    color: #222 !important;
  }

  body:not([data-print-mode='theme'])
    .resume-preview[data-template='modern']
    .resume-preview__contact {
    border-bottom-color: #000 !important;
  }

  body:not([data-print-mode='theme'])
    .resume-preview[data-template='modern']
    .resume-preview__contact-name {
    letter-spacing: 0 !important;
    color: #000 !important;
  }

  body:not([data-print-mode='theme'])
    .resume-preview[data-template='modern']
    .resume-preview__contact-role {
    font-family: 'Source Serif 4', Charter, 'Iowan Old Style', Georgia, serif !important;
    text-transform: none !important;
    letter-spacing: 0 !important;
    color: #222 !important;
  }
}
`.trim();

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Build a complete, dependency-free standalone HTML document for a resume.
 *
 * The returned string is a valid `<!doctype html>` document with everything
 * inlined in a single `<style>` block, in cascade order:
 *   1. the theme's `--resume-*` custom properties (`themeCssVariables`);
 *   2. `resumeCss` — the shared `resume.css`, the SAME stylesheet that
 *      styles the in-app preview, so the export can never drift from it;
 *   3. `STANDALONE_EXPORT_CSS` — bare-document framing + print rules that
 *      branch on `body[data-print-mode]` (see file header for the contract).
 * There are no external CSS files, scripts, fonts, or network requests, so
 * the file renders the same offline, on any machine.
 *
 * @param resumeHtml  Already-sanitized resume HTML (output of the Markdown
 *                    pipeline). It is embedded verbatim and is NOT escaped.
 * @param theme       The active theme; its CSS variables are inlined so the
 *                    document still renders themed when opened in a browser,
 *                    regardless of which print mode the recipient ends up
 *                    using.
 * @param frontmatter Resume frontmatter; `name` seeds the document title.
 * @param template    The active layout template (#30). Applied as
 *                    `data-template="<slug>"` on the `.resume-preview`
 *                    element so the CSS variant is preserved in the export.
 *                    Defaults to `classic`.
 * @param mode        Print mode the embedded `@media print` block resolves
 *                    against (#82). `'conservative'` (the default — the
 *                    safer choice for a downloaded file) prints
 *                    black-on-white ATS-plain; `'theme'` prints with the
 *                    embedded theme's colors.
 */
export function buildStandaloneHtml(
  resumeHtml: string,
  theme: ResumeTheme,
  frontmatter: ResumeFrontmatter,
  template: ResumeTemplate = DEFAULT_RESUME_TEMPLATE,
  mode: PrintMode = 'conservative',
): string {
  const name = frontmatter.name?.trim();
  const title = name ? `${name} — Resume` : 'Resume';
  const themeVars = themeCssVariables(theme);
  const contactHeader = buildContactHeaderHtml(frontmatter);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <meta name="generator" content="Works on My Resume" />
    <style>
${themeVars}

${resumeCss}

${STANDALONE_EXPORT_CSS}
    </style>
  </head>
  <body data-print-mode="${escapeHtml(mode)}">
    <!-- Generated by Works on My Resume. Resume content was processed locally in the browser. -->
    <article class="resume-preview" data-template="${escapeHtml(template)}">
${contactHeader}
${resumeHtml}
    </article>
  </body>
</html>
`;
}

/**
 * Download the raw Markdown source of the resume as a `.md` file.
 *
 * The filename is derived from `frontmatter.name` (slugified), e.g.
 * `avery-quinn-resume.md`, defaulting to `resume.md` when no name is set.
 * No-ops outside the browser.
 */
export function downloadMarkdown(markdown: string, frontmatter: ResumeFrontmatter): void {
  const filename = `${slugify(frontmatter.name)}-resume.md`;
  triggerDownload(markdown, filename, 'text/markdown');
}

/* ------------------------------------------------------------------ */
/* Plain-text export (#110)                                            */
/* ------------------------------------------------------------------ */

/**
 * Walk the rendered `.resume-preview` article and produce a reader-friendly
 * plain-text rendering for legacy ATS systems that choke on HTML, fancy
 * Unicode, or even Markdown decoration.
 *
 * The function is pure DOM-walking — no React imports, no Markdown library —
 * and operates on `.textContent` of the already-sanitized preview tree. The
 * trust boundary is the same one `TailorForRole` uses: by the time content
 * reaches us, DOMPurify has run and we are only re-emitting text the user
 * already saw. Three guarantees follow from that:
 *
 *   - The output never contains HTML angle brackets — we never serialize
 *     element markup, we only read `textContent` from leaf nodes.
 *   - The output never contains Markdown decoration (`**bold**`, `_em_`,
 *     backtick `code`, `[label](url)`) because we read the RENDERED DOM,
 *     not the Markdown source.
 *   - The output is deterministic given the same DOM.
 *
 * Formatting rules:
 *   - Contact header at the top, sourced from `.resume-preview__contact-*`
 *     elements (so the data we render is whatever the user actually sees,
 *     even if frontmatter is partially missing). Name on its own line in
 *     uppercase, role on the next, location · email · phone joined by
 *     middots, then each link on its own labeled line.
 *   - Body section headings (`h2`, `h3`, `h4`) become UPPERCASE on their own
 *     line, with a blank line below.
 *   - Paragraphs become wrapped flowed text separated by blank lines.
 *   - List items become `- ` prefixed lines; nested lists indent two spaces
 *     per level.
 *   - Anchor text becomes `text (url)` when the visible text differs from
 *     the URL, otherwise just the URL.
 *   - Whitespace within a block collapses to single spaces; block separators
 *     produce exactly one blank line between blocks.
 */
export function buildPlainText(article: HTMLElement): string {
  /* ----- Contact header (top of document) ---------------------------
     Read straight from the rendered `.resume-preview__contact-*` nodes.
     Each line is its own array entry so the join keeps the contract of
     "one newline per element". */
  const lines: string[] = [];

  const nameEl = article.querySelector<HTMLElement>('.resume-preview__contact-name');
  const roleEl = article.querySelector<HTMLElement>('.resume-preview__contact-role');
  const name = (nameEl?.textContent ?? '').trim();
  const role = (roleEl?.textContent ?? '').trim();
  if (name) lines.push(name.toUpperCase());
  if (role) lines.push(role);

  /* The contact-meta paragraph contains location / email / phone / links
     as inline children. Walk its direct children so we can keep links as
     `Label: url` lines below the middot-joined location/email/phone row,
     mirroring the visual structure the rendered header presents. */
  const meta = article.querySelector<HTMLElement>('.resume-preview__contact-meta');
  if (meta) {
    const middotItems: string[] = [];
    const linkLines: string[] = [];
    /* Each meaningful piece of metadata is wrapped in
       `.resume-preview__contact-meta-item` (see ResumePreview.tsx) — walk
       those, not the textContent of `meta`, so the middot separators
       don't pollute the output. */
    const items = meta.querySelectorAll<HTMLElement>('.resume-preview__contact-meta-item');
    for (const item of items) {
      /* The wrapper carries an aria-hidden `·` separator as its first
         child (see ResumePreview.tsx). Strip it via a clone so the text
         we extract is purely the data, not the visual glue. */
      const clone = item.cloneNode(true) as HTMLElement;
      for (const sep of Array.from(clone.querySelectorAll('.resume-preview__contact-sep'))) {
        sep.remove();
      }
      const anchor = clone.querySelector<HTMLAnchorElement>('a[href]');
      if (anchor) {
        const href = anchor.getAttribute('href') ?? '';
        const label = (anchor.textContent ?? '').trim();
        /* Email links carry a `mailto:` href — we want the address, not
           the scheme, on its own row in the middot group. Other anchors
           (LinkedIn / GitHub / Website) go on their own labeled lines. */
        if (href.startsWith('mailto:')) {
          middotItems.push(label || href.slice('mailto:'.length));
        } else if (href.startsWith('tel:')) {
          middotItems.push(label || href.slice('tel:'.length));
        } else {
          const url = href.trim();
          if (label && label !== url) {
            /* Pad the label column so URLs roughly align, but only up
               to a sensible width — long labels just get a single space. */
            const padded = label.length < 8 ? `${label}:`.padEnd(10, ' ') : `${label}: `;
            linkLines.push(`${padded}${url}`);
          } else if (url) {
            linkLines.push(url);
          }
        }
      } else {
        const text = (clone.textContent ?? '').trim();
        if (text) middotItems.push(text);
      }
    }
    if (middotItems.length > 0) lines.push(middotItems.join(' · '));
    for (const linkLine of linkLines) lines.push(linkLine);
  }

  /* ----- Body --------------------------------------------------------
     Walk `.resume-preview__body`'s children in order. Each block-level
     child becomes one logical block in the output, separated by a blank
     line. Block types we know about: h2/h3/h4 (sections), p (paragraph),
     ul/ol (lists), blockquote, pre (code block), hr (separator).
     Anything else falls through to flat textContent. */
  const body = article.querySelector<HTMLElement>('.resume-preview__body');
  const blocks: string[] = [];

  if (body) {
    for (const child of Array.from(body.children)) {
      const rendered = renderBlock(child as HTMLElement, 0);
      if (rendered.trim().length > 0) blocks.push(rendered);
    }
  }

  /* Join: contact header is a tight block (one newline per line), then
     a blank line separates it from the body, then blocks are separated
     by blank lines. */
  const header = lines.join('\n');
  const bodyText = blocks.join('\n\n');
  const out = header && bodyText ? `${header}\n\n${bodyText}` : header || bodyText;

  /* Final pass: collapse runs of 3+ newlines down to exactly two (one
     blank line). Trim trailing whitespace on every line. Trim the doc. */
  return (
    out
      .split('\n')
      .map((line) => line.replace(/[ \t]+$/g, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim() + '\n'
  );
}

/**
 * Render one body-level element into plain text. Recursive for nested
 * lists; the `depth` parameter controls bullet indentation (two spaces
 * per nesting level). Returns the rendered text WITHOUT trailing newline
 * separators — the caller composes blocks with `\n\n` between them.
 */
function renderBlock(el: HTMLElement, depth: number): string {
  const tag = el.tagName.toLowerCase();

  if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4') {
    /* All headings collapse to a single uppercased line. We don't try to
       preserve heading hierarchy: ATS parsers do not care, and uppercase
       lines read as section dividers in monospace contexts. */
    const text = inlineText(el);
    return text ? text.toUpperCase() : '';
  }

  if (tag === 'p') {
    return inlineText(el);
  }

  if (tag === 'ul' || tag === 'ol') {
    return renderList(el, depth);
  }

  if (tag === 'blockquote') {
    /* Quote prose flows as ordinary paragraphs — we deliberately do NOT
       prefix with `>` (the canonical plain-text quote glyph) because the
       file's safety contract for legacy ATS forbids any angle brackets
       in the output. An indented quote would risk an ATS reading the
       indent as a continuation of the previous paragraph; an unprefixed
       blockquote loses the visual cue but keeps the contract. */
    const inner: string[] = [];
    for (const child of Array.from(el.children)) {
      const rendered = renderBlock(child as HTMLElement, depth);
      if (rendered.trim()) inner.push(rendered);
    }
    return inner.length > 0 ? inner.join('\n\n') : inlineText(el);
  }

  if (tag === 'pre') {
    /* Code blocks are reproduced verbatim — `textContent` preserves the
       authored line breaks. No syntax decoration. We DO strip a trailing
       newline because `<pre>` content typically ends with one and the
       block-joiner adds two more. */
    const text = el.textContent ?? '';
    return text.replace(/\n+$/, '');
  }

  if (tag === 'hr') {
    /* A visible separator. Eight dashes is the lowest-common-denominator
       hr glyph that survives every text reader. */
    return '--------';
  }

  if (tag === 'table') {
    /* Tables degrade to a flat row-per-line rendering: cells joined by
       " | ". This is good enough for legacy ATS — proper column
       alignment requires monospace assumptions we cannot make. */
    const rows: string[] = [];
    const trs = el.querySelectorAll<HTMLTableRowElement>('tr');
    for (const tr of trs) {
      const cells = Array.from(tr.querySelectorAll<HTMLElement>('th, td')).map((c) =>
        inlineText(c),
      );
      if (cells.some((c) => c.length > 0)) rows.push(cells.join(' | '));
    }
    return rows.join('\n');
  }

  /* Fallthrough: anything else (a wrapper div, a section, etc.) gets
     flattened by walking children. */
  if (el.children.length > 0) {
    const parts: string[] = [];
    for (const child of Array.from(el.children)) {
      const rendered = renderBlock(child as HTMLElement, depth);
      if (rendered.trim()) parts.push(rendered);
    }
    return parts.join('\n\n');
  }
  return inlineText(el);
}

/**
 * Render a `<ul>` or `<ol>` into bulleted lines. Nested lists indent by
 * two spaces per level. Ordered lists still use `- ` bullets because
 * authored numbering rarely survives ATS re-parsing intact, and we'd
 * rather present an obvious-to-the-eye list than a fragile numbered one.
 */
function renderList(el: HTMLElement, depth: number): string {
  const indent = '  '.repeat(depth);
  const lines: string[] = [];
  for (const child of Array.from(el.children)) {
    if (child.tagName.toLowerCase() !== 'li') continue;
    const li = child as HTMLElement;

    /* Separate the inline content of this `<li>` from any nested lists.
       The inline content becomes the bullet text; nested lists are
       rendered recursively, indented one level deeper. */
    const nested: HTMLElement[] = [];
    const inlineNodes: Node[] = [];
    for (const node of Array.from(li.childNodes)) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const childTag = (node as HTMLElement).tagName.toLowerCase();
        if (childTag === 'ul' || childTag === 'ol') {
          nested.push(node as HTMLElement);
          continue;
        }
      }
      inlineNodes.push(node);
    }
    const text = inlineText(makeFragment(inlineNodes));
    lines.push(`${indent}- ${text}`);
    for (const sub of nested) {
      lines.push(renderList(sub, depth + 1));
    }
  }
  return lines.join('\n');
}

/**
 * Wrap an arbitrary node list in a detached `<div>` so we can hand it to
 * `inlineText` without disturbing the live DOM. We never insert the
 * fragment anywhere — it is only a textContent container.
 */
function makeFragment(nodes: Node[]): HTMLElement {
  const div = document.createElement('div');
  for (const node of nodes) div.appendChild(node.cloneNode(true));
  return div;
}

/**
 * Render the inline content of an element to a single line of plain
 * text. Walks descendants:
 *   - Text nodes contribute their value (whitespace-collapsed).
 *   - Anchors contribute `text (url)` when text and url differ, else `url`.
 *   - Line-break elements contribute a single space (we are flowing).
 *   - Everything else contributes its own descendants' text.
 *
 * Whitespace runs collapse to a single space; the result is trimmed.
 */
function inlineText(el: HTMLElement): string {
  const parts: string[] = [];
  walkInline(el, parts);
  /* Collapse all whitespace runs to a single space and trim. */
  return parts.join('').replace(/\s+/g, ' ').trim();
}

function walkInline(el: HTMLElement, out: string[]): void {
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      out.push(node.nodeValue ?? '');
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const child = node as HTMLElement;
    const tag = child.tagName.toLowerCase();

    if (tag === 'a') {
      const href = child.getAttribute('href') ?? '';
      const text = (child.textContent ?? '').replace(/\s+/g, ' ').trim();
      /* Resolve href into a printable URL: drop mailto/tel scheme so the
         email or phone appears as the user wrote it. */
      let printable = href;
      if (href.startsWith('mailto:')) printable = href.slice('mailto:'.length);
      else if (href.startsWith('tel:')) printable = href.slice('tel:'.length);

      if (!printable && !text) continue;
      if (!text) {
        out.push(printable);
      } else if (!printable || text === printable) {
        out.push(text);
      } else {
        out.push(`${text} (${printable})`);
      }
      continue;
    }

    if (tag === 'br') {
      out.push(' ');
      continue;
    }

    /* Inline emphasis / strong / code / span: just descend. The visual
       weight is lost, which is intentional — plain text. */
    walkInline(child, out);
  }
}

/**
 * Download the resume as a plain-text `.txt` file built from the rendered
 * preview (#110).
 *
 * Intended for legacy ATS systems that cannot reliably parse HTML or even
 * Markdown. The text is sourced from the live preview DOM so the user gets
 * exactly what they saw rendered — no separate code path that could drift
 * from the in-app view. The filename is derived from `frontmatter.name`
 * (slugified), e.g. `avery-quinn-resume.txt`. No-ops outside the browser.
 */
export function downloadPlainText(article: HTMLElement, frontmatter: ResumeFrontmatter): void {
  const text = buildPlainText(article);
  const filename = `${slugify(frontmatter.name)}-resume.txt`;
  triggerDownload(text, filename, 'text/plain');
}

/**
 * Download the rendered resume as a standalone, self-contained `.html` file.
 *
 * The file embeds the active theme, the active layout template (#30), and a
 * print-friendly stylesheet that branches on the chosen `mode` (#82), so it
 * can be opened, shared, or printed anywhere with no dependencies. The
 * filename is derived from `frontmatter.name` (slugified), e.g.
 * `avery-quinn-resume.html`. No-ops outside the browser.
 */
export function downloadResumeHtml(
  resumeHtml: string,
  theme: ResumeTheme,
  frontmatter: ResumeFrontmatter,
  template: ResumeTemplate = DEFAULT_RESUME_TEMPLATE,
  mode: PrintMode = 'conservative',
): void {
  const html = buildStandaloneHtml(resumeHtml, theme, frontmatter, template, mode);
  const filename = `${slugify(frontmatter.name)}-resume.html`;
  triggerDownload(html, filename, 'text/html');
}

/**
 * Download just the active theme as a `.css` file containing the
 * `:root { --resume-*: ...; }` custom-property block.
 *
 * Useful for reusing a theme in another document. The filename is
 * `theme-<theme.slug>.css`. No-ops outside the browser.
 */
export function downloadThemeCss(theme: ResumeTheme): void {
  const css = themeCssVariables(theme);
  const filename = `theme-${slugify(theme.slug)}.css`;
  triggerDownload(css, filename, 'text/css');
}

/* ------------------------------------------------------------------ */
/* Store-only ZIP writer (#35)                                         */
/* ------------------------------------------------------------------ */

/*
 * Hand-rolled, dependency-free ZIP builder.
 *
 * We need to bundle `resume.md`, `resume.html`, and `theme-<slug>.css` into a
 * single download without pulling in JSZip or fflate. The ZIP container is
 * compact and stable enough to write directly: a per-entry local file header
 * followed by the file's uncompressed bytes, then a central directory and an
 * end-of-central-directory record. We use the STORE method (compression
 * type 0 — no DEFLATE), so the bytes are written verbatim and the format
 * stays minimal. The output opens cleanly in Finder, Windows Explorer,
 * macOS Archive Utility, and `unzip` on Linux.
 *
 * Reference: APPNOTE.TXT 6.3.10 (PKWARE ZIP specification).
 */

/** One entry in the ZIP, normalized to bytes with a stable filename. */
interface ZipEntry {
  /** UTF-8 encoded filename inside the archive (forward slashes only). */
  name: string;
  /** Raw file bytes. */
  data: Uint8Array;
  /** CRC-32 of `data`, computed once and reused for both header records. */
  crc32: number;
  /** Local-header offset within the assembled archive, set during writing. */
  offset: number;
}

/**
 * Precomputed CRC-32 lookup table.
 *
 * Built lazily on first use so we never pay the 256-iteration cost when no
 * one calls the ZIP path. The polynomial (0xEDB88320, the reversed form of
 * 0x04C11DB7) is the standard one used by every ZIP implementation.
 */
let crc32Table: Uint32Array | null = null;
function getCrc32Table(): Uint32Array {
  if (crc32Table) return crc32Table;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  crc32Table = table;
  return table;
}

/** Compute the standard CRC-32 of a byte buffer. */
function crc32(bytes: Uint8Array): number {
  const table = getCrc32Table();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = (c >>> 8) ^ table[(c ^ bytes[i]) & 0xff];
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Encode a string into UTF-8 bytes.
 *
 * `TextEncoder` is universally available in every browser this app targets
 * (and in Node). We never call this at module scope, only from helpers that
 * are themselves browser-only, so SSR is unaffected.
 */
function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/**
 * Encode a JS `Date` into the legacy MS-DOS date/time fields that ZIP uses.
 *
 * Two `uint16` values. Time resolution is 2 seconds (the low bit of seconds
 * is dropped); the year is offset from 1980 (ZIP epoch). Values clamp to
 * 1980 for any pre-epoch date so the archive is always parseable.
 */
function dosDateTime(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.max(1980, date.getFullYear());
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const dosTime =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  return { dosTime: dosTime & 0xffff, dosDate: dosDate & 0xffff };
}

/** Write a little-endian uint16 into `view` at `offset`. */
function writeU16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value & 0xffff, true);
}

/** Write a little-endian uint32 into `view` at `offset`. */
function writeU32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

/** Copy `bytes` into `target` starting at `offset`. */
function writeBytes(target: Uint8Array, offset: number, bytes: Uint8Array): void {
  target.set(bytes, offset);
}

/* ZIP "magic numbers" — fixed signatures from APPNOTE.TXT 6.3.10. */
const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const CENTRAL_DIRECTORY_SIG = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIG = 0x06054b50;

/* Header fixed sizes (excluding the variable-length filename). */
const LOCAL_FILE_HEADER_FIXED = 30;
const CENTRAL_DIRECTORY_FIXED = 46;
const END_OF_CENTRAL_DIRECTORY = 22;

/**
 * Build a store-only (no DEFLATE) ZIP from an ordered list of files.
 *
 * Returns a Uint8Array containing the full archive bytes. The layout is the
 * minimal three-section ZIP container:
 *
 *   [local file header + filename + bytes] * N
 *   [central directory entry + filename] * N
 *   [end-of-central-directory record]
 *
 * Each file is stored uncompressed (compression method 0), so the resulting
 * archive is slightly larger than a DEFLATE one but trivial to produce
 * without any compression library. The format is the same ZIP variant macOS
 * Archive Utility writes for "Compress" with already-compressed inputs.
 */
function buildStoreOnlyZip(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const now = new Date();
  const { dosTime, dosDate } = dosDateTime(now);

  // Pre-encode each entry: filename bytes, CRC, size. We compute every byte
  // needed for both the local headers and the central directory now, so the
  // final write pass is straight memcpy + integer writes.
  const entries: (ZipEntry & { nameBytes: Uint8Array })[] = files.map((file) => {
    const nameBytes = encodeUtf8(file.name);
    return {
      name: file.name,
      nameBytes,
      data: file.data,
      crc32: crc32(file.data),
      offset: 0,
    };
  });

  // First pass: compute the offset of each local header, then the offset and
  // size of the central directory.
  let localSize = 0;
  for (const entry of entries) {
    entry.offset = localSize;
    localSize += LOCAL_FILE_HEADER_FIXED + entry.nameBytes.length + entry.data.length;
  }
  const centralSize = entries.reduce(
    (sum, entry) => sum + CENTRAL_DIRECTORY_FIXED + entry.nameBytes.length,
    0,
  );
  const totalSize = localSize + centralSize + END_OF_CENTRAL_DIRECTORY;

  const buffer = new Uint8Array(totalSize);
  const view = new DataView(buffer.buffer);

  // ----- Local file headers + file bytes ------------------------------
  for (const entry of entries) {
    const o = entry.offset;
    writeU32(view, o + 0, LOCAL_FILE_HEADER_SIG);
    writeU16(view, o + 4, 20); // version needed to extract (2.0 = STORE/DEFLATE base)
    writeU16(view, o + 6, 0x0800); // general purpose bit flag: bit 11 = UTF-8 filename
    writeU16(view, o + 8, 0); // compression method: 0 = STORE
    writeU16(view, o + 10, dosTime);
    writeU16(view, o + 12, dosDate);
    writeU32(view, o + 14, entry.crc32);
    writeU32(view, o + 18, entry.data.length); // compressed size (== uncompressed for STORE)
    writeU32(view, o + 22, entry.data.length); // uncompressed size
    writeU16(view, o + 26, entry.nameBytes.length);
    writeU16(view, o + 28, 0); // extra field length

    writeBytes(buffer, o + LOCAL_FILE_HEADER_FIXED, entry.nameBytes);
    writeBytes(buffer, o + LOCAL_FILE_HEADER_FIXED + entry.nameBytes.length, entry.data);
  }

  // ----- Central directory entries ------------------------------------
  let centralOffset = localSize;
  for (const entry of entries) {
    const o = centralOffset;
    writeU32(view, o + 0, CENTRAL_DIRECTORY_SIG);
    writeU16(view, o + 4, 0x033f); // version made by: 0x033f = UNIX, ZIP 6.3
    writeU16(view, o + 6, 20); // version needed to extract
    writeU16(view, o + 8, 0x0800); // general purpose bit flag (UTF-8 names)
    writeU16(view, o + 10, 0); // compression method: STORE
    writeU16(view, o + 12, dosTime);
    writeU16(view, o + 14, dosDate);
    writeU32(view, o + 16, entry.crc32);
    writeU32(view, o + 20, entry.data.length); // compressed size
    writeU32(view, o + 24, entry.data.length); // uncompressed size
    writeU16(view, o + 28, entry.nameBytes.length);
    writeU16(view, o + 30, 0); // extra field length
    writeU16(view, o + 32, 0); // file comment length
    writeU16(view, o + 34, 0); // disk number start
    writeU16(view, o + 36, 0); // internal file attributes
    writeU32(view, o + 38, 0); // external file attributes
    writeU32(view, o + 42, entry.offset); // relative offset of local header

    writeBytes(buffer, o + CENTRAL_DIRECTORY_FIXED, entry.nameBytes);

    centralOffset += CENTRAL_DIRECTORY_FIXED + entry.nameBytes.length;
  }

  // ----- End of central directory record ------------------------------
  const eo = localSize + centralSize;
  writeU32(view, eo + 0, END_OF_CENTRAL_DIRECTORY_SIG);
  writeU16(view, eo + 4, 0); // number of this disk
  writeU16(view, eo + 6, 0); // disk where central directory starts
  writeU16(view, eo + 8, entries.length); // number of central dir records on this disk
  writeU16(view, eo + 10, entries.length); // total number of central dir records
  writeU32(view, eo + 12, centralSize); // size of central directory
  writeU32(view, eo + 16, localSize); // offset of central directory
  writeU16(view, eo + 20, 0); // ZIP file comment length

  return buffer;
}

/**
 * Trigger a client-side download of `bytes` as `filename`.
 *
 * Mirror of `triggerDownload` for already-binary content. Wrapping in a Blob
 * with `application/zip` lets every browser tag the download correctly.
 */
function triggerBinaryDownload(bytes: Uint8Array, filename: string, mimeType: string): void {
  if (!isBrowser()) return;

  // Copy into a fresh ArrayBuffer so the Blob owns its bytes; `bytes.buffer`
  // may be a SharedArrayBuffer or a view over a larger pool in some hosts.
  const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
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

/**
 * Download the resume as a ZIP archive bundling the Markdown source, the
 * standalone HTML render, and the active theme's CSS (#35).
 *
 * The archive contains three files at its root:
 *   - `resume.md`            — the raw Markdown source.
 *   - `resume.html`          — the standalone, self-contained HTML render
 *                              (built via `buildStandaloneHtml`, so it
 *                              already embeds the theme and template).
 *   - `theme-<slug>.css`     — the active theme as a reusable CSS file.
 *
 * Filename: `<slug-from-name>-resume.zip`, e.g. `avery-quinn-resume.zip`.
 * No-ops outside the browser.
 *
 * Notes:
 *  - The ZIP uses the STORE method (no compression), so it is a touch
 *    larger than a DEFLATEd one but needs no compression dependency.
 *  - Filenames use forward slashes (none here — flat archive) and are
 *    UTF-8 encoded; the general-purpose bit 11 is set so the filename
 *    encoding is unambiguous.
 */
export function downloadResumeZip(
  markdown: string,
  resumeHtml: string,
  theme: ResumeTheme,
  frontmatter: ResumeFrontmatter,
  template: ResumeTemplate = DEFAULT_RESUME_TEMPLATE,
  mode: PrintMode = 'conservative',
): void {
  if (!isBrowser()) return;

  const standaloneHtml = buildStandaloneHtml(resumeHtml, theme, frontmatter, template, mode);
  const themeCss = themeCssVariables(theme);
  const themeFilename = `theme-${slugify(theme.slug)}.css`;

  const files = [
    { name: 'resume.md', data: encodeUtf8(markdown) },
    { name: 'resume.html', data: encodeUtf8(standaloneHtml) },
    { name: themeFilename, data: encodeUtf8(themeCss) },
  ];

  const zipBytes = buildStoreOnlyZip(files);
  const filename = `${slugify(frontmatter.name)}-resume.zip`;
  triggerBinaryDownload(zipBytes, filename, 'application/zip');
}
