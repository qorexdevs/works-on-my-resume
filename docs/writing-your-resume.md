# Writing your resume

A practical guide to authoring a resume for **Works on My Resume**. You write
plain Markdown; the app parses it, renders it, themes it, and lets you print or
export it — all in your browser.

If you would rather learn by example, open `public/sample-resume.md` (the
"Load sample" button in the app loads exactly this file). It is the
recommended structure in practice; this guide explains the reasoning behind it.

---

## The big picture

A resume here is a single Markdown file with two parts:

1. **Optional YAML frontmatter** — a small block at the very top that holds
   your identity (name, role, contact details, links).
2. **The Markdown body** — your summary, experience, skills, education, and
   anything else, written with ordinary Markdown headings and lists.

Both parts are optional, but the recommended structure uses frontmatter for
identity and the body for everything else. Here is why that split matters.

---

## Frontmatter: your identity header

Frontmatter is a block fenced by `---` lines at the **very top** of the file:

```markdown
---
name: Avery Quinn
role: Senior Platform Engineer
location: Portland, OR
email: avery.quinn@example.com
phone: +1 (503) 555-0142
links:
  - label: LinkedIn
    url: https://www.linkedin.com/in/avery-quinn-example
  - label: GitHub
    url: https://github.com/avery-quinn-example
  - label: Website
    url: https://avery-quinn.example.com
---
```

The app reads these fields and renders them as a canonical **identity header**
at the top of the resume — your name, then your role, then a single contact
line joining location, email, phone, and links with `·` separators.

### Supported fields

All fields are optional. Include only what you want shown.

| Field      | Type | Notes                                                |
| ---------- | ---- | ---------------------------------------------------- |
| `name`     | text | Rendered as the largest line of the identity header. |
| `role`     | text | Your title or tagline, shown under the name.         |
| `location` | text | First item in the contact line.                      |
| `email`    | text | Rendered as a `mailto:` link.                        |
| `phone`    | text | Shown as plain text.                                 |
| `links`    | list | A list of labelled URLs (see below).                 |

`links` is a list. The standard form is a label/url pair per entry:

```yaml
links:
  - label: GitHub
    url: https://github.com/your-handle
```

A terse single-pair form also works — the key becomes the label:

```yaml
links:
  - GitHub: https://github.com/your-handle
```

External `http(s)` links open in a new tab. Link URLs should be `http(s)`,
`mailto:`, or relative paths; anything else triggers a friendly warning.

### Don't repeat your name and role in the body

Because frontmatter already produces the identity header, **do not start the
body with a `# Name` heading or a role tagline.** Doing so prints your name
twice.

The app does guard against this — when frontmatter supplies a name, a leading
body `<h1>` (and a short role paragraph right after it) is dropped before
rendering — but the cleanest approach is simply not to write it. The bundled
sample (`public/sample-resume.md`) follows this: its frontmatter carries the
identity, and the body starts straight into `## Summary`.

### When fields look wrong

Frontmatter validation is non-blocking. If a known field looks mistyped — an
`email` with no `@`, a `links` value that is not a list, or an unknown key that
resembles a known one (`naem` → `name`) — the app shows a gentle warning above
the preview but still renders everything. Unknown fields are allowed and never
warned about. Malformed YAML degrades to "no frontmatter" plus a warning,
rather than breaking the render.

---

## Body structure

The body is ordinary Markdown. A clear, conventional structure reads best.

### Sections

Use `##` headings for top-level sections, and `###` for entries inside a
section. A common layout:

```markdown
## Summary

A short paragraph on who you are and what you do.

## Experience

### Senior Platform Engineer — Northwind Logistics

_Mar 2021 – Present · Portland, OR (remote)_

- A bullet describing impact, ideally with a number.
- Another bullet.

## Skills

## Education
```

Pick the sections that fit you — Summary, Experience, Skills, Education,
Projects, Writing, and so on. There is no fixed schema; the headings are yours.

### Job entries that read well

A job entry reads cleanly as three parts:

1. A `###` heading: your title and the company.
2. An **italic line** for the date range and location, e.g.
   `_Mar 2021 – Present · Portland, OR_`. Italics set it apart from body text
   without shouting.
3. **Bullets** describing what you did and the impact you had. Lead with a
   result; numbers help.

The bundled sample uses exactly this pattern for every role and degree.

---

## Supported Markdown

Rendering uses GitHub Flavored Markdown (GFM). The following all work:

- **Headings** — `#` through `######`.
- **Bold** and _italic_ — `**bold**`, `_italic_`, and `~~strikethrough~~`.
- **Links** — `[label](https://example.com)`.
- **Lists** — unordered (`-`), ordered (`1.`), and nested lists.
- **Blockquotes** — lines beginning with `>`. Good for a one-line motto.
- **Horizontal rules** — `---` on its own line (a divider, e.g. before a
  closing "references available on request" note).
- **Inline code** and code blocks — backticks for `inline code`, fenced blocks
  for longer snippets. Also `<kbd>` and `<samp>` if you reach for them.
- **Tables** — GFM pipe tables, handy for a Skills matrix.
- Images via standard `![alt](url)` — only ordinary web images and raster
  `data:` image URIs are kept.

### What gets removed, and why

Your Markdown is treated as **untrusted input**. After rendering, the HTML is
run through a sanitizer before it ever reaches the page. The sanitizer strips:

- **Raw HTML tags** like `<script>`, `<iframe>`, `<object>`, `<embed>`,
  `<form>`, `<input>`, and `<button>`.
- **Inline event handlers** such as `onclick` or `onerror`.
- **Inline `style` attributes** — you cannot hand-style the resume from the
  Markdown; styling comes from themes.
- **`javascript:` URLs** and other non-web URL schemes.
- **SVG and non-image `data:` URIs** in image sources.

This keeps a copied-from-anywhere resume safe to render, and it keeps your
output portable. If anything was stripped, the app tells you with a warning
above the preview. The practical takeaway: write content in Markdown, and let
themes handle appearance — don't reach for raw HTML.

---

## Themes and printing

### Themes

The app ships 465 color themes. **Themes only affect appearance** — they never
change your content or structure. Cycle them with the on-screen controls or the
arrow keys; pick one with a `/` search.

Each theme reports a body-text **contrast ratio**, shown as a badge next to
the theme name. Every shipped theme clears the 7:1 **resume-safe** threshold,
which guarantees comfortably readable text — pick whichever you like.

### Printing and exporting

Print or "Save as PDF" through the Export panel (or the `p` shortcut). There
are two print modes:

- **Conservative (default)** — white paper, black ink, no decorative color.
  This is the best choice for printing and for applicant tracking systems
  (ATS): it is ink-friendly and maximally legible.
- **Current theme** — prints using the active theme's colors. Nice for a
  digital PDF you are sending directly to a human.

When in doubt, use Conservative. The print stylesheet also hides all app chrome
and only prints the resume itself, with letter-size margins and sensible page
breaks.

You can also export the raw Markdown (`.md`), a fully self-contained standalone
HTML file (`.html`), or just the active theme as a `.css` file.

---

## Privacy

Everything above happens locally. Your resume is parsed, rendered, and exported
**entirely in the browser** — there is no server, no account, and nothing is
uploaded. Shareable theme links carry only the theme slug, never your content.

---

## Quick checklist

- [ ] Frontmatter at the top with `name`, `role`, and the contact fields you
      want shown.
- [ ] Body does **not** repeat your name or role as a heading.
- [ ] `##` for sections, `###` for job and degree entries.
- [ ] Each entry: heading + an _italic date/location line_ + bullets.
- [ ] No raw HTML — it will be stripped.
- [ ] Print in Conservative mode for ATS.
