/**
 * ExampleDialog — modal showing one section of the bundled sample resume
 * (#120).
 *
 * Context: the Resume Health panel's "Open an example" affordance (#115)
 * used to scroll the editor textarea to a named H2 in the WRITER's resume.
 * That works when the writer already has a Selected Impact / Summary /
 * Experience section — but on, say, a Junior resume that hasn't grown an
 * Experience block yet the button was a no-op (the panel hid it; the
 * finding still nagged with no way to actually see the example).
 *
 * This dialog is the fallback. When the writer's resume LACKS the section,
 * ResumeStudio opens this modal with the relevant section name; we slice
 * that section out of the bundled `public/sample-resume.md`, run it through
 * the same `parseResume` pipeline a real upload uses (DOMPurify owns the
 * trust boundary), and render the resulting HTML in a small dialog. The
 * writer gets a concrete "here's what we mean" view without us having to
 * mount the full faded-sample preview behind their loaded resume.
 *
 * Accessibility
 * -------------
 * Mirrors `KeyboardHelp.tsx`: `role="dialog"` + `aria-modal="true"`, an
 * `aria-labelledby` heading id, focus moves to the close button on open,
 * Tab/Shift+Tab cycle within the dialog, Esc closes, click-outside closes,
 * and focus returns to the originating button via the caller's onClose.
 *
 * Privacy / CSP
 * -------------
 * Static styling via CSS classes — no inline `style=` attributes (CSP:
 * `style-src` does not allow `'unsafe-inline'`). Nothing is persisted; the
 * dialog state is component-local. The sample resume markdown is fetched
 * once from the same origin (`BASE_URL/sample-resume.md`) — nothing leaves
 * the browser.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { parseResume } from '../utils/markdown';
import Icon from './Icon';

/** Selector matching every focusable element for the focus trap. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface ExampleDialogProps {
  /** Section name to show (matches an H2 in the bundled sample). */
  sectionTitle: string;
  /**
   * Pre-fetched sample-resume markdown, when the parent already has it
   * (FadedSamplePreview fetches it on mount for the empty-state preview;
   * threading the same string through avoids a second network round-trip).
   * When omitted, the dialog fetches it lazily.
   */
  sampleText?: string;
  /** Close request — Esc, click-outside, or the explicit close button. */
  onClose: () => void;
}

/**
 * Extract one H2 section from a Markdown source. Returns the heading line
 * plus every line up to (but not including) the next H2 or end-of-file.
 * Case-insensitive match on the heading text. Returns null when the section
 * is absent — the caller falls back to a friendly "section not found"
 * message rather than rendering an empty body.
 */
function sliceSection(markdown: string, sectionTitle: string): string | null {
  const want = sectionTitle.toLowerCase().trim();
  const lines = markdown.split('\n');
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const m = /^##\s+(?!#)(.+?)\s*$/.exec(lines[i]);
    if (!m) continue;
    if (start === -1) {
      if (m[1].toLowerCase().trim() === want) start = i;
    } else {
      end = i;
      break;
    }
  }
  if (start === -1) return null;
  return lines.slice(start, end).join('\n').trim();
}

export default function ExampleDialog({
  sectionTitle,
  sampleText: sampleTextProp,
  onClose,
}: ExampleDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  const descId = useId();

  /* ----- Lazy fetch of the bundled sample when the parent didn't supply it.
       Same source as FadedSamplePreview: `BASE_URL/sample-resume.md`. The
       fetch is fire-and-forget; a failure leaves `sampleText` null and the
       dialog renders the graceful "couldn't load the example" body. */
  const [sampleText, setSampleText] = useState<string | null>(sampleTextProp ?? null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    if (sampleText !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const base = import.meta.env.BASE_URL.replace(/\/?$/, '/');
        const response = await fetch(`${base}sample-resume.md`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        if (cancelled) return;
        setSampleText(text);
      } catch {
        if (!cancelled) setLoadFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sampleText]);

  /* ----- Slice + parse. parseResume runs the same pipeline a real upload
       takes (gray-matter → marked → DOMPurify), so the HTML rendered below
       is sanitized the same way ResumePreview's body is. */
  const sectionHtml = useMemo(() => {
    if (!sampleText) return null;
    const slice = sliceSection(sampleText, sectionTitle);
    if (!slice) return null;
    // The slice has no frontmatter; parseResume tolerates that (frontmatter
    // is optional). We only care about the rendered HTML body.
    const parsed = parseResume(slice);
    return parsed.html;
  }, [sampleText, sectionTitle]);

  /* On open: move focus to the Close button so keyboard users land inside. */
  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  /* Trap focus and handle Escape entirely within the dialog. Mirrors the
     KeyboardHelp pattern verbatim so behavior between the two app modals
     is identical. */
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

  /* Body content: one of three states.
       - HTML ready → render the sanitized slice.
       - Sample loaded but the section wasn't found → friendly note.
       - Sample fetch failed → friendly note.
       Loading state is silent (the dialog mounts already open; the fetch
       is fast — a flash of "loading…" reads worse than a brief blank). */
  let body: React.ReactNode;
  if (sectionHtml) {
    body = (
      <div
        className="health-example-dialog__body resume-preview"
        data-template="classic"
        /* `sectionHtml` is the output of parseResume() → DOMPurify, so it is
           safe to inject. ResumePreview uses the same contract. */
        dangerouslySetInnerHTML={{ __html: sectionHtml }}
      />
    );
  } else if (loadFailed) {
    body = (
      <p className="health-example-dialog__fallback">
        Couldn&rsquo;t load the bundled example. Try again, or open the sample resume from the
        editor pane.
      </p>
    );
  } else if (sampleText !== null) {
    body = (
      <p className="health-example-dialog__fallback">
        The bundled sample doesn&rsquo;t have a {sectionTitle} section. You can model your own after
        the rest of the sample resume.
      </p>
    );
  } else {
    /* Brief, polite loading state. Live region wording is intentional —
       AT users hear "Loading example…" rather than nothing. */
    body = (
      <p className="health-example-dialog__fallback" aria-live="polite">
        Loading example&hellip;
      </p>
    );
  }

  return (
    <div className="health-example-dialog__overlay" onPointerDown={onClose}>
      <div
        ref={dialogRef}
        className="health-example-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={descId}
        onKeyDown={handleKeyDown}
        /* Clicks inside must not bubble to the overlay's dismiss handler. */
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="health-example-dialog__header">
          <h2 id={headingId} className="health-example-dialog__title">
            Example: {sectionTitle}
          </h2>
          <button
            type="button"
            ref={closeButtonRef}
            className="btn btn--ghost btn--icon"
            onClick={onClose}
            aria-label="Close example"
          >
            <Icon name="close" />
          </button>
        </div>

        <p id={descId} className="health-example-dialog__intro">
          From the bundled sample resume. Your resume doesn&rsquo;t have a {sectionTitle} section
          yet — here&rsquo;s a worked example of the pattern.
        </p>

        {body}
      </div>
    </div>
  );
}
