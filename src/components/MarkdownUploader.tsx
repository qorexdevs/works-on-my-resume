/**
 * MarkdownUploader — gets resume Markdown into the app.
 *
 * Five input paths, four fully local + one explicit network call:
 *   1. A native file <input> (.md / .markdown / .txt).
 *   2. A drag-and-drop zone over that input.
 *   3. A "Load sample" button that fetches the bundled sample resume — a
 *      same-origin static asset.
 *   4. "Import JSON Resume" — picks a local `.json` file and converts it
 *      via `fromJsonResume`. Fully local; no network.
 *   5. "Import from Gist" — the one deliberate network call in the whole
 *      app. ONLY triggered when the user pastes a gist URL and clicks
 *      Import. Clearly disclosed at the input.
 *
 * Two-phase affordance (#51): with no resume loaded the dropzone is the hero
 * — a large drop target with the secondary import affordances tucked below.
 * Once a resume IS loaded it collapses to a compact one-line bar with
 * Replace-file and Clear actions, so the chrome no longer dominates.
 *
 * Validation is forgiving: an unknown file type or read failure produces a
 * clear error; an oversized file produces a non-blocking warning but still
 * loads. Browsers without the File API degrade to a plain message.
 */
import {
  forwardRef,
  useCallback,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import Icon from './Icon';
import { fromJsonResume } from '../utils/jsonresume';
import { fetchGistFiles, isGistUrl, type GistFile } from '../utils/gist';
import TemplatePicker, { type TemplateSlug } from './TemplatePicker';

/** Files larger than this trigger a soft warning (not a hard failure). */
const SOFT_SIZE_LIMIT = 1024 * 1024; // 1 MB
const ACCEPT = '.md,.markdown,.txt';
const ACCEPTED_EXTENSIONS = ['.md', '.markdown', '.txt'];
const JSON_ACCEPT = '.json,application/json';

interface MarkdownUploaderProps {
  /** Called with the resume text once it has been read locally. */
  onLoad: (text: string, sourceName: string) => void;
  /** Whether a resume is currently loaded — drives the collapsed affordance. */
  hasResume: boolean;
  /** Line count of the current resume, shown in the collapsed bar. */
  lineCount: number;
  /** Name of the current source file (e.g. "resume.md"). */
  sourceName: string;
  /** Clear the current resume and return to the empty state. */
  onClear: () => void;
}

/**
 * Imperative handle exposed via the `ref` prop (#138).
 *
 * Lets callers open the underlying file picker from outside the
 * component. Used by `MarkdownEditor`'s tab strip "Replace file"
 * button so the affordance can move into the tab strip without
 * duplicating the file-input plumbing. The uploader keeps owning
 * the hidden input + the read/parse pipeline; only the trigger
 * surface moves.
 */
export interface MarkdownUploaderHandle {
  /** Open the system file picker for replacing the current resume file. */
  openReplaceDialog(): void;
}

/** Maximum lines of gist content surfaced in the preview card (#68). */
const GIST_PREVIEW_LINES = 10;

/**
 * Build the human-readable preview snippet: the first N lines of the
 * picked gist file. Rendered as plain text (NOT as Markdown) so a malicious
 * gist cannot inject anything dangerous into the preview region.
 */
function gistPreviewSnippet(markdown: string): string {
  if (markdown.length === 0) return '';
  const lines = markdown.split('\n');
  const head = lines.slice(0, GIST_PREVIEW_LINES).join('\n');
  return lines.length > GIST_PREVIEW_LINES ? `${head}\n…` : head;
}

/** True when the browser exposes the File / FileReader APIs we rely on. */
function hasFileApi(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.File !== 'undefined' &&
    typeof window.FileReader !== 'undefined'
  );
}

function hasAcceptedExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function MarkdownUploaderImpl(
  { onLoad, hasResume, lineCount, sourceName, onClear }: MarkdownUploaderProps,
  ref: React.Ref<MarkdownUploaderHandle>,
) {
  const inputId = useId();
  const jsonInputId = useId();
  const gistInputId = useId();
  const gistDisclosureId = useId();
  const gistPreviewId = useId();
  const gistPickerId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const jsonInputRef = useRef<HTMLInputElement>(null);
  const gistDetailsRef = useRef<HTMLDetailsElement>(null);
  /* The "Start from a template" trigger ref — used to restore focus to the
     button after the TemplatePicker modal closes. The picker owns its own
     focus trap; we own the restore. */
  const templateTriggerRef = useRef<HTMLButtonElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isLoadingSample, setIsLoadingSample] = useState(false);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [isLoadingTemplate, setIsLoadingTemplate] = useState(false);
  const [gistUrl, setGistUrl] = useState('');
  const [isFetchingGist, setIsFetchingGist] = useState(false);
  /* Preview before commit (#68, #76). Holds every file in the fetched
     gist plus the index currently chosen for preview/commit. `onLoad` is
     only called when the user clicks "Use this" with the active index.
     The form remains visible underneath so cancelling drops the user
     back at the URL field with the value intact. */
  const [gistPreview, setGistPreview] = useState<{
    files: GistFile[];
    selectedIndex: number;
  } | null>(null);

  const fileApiAvailable = hasFileApi();

  /** Read one dropped/picked file as text and hand it upstream. */
  const readFile = useCallback(
    (file: File) => {
      setError(null);
      setNotice(null);

      if (!hasAcceptedExtension(file.name)) {
        setError(`"${file.name}" is not a supported file. Use a .md, .markdown, or .txt file.`);
        return;
      }

      if (file.size > SOFT_SIZE_LIMIT) {
        setNotice(
          `That file is larger than 1 MB — it should still work, but resumes are usually much smaller.`,
        );
      }

      const reader = new FileReader();
      reader.onerror = () => {
        setError(`Could not read "${file.name}". Please try again.`);
      };
      reader.onload = () => {
        const text = reader.result;
        if (typeof text !== 'string') {
          setError(`Could not read "${file.name}" as text.`);
          return;
        }
        onLoad(text, file.name);
      };
      reader.readAsText(file);
    },
    [onLoad],
  );

  /**
   * Read a JSON Resume file: parse, convert via `fromJsonResume`, surface
   * any warnings (non-blocking) and load the synthesized Markdown.
   */
  const readJsonResume = useCallback(
    (file: File) => {
      setError(null);
      setNotice(null);

      if (!/\.json$/i.test(file.name) && file.type && !file.type.includes('json')) {
        setError(`"${file.name}" does not look like a JSON Resume (.json) file.`);
        return;
      }

      const reader = new FileReader();
      reader.onerror = () => setError(`Could not read "${file.name}". Please try again.`);
      reader.onload = () => {
        const text = reader.result;
        if (typeof text !== 'string') {
          setError(`Could not read "${file.name}" as text.`);
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          setError(`"${file.name}" is not valid JSON.`);
          return;
        }
        const { markdown, warnings } = fromJsonResume(parsed);
        if (markdown.length === 0) {
          setError(warnings[0] ?? 'That JSON file did not look like a JSON Resume document.');
          return;
        }
        if (warnings.length > 0) {
          // Surface up to two warnings inline; the rest are unlikely to matter.
          const head = warnings.slice(0, 2).join(' ');
          const more = warnings.length > 2 ? ` (+${warnings.length - 2} more)` : '';
          setNotice(`Imported with warnings — ${head}${more}`);
        }
        // Replace the .json with .md so the filename chip stays sensible.
        const baseName = file.name.replace(/\.json$/i, '.md');
        onLoad(markdown, baseName);
      };
      reader.readAsText(file);
    },
    [onLoad],
  );

  const handleInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) readFile(file);
      // Reset so picking the same file again still fires `change`.
      event.target.value = '';
    },
    [readFile],
  );

  const handleJsonInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) readJsonResume(file);
      event.target.value = '';
    },
    [readJsonResume],
  );

  /* Imperative handle (#138): open the underlying file picker from outside
     the component so the editor tab strip's "Replace file" button works
     without duplicating the file-input plumbing. Clicking the hidden
     <input> is the same path the native <label htmlFor> took before. */
  useImperativeHandle(
    ref,
    () => ({
      openReplaceDialog() {
        fileInputRef.current?.click();
      },
    }),
    [],
  );

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDragging(false);
      const file = event.dataTransfer.files?.[0];
      if (!file) return;
      // Allow dropping a JSON Resume too — convenient and unsurprising.
      if (/\.json$/i.test(file.name)) {
        readJsonResume(file);
      } else {
        readFile(file);
      }
    },
    [readFile, readJsonResume],
  );

  /** Load the bundled sample resume — a same-origin static asset. */
  const loadSample = useCallback(async () => {
    setError(null);
    setNotice(null);
    setIsLoadingSample(true);
    try {
      // BASE_URL may or may not carry a trailing slash depending on the
      // Astro `base` config; normalize to exactly one before joining.
      const base = import.meta.env.BASE_URL.replace(/\/?$/, '/');
      const url = `${base}sample-resume.md`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const text = await response.text();
      onLoad(text, 'sample-resume.md');
    } catch {
      setError('Could not load the sample resume. Please try again.');
    } finally {
      setIsLoadingSample(false);
    }
  }, [onLoad]);

  /**
   * Close the template picker and restore focus to the trigger that opened
   * it. Deferred to next tick so the dialog has finished unmounting before
   * focus moves — matches the KeyboardHelp/ExportPanel restore pattern.
   */
  const closeTemplatePicker = useCallback(() => {
    setTemplatePickerOpen(false);
    window.setTimeout(() => templateTriggerRef.current?.focus(), 0);
  }, []);

  /**
   * Load the picked starter template (#86). Fetches the same-origin
   * `public/templates/<slug>.md` and hands it to `onLoad` — using the same
   * commit path as "Load sample" so the announcement, draft-overwrite
   * toast, and source-name chip all work without special-casing.
   *
   * On success the picker closes (and focus is restored). On failure we
   * leave the picker open so the user can pick a different one without
   * having to re-open the modal — the error notice surfaces beneath the
   * dropzone, where the rest of the uploader's errors live.
   */
  const handleTemplateSelect = useCallback(
    async (slug: TemplateSlug) => {
      setError(null);
      setNotice(null);
      setIsLoadingTemplate(true);
      try {
        // BASE_URL may or may not carry a trailing slash depending on the
        // Astro `base` config; normalize to exactly one before joining.
        const base = import.meta.env.BASE_URL.replace(/\/?$/, '/');
        const url = `${base}templates/${slug}.md`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        onLoad(text, `${slug}.md`);
        closeTemplatePicker();
      } catch {
        setError('Could not load the template. Please try again.');
      } finally {
        setIsLoadingTemplate(false);
      }
    },
    [onLoad, closeTemplatePicker],
  );

  /**
   * Fetch the gist the user just pasted. This is the SINGLE deliberate
   * network call this app makes; it sends no resume content outbound and
   * requires no auth. The CSP in BaseLayout.astro grants `api.github.com`
   * exactly for this path.
   *
   * Behaviour (#68, #76): on success we DO NOT commit the gist to the
   * editor — we stash every file in `gistPreview` together with the
   * heuristic-picked default index, and let the user inspect (and, for
   * multi-file gists, switch between) the candidates before deciding to
   * keep or cancel. Switching files in the picker is purely a state
   * update — there is no second network call.
   */
  const importFromGist = useCallback(async () => {
    setError(null);
    setNotice(null);
    setGistPreview(null);
    const url = gistUrl.trim();
    if (url.length === 0) {
      setError('Paste a Gist URL first — for example https://gist.github.com/you/abcdef…');
      return;
    }
    if (!isGistUrl(url)) {
      setError("That doesn't look like a Gist URL. Expected https://gist.github.com/…");
      return;
    }
    setIsFetchingGist(true);
    try {
      const { files, defaultIndex } = await fetchGistFiles(url);
      setGistPreview({ files, selectedIndex: defaultIndex });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not import the Gist.');
    } finally {
      setIsFetchingGist(false);
    }
  }, [gistUrl]);

  const handleGistSubmit = useCallback(
    (event: React.SyntheticEvent<HTMLFormElement>) => {
      event.preventDefault();
      void importFromGist();
    },
    [importFromGist],
  );

  /**
   * Commit the CURRENTLY-selected file (not necessarily the heuristic
   * default) — hand it upstream and reset the preview. Empty content
   * shouldn't be reachable in practice (`fetchGistFiles` errors out if
   * the default candidate has no body), but a multi-file gist could
   * legitimately contain an empty companion file, so we guard explicitly.
   */
  const commitGistPreview = useCallback(() => {
    if (!gistPreview) return;
    const picked = gistPreview.files[gistPreview.selectedIndex];
    if (!picked) return;
    if (picked.truncated) {
      setError('That file is too large to import via the API. Try downloading it manually.');
      return;
    }
    if (picked.content.length === 0) {
      setError('That file is empty — pick another file from the Gist.');
      return;
    }
    onLoad(picked.content, picked.filename || 'gist.md');
    setGistPreview(null);
    setGistUrl('');
  }, [gistPreview, onLoad]);

  /** Drop the previewed gist — returns the user to the URL input. */
  const cancelGistPreview = useCallback(() => {
    setGistPreview(null);
  }, []);

  /**
   * Switch which file the preview is showing. Pure state update — no
   * re-fetch. Ignored if the index is out of range (defensive: the
   * `<select>` only emits valid indices, but the typed handler reads a
   * string off the DOM, so bounds-check anyway).
   */
  const selectGistFile = useCallback((index: number) => {
    setGistPreview((prev) => {
      if (!prev) return prev;
      if (index < 0 || index >= prev.files.length) return prev;
      return { ...prev, selectedIndex: index };
    });
  }, []);

  /**
   * Escape inside the gist disclosure cancels a pending preview, or — if
   * no preview is open — closes the disclosure itself. Real `<details>`
   * doesn't natively respond to Escape, so we wire it up here.
   */
  const handleGistKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key !== 'Escape') return;
      if (gistPreview) {
        event.preventDefault();
        event.stopPropagation();
        cancelGistPreview();
        return;
      }
      const details = gistDetailsRef.current;
      if (details && details.open) {
        event.preventDefault();
        event.stopPropagation();
        details.open = false;
      }
    },
    [gistPreview, cancelGistPreview],
  );

  /* The Phase 2 "Clear" button moved into the editor's tab strip (#138).
     `onClear` is invoked there directly; the uploader simply clears its
     own pending error/notice on the next load. Kept on the props
     contract because the empty Phase 1 view still expects a way to
     refer back to the studio's clear handler (currently unused, but
     stable so the parent doesn't need a special-case wiring). */
  void onClear;

  /* The shared, visually-hidden file inputs — referenced from both phases.
     Phase 1 still wraps the visible "Pick a file" label around this input
     (the `<label htmlFor={inputId}>`), so axe is happy there. Phase 2
     used to ride on the now-removed "Replace file" label inside the
     collapsed bar; with that label gone (#138 — Replace file moved into
     the editor tab strip and triggers `openReplaceDialog()` instead),
     axe correctly flags the bare hidden input. An `aria-label` on the
     input gives it an accessible name without re-mounting a visible
     label that we deliberately don't want in either phase. */
  const fileInput = (
    <input
      ref={fileInputRef}
      id={inputId}
      className="visually-hidden"
      type="file"
      accept={ACCEPT}
      aria-label="Replace resume file"
      onChange={handleInputChange}
    />
  );

  const jsonFileInput = (
    <input
      ref={jsonInputRef}
      id={jsonInputId}
      className="visually-hidden"
      type="file"
      accept={JSON_ACCEPT}
      onChange={handleJsonInputChange}
    />
  );

  /* Errors / notices, shared by both phases. */
  const messages = (
    <>
      {error && (
        <p className="uploader__error" role="alert">
          <Icon name="alert" size={15} />
          <span>{error}</span>
        </p>
      )}
      {notice && (
        <p className="uploader__notice" role="status">
          <Icon name="info" size={15} />
          <span>{notice}</span>
        </p>
      )}
    </>
  );

  /* ----- Phase 2: a resume is loaded.
     The filename + line count + Replace + Clear affordances moved into
     the editor's document tab strip (#138). The uploader still mounts
     its hidden file <input> so the tab strip's "Replace file" button
     can drive it through `openReplaceDialog()`, and it still surfaces
     any error / notice messages from a failed upload — the user
     interaction stays here, just without the visible filename bar. */
  if (hasResume) {
    // sourceName + lineCount are intentionally unused in this branch — kept on
    // the props contract for SSR-stable typing and so the editor tab strip and
    // the uploader read the same source-of-truth from the parent.
    void sourceName;
    void lineCount;
    return (
      <div className="uploader uploader--phase2">
        {fileInput}
        {messages}
      </div>
    );
  }

  /* ----- Phase 1: nothing loaded — the dropzone is the hero. ----- */
  return (
    <div className="uploader">
      {fileApiAvailable ? (
        <div
          className={
            isDragging ? 'uploader__dropzone uploader__dropzone--active' : 'uploader__dropzone'
          }
          onDragOver={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
        >
          <span className="uploader__dropzone-glyph" aria-hidden="true">
            <Icon name="file" size={28} />
          </span>
          <span className="uploader__dropzone-title">Drop a Markdown file here</span>
          <span>or pick one — nothing leaves your browser.</span>
          <div className="uploader__actions">
            <label className="btn btn--primary" htmlFor={inputId}>
              Choose file
            </label>
            {fileInput}
            <button type="button" className="btn" onClick={loadSample} disabled={isLoadingSample}>
              {isLoadingSample ? 'Loading sample…' : 'Load sample'}
            </button>
            <button
              type="button"
              ref={templateTriggerRef}
              className="btn"
              aria-haspopup="dialog"
              aria-expanded={templatePickerOpen}
              onClick={() => setTemplatePickerOpen(true)}
              disabled={isLoadingTemplate}
            >
              {isLoadingTemplate ? 'Loading template…' : 'Start from a template'}
            </button>
            <label className="btn" htmlFor={jsonInputId}>
              Import JSON Resume
            </label>
            {jsonFileInput}
          </div>
        </div>
      ) : (
        <div className="uploader__notice" role="status">
          <Icon name="info" size={15} />
          <span>
            This browser does not support local file uploads. You can still paste your resume
            Markdown directly into the editor below, or load the sample.
            <span className="uploader__actions">
              <button type="button" className="btn" onClick={loadSample} disabled={isLoadingSample}>
                {isLoadingSample ? 'Loading sample…' : 'Load sample'}
              </button>
            </span>
          </span>
        </div>
      )}

      {/* ----- Optional: import from a public GitHub Gist (#33, #68) ----- */}
      <details className="uploader__gist" ref={gistDetailsRef} onKeyDown={handleGistKeyDown}>
        <summary className="uploader__gist-summary">Import from a public GitHub Gist</summary>
        <form className="uploader__gist-form" onSubmit={handleGistSubmit}>
          <label htmlFor={gistInputId} className="uploader__gist-label">
            Gist URL
          </label>
          <div className="uploader__gist-row">
            <input
              id={gistInputId}
              className="text-input uploader__gist-input"
              type="url"
              inputMode="url"
              placeholder="https://gist.github.com/you/abc123…"
              value={gistUrl}
              onChange={(event) => setGistUrl(event.target.value)}
              aria-describedby={gistDisclosureId}
              disabled={isFetchingGist || gistPreview !== null}
            />
            <button
              type="submit"
              className="btn btn--primary"
              disabled={isFetchingGist || gistPreview !== null || gistUrl.trim().length === 0}
            >
              {isFetchingGist ? 'Importing…' : 'Import'}
            </button>
          </div>
          <p id={gistDisclosureId} className="uploader__gist-disclosure">
            <Icon name="info" size={13} />
            <span>
              Heads up — this is a network request. When you click Import, the app fetches the Gist
              anonymously from <code>api.github.com</code>: no login, no resume content sent
              outbound, only the Gist ID in the URL. The Gist must be public. You'll see a preview
              of what was fetched and can choose whether to use it.
            </span>
          </p>
        </form>

        {/* ----- Preview-before-commit card (#68, #76) -----
            Rendered as plain text inside <pre> — never as Markdown — so the
            fetched gist body cannot inject markup into the app chrome. For
            multi-file gists a <select> sits above the body letting the user
            switch the pick before committing; the picker is suppressed for
            single-file gists (the most common case). */}
        {gistPreview && (
          <GistPreviewCard
            preview={gistPreview}
            titleId={gistPreviewId}
            pickerId={gistPickerId}
            onSelect={selectGistFile}
            onCommit={commitGistPreview}
            onCancel={cancelGistPreview}
          />
        )}
      </details>

      {messages}

      {/* ----- Start-from-template modal (#86). The picker owns its focus
           trap + Escape handling; we own the trigger ref and the focus
           restore. Mounted only when open so it stays out of the DOM
           (and the focus tree) while idle. ----- */}
      <TemplatePicker
        open={templatePickerOpen}
        onClose={closeTemplatePicker}
        onSelect={(slug) => {
          void handleTemplateSelect(slug);
        }}
      />
    </div>
  );
}

/* forwardRef wrapper so the editor's tab strip (#138) can drive the
   file picker through a stable imperative handle. The display name is
   kept for React DevTools clarity. */
const MarkdownUploader = forwardRef<MarkdownUploaderHandle, MarkdownUploaderProps>(
  MarkdownUploaderImpl,
);
MarkdownUploader.displayName = 'MarkdownUploader';
export default MarkdownUploader;

/**
 * Preview-before-commit card with optional multi-file picker (#68, #76).
 *
 * Multi-file UX decision: we use a native `<select>` rather than a radio
 * group. The radio group looked tempting for accessibility, but gists
 * routinely have 5–10 files of similar-looking names — laying them out as
 * radios bloats the card vertically and crowds out the preview body that
 * actually helps the user decide. A native `<select>` collapses to a single
 * row, is keyboard-operable for free (arrow keys, type-ahead, Enter), and
 * carries the right `<label htmlFor>` association for screen readers
 * without extra ARIA scaffolding.
 *
 * Single-file gists short-circuit the picker entirely so the card looks
 * exactly like the pre-#76 preview.
 *
 * Live region scope (#79): the wrapping section is NOT `aria-live` —
 * announcing the whole card on every picker change re-read the entire
 * filename + body preview, which is noisy. A visually-hidden `aria-live`
 * status line at the top of the card narrates only what changed.
 */
interface GistPreviewCardProps {
  preview: { files: GistFile[]; selectedIndex: number };
  titleId: string;
  pickerId: string;
  onSelect: (index: number) => void;
  onCommit: () => void;
  onCancel: () => void;
}

function GistPreviewCard({
  preview,
  titleId,
  pickerId,
  onSelect,
  onCommit,
  onCancel,
}: GistPreviewCardProps) {
  const { files, selectedIndex } = preview;
  const active = files[selectedIndex];
  // Recompute the snippet only when the active file changes — multi-file
  // gists can hold non-trivial bodies, and the user might flick through
  // several options.
  const snippet = useMemo(() => gistPreviewSnippet(active?.content ?? ''), [active]);

  if (!active) return null;

  const showPicker = files.length > 1;

  // Status line text — narrow announcement scoped to what the picker changed.
  // For multi-file gists we also include the position so the user can orient
  // ("3 of 7 files"); single-file gists skip the count entirely.
  const statusMessage =
    files.length > 1
      ? `Now previewing ${active.filename} — ${selectedIndex + 1} of ${files.length} files.`
      : `Now previewing ${active.filename}.`;

  return (
    <section className="uploader__gist-preview" aria-labelledby={titleId}>
      <p className="visually-hidden" aria-live="polite">
        {statusMessage}
      </p>
      <header className="uploader__gist-preview-header">
        <h3 id={titleId} className="uploader__gist-preview-title">
          Preview before importing
        </h3>
        <span className="uploader__gist-preview-filename" title={active.filename}>
          <Icon name="file" size={13} />
          <span>{active.filename}</span>
        </span>
      </header>
      {showPicker && (
        <div className="uploader__gist-preview-picker">
          <label htmlFor={pickerId} className="uploader__gist-preview-picker-label">
            File ({files.length})
          </label>
          <select
            id={pickerId}
            className="uploader__gist-preview-picker-select"
            value={selectedIndex}
            onChange={(event) => onSelect(Number(event.target.value))}
          >
            {files.map((file, index) => (
              <option key={`${index}:${file.filename}`} value={index}>
                {file.filename}
                {file.isMarkdown ? ' — Markdown' : ''}
                {file.content.length === 0 ? ' (empty)' : ''}
              </option>
            ))}
          </select>
        </div>
      )}
      <pre className="uploader__gist-preview-body" aria-label="Gist file preview">
        {snippet}
      </pre>
      <div className="uploader__gist-preview-actions">
        <button type="button" className="btn btn--primary" onClick={onCommit}>
          Use this
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}
