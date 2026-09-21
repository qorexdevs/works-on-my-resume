/**
 * FormatDocsDialog — in-app Markdown spec / format reference modal (#157).
 *
 * Why this exists. The app accepts a specific Markdown shape (frontmatter +
 * canonical H2 sections + H3 role headings + `-` bullets), and that shape
 * is the contract every other piece of UI silently relies on — Resume
 * Health's rubric looks for `Summary` / `Experience` / `Education` /
 * `Skills`, ExampleDialog slices on H2 names, the template seeds and
 * frontmatter-warnings nudge keys it recognises. Until now a new writer
 * had to infer all of that from the sample resume by reading it. This
 * dialog is the single explicit reference: one paragraph of how-it-works,
 * the frontmatter contract, the section vocabulary, an LLM-handoff prompt
 * with a copy-to-clipboard button, and a one-line privacy reminder. It is
 * accessible from the Settings drawer's Help group (#128).
 *
 * Accessibility
 * -------------
 * Mirrors `ExampleDialog.tsx` / `KeyboardHelp.tsx` verbatim so the three
 * app modals behave identically from a keyboard user's perspective:
 *   - `role="dialog"` + `aria-modal="true"` + `aria-labelledby` heading id.
 *   - Focus moves to the close button on open; Tab/Shift+Tab cycle within
 *     the dialog; Esc closes; click outside closes.
 *   - The caller restores focus to the trigger when the dialog unmounts
 *     (SettingsDrawer-side concern, same as KeyboardHelp).
 *
 * CSP
 * ---
 * No inline `style={...}` attributes. All visuals live in global.css under
 * `.format-docs*`. The content of every section is a literal JSX string —
 * no fetched documentation, no dangerous HTML — so we render plain text
 * with hand-placed `<strong>` and `<code>` rather than running it through
 * the DOMPurify pipeline ResumePreview uses (the pipeline is the right
 * choice for untrusted markdown; here the content is trusted source code).
 *
 * Privacy
 * -------
 * The dialog state is component-local and nothing is persisted. The copy
 * button uses `navigator.clipboard.writeText()` — same API and degraded-
 * fallback (`window.prompt`) as ExportPanel's "Copy theme link" (#79).
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import Icon from './Icon';

/** Selector matching every focusable element for the focus trap. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The literal LLM-handoff prompt. Kept as a top-level constant so the e2e
 * suite can assert on it without importing the component module (the
 * Playwright tests can match against the visible <pre> text, but the
 * `Copy to clipboard` assertion needs the exact string the button writes).
 *
 * Intentionally NOT exported — the tests assert via the visible DOM, not
 * by importing the constant. Defined up here for clarity.
 */
const LLM_HANDOFF_PROMPT = `Here's my resume in Works on My Resume markdown format. Refine the language while keeping the structure exact:

---
name: Your Name
role: Your Current Title
location: City, ST
email: you@example.com
phone: +1 555 555 0100
links:
  - label: GitHub
    url: https://github.com/you
---

## Summary

One short paragraph.

## Experience

### Role — Company (YYYY–YYYY)
- Bullet
- Bullet

## Education

### Degree — Institution (YYYY)

## Skills

- Skill, Skill, Skill

[paste your resume here]`;

interface FormatDocsDialogProps {
  /** Close request — Esc, click-outside, or the explicit close button. */
  onClose: () => void;
}

/**
 * One row in the frontmatter-keys table. The key is rendered as a `<code>`,
 * the description is plain prose, the inline example is a `<code>` too.
 * Pulled out into a tiny component because we render five of these and the
 * inline JSX got noisy.
 */
function FrontmatterRow({
  field,
  description,
  example,
}: {
  field: string;
  description: string;
  example: string;
}) {
  return (
    <li className="format-docs__fm-row">
      <code className="format-docs__fm-key">{field}</code>
      <span className="format-docs__fm-desc">{description}</span>
      <code className="format-docs__fm-example">{example}</code>
    </li>
  );
}

export default function FormatDocsDialog({ onClose }: FormatDocsDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  const descId = useId();

  /* Copy-confirmation pip. Auto-clears after 2 s — same UX as ExportPanel's
     "Copy theme link" (#79) so the two affordances feel identical. */
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  const copyPrompt = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(LLM_HANDOFF_PROMPT);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable or denied — degrade to a prompt so the
      // user can still copy the text manually. Mirrors ExportPanel.
      window.prompt('Copy this prompt:', LLM_HANDOFF_PROMPT);
    }
  }, []);

  /* On open: move focus to the Close button so keyboard users land inside. */
  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  /* Trap focus and handle Escape entirely within the dialog. Mirrors the
     ExampleDialog pattern verbatim — see the comment there for the rationale
     on the offsetParent filter (skips hidden focusables without confusing
     the active-element fallback). */
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const root = dialogRef.current;
      if (!root) return;
      const focusable = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first || !root.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  return (
    <div className="format-docs__overlay" onPointerDown={onClose}>
      <div
        ref={dialogRef}
        className="format-docs"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={descId}
        onKeyDown={handleKeyDown}
        /* Clicks inside must not bubble to the overlay's dismiss handler. */
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="format-docs__header">
          <h2 id={headingId} className="format-docs__title">
            Markdown format
          </h2>
          <button
            type="button"
            ref={closeButtonRef}
            className="btn btn--ghost btn--icon"
            onClick={onClose}
            aria-label="Close markdown format reference"
          >
            <Icon name="close" />
          </button>
        </div>

        {/* ----- 1. What + how (one paragraph) ----- */}
        <p id={descId} className="format-docs__intro">
          Write your resume in Markdown. We render it, we don&rsquo;t store it. Frontmatter at the
          top, <code>##</code> for sections, <code>###</code> for roles, <code>-</code> for bullets.
        </p>

        {/* ----- 2. Frontmatter contract ----- */}
        <section className="format-docs__section" aria-labelledby={`${headingId}-fm`}>
          <h3 id={`${headingId}-fm`} className="format-docs__section-title section-kicker">
            Frontmatter
          </h3>
          <p className="format-docs__section-intro">
            A YAML block fenced by <code>---</code> at the very top of the file. Every key is
            optional, but supplying them lets the renderer build the contact header and the link
            chips.
          </p>
          <ul className="format-docs__fm-list">
            <FrontmatterRow field="name" description="Display name." example="Avery Quinn" />
            <FrontmatterRow
              field="role"
              description="Current title — sits under the name."
              example="Staff Engineer"
            />
            <FrontmatterRow
              field="location"
              description="Free-text locale."
              example="Brooklyn, NY"
            />
            <FrontmatterRow
              field="email"
              description="Rendered as a mailto link."
              example="avery@example.com"
            />
            <FrontmatterRow
              field="phone"
              description="Plain text — no auto-linking."
              example="+1 555 555 0100"
            />
            <FrontmatterRow
              field="links[]"
              description="Each item is { label, url }; rendered as chips."
              example="- label: GitHub\n  url: https://github.com/you"
            />
          </ul>
        </section>

        {/* ----- 3. Section vocabulary ----- */}
        <section className="format-docs__section" aria-labelledby={`${headingId}-sections`}>
          <h3 id={`${headingId}-sections`} className="format-docs__section-title section-kicker">
            Sections
          </h3>
          <p className="format-docs__section-intro">
            Sections are <code>##</code> headings. Any name works, but the Resume Health rubric
            recognises these four by name:
          </p>
          <ul className="format-docs__section-list">
            <li>
              <strong>Summary</strong> — a short paragraph at the top.
            </li>
            <li>
              <strong>Experience</strong> — roles as <code>###</code> headings followed by{' '}
              <code>-</code> bullets.
            </li>
            <li>
              <strong>Education</strong> — degrees as <code>###</code> headings.
            </li>
            <li>
              <strong>Skills</strong> — comma-separated lists or bullets.
            </li>
          </ul>
          <p className="format-docs__hint">
            Other sections (Projects, Certifications, Publications, &hellip;) render fine — the
            rubric just doesn&rsquo;t score them.
          </p>
        </section>

        {/* ----- 4. LLM handoff prompt ----- */}
        <section className="format-docs__section" aria-labelledby={`${headingId}-llm`}>
          <h3 id={`${headingId}-llm`} className="format-docs__section-title section-kicker">
            LLM handoff
          </h3>
          <p className="format-docs__section-intro">
            Paste this prompt into your model of choice with your existing resume appended. The
            scaffold keeps the section vocabulary the renderer expects.
          </p>
          <pre className="format-docs__prompt" aria-label="LLM handoff prompt">
            {LLM_HANDOFF_PROMPT}
          </pre>
          <div className="format-docs__prompt-actions">
            <button type="button" className="btn" onClick={copyPrompt}>
              <Icon name={copied ? 'check' : 'file'} size={14} />
              {copied ? 'Copied' : 'Copy to clipboard'}
            </button>
            <span className="format-docs__prompt-status" aria-live="polite" aria-atomic="true">
              {copied ? 'Prompt copied to clipboard.' : ''}
            </span>
          </div>
        </section>

        {/* ----- 5. Privacy reminder ----- */}
        <p className="format-docs__privacy">
          All processing happens locally. The app does not send resume content anywhere.
        </p>
      </div>
    </div>
  );
}
