/**
 * gist.ts — explicit, user-initiated import from a public GitHub Gist (#33).
 *
 * THE ONLY NETWORK CALL IN THIS APP THAT CARRIES NO RESUME DATA OUTBOUND
 * --------------------------------------------------------------------
 * The privacy posture of Works on My Resume is "nothing leaves the browser
 * unless the user explicitly asks". This module is the carefully-scoped
 * exception: when (and only when) the user pastes a gist URL and clicks
 * Import, we issue a single GET to GitHub's public Gists API. We:
 *
 *   - Send NO request body, NO custom headers beyond `Accept`, and NO auth.
 *     The endpoint is anonymous; the gist must be public.
 *   - Do not pass any resume content outbound — the request URL is just
 *     `https://api.github.com/gists/<id>`. The response is the gist body,
 *     which the user has chosen to import.
 *   - Surface friendly errors for the three failure modes that actually
 *     happen in practice: network down, gist not found / private (404),
 *     and the unauthenticated rate limit (403).
 *
 * The matching CSP relaxation (a single `https://api.github.com` entry in
 * the `connect-src` directive) lives in `src/layouts/BaseLayout.astro`.
 */

/**
 * Recognises both the canonical `https://gist.github.com/<user>/<id>` form
 * and the legacy `https://gist.github.com/<id>` shape. We tolerate any
 * trailing path segments (revision, "/raw", etc.) — we never click through
 * to them; we use the API. The id is the FIRST 32-hex-char component;
 * GitHub also accepts long alphanumeric ids, so we permit `a-f0-9` of any
 * length ≥ 5 to be future-tolerant.
 */
const GIST_URL_RE = /^https?:\/\/gist\.github\.com\/(?:[^/\s]+\/)?([a-f0-9]{5,})(?:[/?#].*)?$/i;

/** True when the input looks like a recognizable gist URL. */
export function isGistUrl(input: string): boolean {
  return parseGistUrl(input) !== null;
}

/**
 * Extract the gist id from a recognizable URL, or `null` if the input is
 * not a gist URL. Whitespace around the URL is forgiven; junk after a
 * trailing slash is ignored.
 */
export function parseGistUrl(input: string): { id: string } | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  const match = GIST_URL_RE.exec(trimmed);
  if (!match) return null;
  return { id: match[1] };
}

/** The narrow JSON shape we read from GitHub's Gists API response. */
interface GistApiFile {
  filename?: string;
  type?: string;
  language?: string;
  truncated?: boolean;
  content?: string;
  raw_url?: string;
}

interface GistApiResponse {
  files?: Record<string, GistApiFile | null>;
}

/**
 * A single file inside a fetched gist, normalised for UI consumption.
 *
 * `content` is whatever string GitHub returned (may be empty if the file
 * was truncated server-side); the picker UI shows it as plain text so a
 * hostile filename or body cannot become markup.
 *
 * `isMarkdown` is the heuristic we already used to auto-pick the resume:
 * either the filename ends `.md` / `.markdown`, or the language is
 * `Markdown`. Useful for badging an option in the picker without forcing
 * the UI to re-implement the heuristic.
 */
export interface GistFile {
  filename: string;
  content: string;
  isMarkdown: boolean;
  truncated: boolean;
}

/**
 * Classify a file as markdown-shaped for the auto-pick heuristic. Same
 * rule we've always used; pulled out so `fetchGistFiles` can stamp the
 * `isMarkdown` bit on every returned file.
 */
function isMarkdownFile(file: GistApiFile): boolean {
  const name = (file.filename ?? '').toLowerCase();
  if (name.endsWith('.md') || name.endsWith('.markdown')) return true;
  if ((file.language ?? '').toLowerCase() === 'markdown') return true;
  return false;
}

/**
 * Pick the index of the file in `files` most likely to be the resume.
 * Strategy (unchanged from the original `pickResumeFile`):
 *   1. The first non-empty `.md` / `.markdown` file by filename
 *      (case-insensitive).
 *   2. Failing that, any non-empty file whose language is "Markdown".
 *   3. Failing that, the first file whose content is non-empty text.
 * Returns `-1` if no candidate is found.
 */
function pickDefaultIndex(files: GistFile[]): number {
  if (files.length === 0) return -1;

  const byExt = files.findIndex((f) => {
    const name = f.filename.toLowerCase();
    return f.content.length > 0 && (name.endsWith('.md') || name.endsWith('.markdown'));
  });
  if (byExt !== -1) return byExt;

  const byLang = files.findIndex((f) => f.content.length > 0 && f.isMarkdown);
  if (byLang !== -1) return byLang;

  const byContent = files.findIndex((f) => f.content.length > 0);
  return byContent;
}

/**
 * Internal helper: issue the single anonymous GET to GitHub and return the
 * parsed `files` map. Shared by `fetchGistFiles` (and, via that,
 * `fetchGistMarkdown`) so the network behaviour stays in exactly one place.
 *
 * Throws a friendly `Error` on any failure mode — callers surface
 * `error.message` directly in the UI.
 */
async function fetchGistApi(url: string): Promise<Record<string, GistApiFile | null>> {
  const parsed = parseGistUrl(url);
  if (!parsed) {
    throw new Error("That doesn't look like a Gist URL. Expected https://gist.github.com/…");
  }

  const apiUrl = `https://api.github.com/gists/${parsed.id}`;

  let response: Response;
  try {
    response = await fetch(apiUrl, {
      method: 'GET',
      // `Accept` is the standard, recommended header for the v3 API. No
      // auth header, no body, no credentials.
      headers: { Accept: 'application/vnd.github+json' },
      // Defence in depth: do not send cookies, even if a future change
      // moved this to a same-origin proxy.
      credentials: 'omit',
      // Don't reuse a stale cache — the user just asked for the latest.
      cache: 'no-store',
    });
  } catch {
    // `fetch` rejects on network failure / CORS / DNS error / CSP block.
    throw new Error(
      "Couldn't reach GitHub to fetch that Gist. Check your connection and try again.",
    );
  }

  if (response.status === 404) {
    throw new Error('That Gist could not be found. Is the URL correct and the Gist public?');
  }
  if (response.status === 403) {
    // Anonymous rate limit is 60/hour per IP — extremely generous for a
    // user-driven import, but explain it clearly when it does happen.
    throw new Error(
      'GitHub is rate-limiting Gist requests from this network. Please try again in a few minutes.',
    );
  }
  if (!response.ok) {
    throw new Error(`GitHub returned an unexpected response (HTTP ${response.status}).`);
  }

  let data: GistApiResponse;
  try {
    data = (await response.json()) as GistApiResponse;
  } catch {
    throw new Error('That Gist response was not valid JSON. The Gist may be in an unusual state.');
  }

  if (!data.files || typeof data.files !== 'object') {
    throw new Error('That Gist did not contain any files.');
  }

  return data.files;
}

/**
 * Normalise GitHub's `files` map into the array shape the UI consumes.
 * Preserves the iteration order GitHub returned (which is the insertion
 * order in the gist) and skips null entries. Each entry is stamped with
 * its markdown heuristic for downstream consumers.
 */
function normaliseFiles(apiFiles: Record<string, GistApiFile | null>): GistFile[] {
  const out: GistFile[] = [];
  for (const [key, file] of Object.entries(apiFiles)) {
    if (file === null || file === undefined) continue;
    out.push({
      // GitHub keys the map by filename; fall back to the key if the
      // payload itself omits it (defensive — shouldn't happen in practice).
      filename: file.filename ?? key,
      content: typeof file.content === 'string' ? file.content : '',
      isMarkdown: isMarkdownFile(file),
      truncated: file.truncated === true,
    });
  }
  return out;
}

/**
 * Issue a single anonymous GET to GitHub's Gists API and return ALL files
 * in the gist, plus the index of the file the heuristic would have picked.
 *
 * This is the multi-file-aware entry point added in #76 — the picker UI
 * uses it to show every file as an option while still defaulting to the
 * smartest guess. `fetchGistMarkdown` (below) remains the single-file
 * back-compat wrapper.
 *
 * Throws a friendly `Error` on any failure mode — callers surface
 * `error.message` directly in the UI.
 *
 * @param url The gist URL the user pasted.
 */
export async function fetchGistFiles(
  url: string,
): Promise<{ files: GistFile[]; defaultIndex: number }> {
  const apiFiles = await fetchGistApi(url);
  const files = normaliseFiles(apiFiles);

  if (files.length === 0) {
    throw new Error('That Gist did not contain any files.');
  }

  const defaultIndex = pickDefaultIndex(files);
  if (defaultIndex === -1) {
    throw new Error('That Gist had no Markdown or text content to import.');
  }

  const picked = files[defaultIndex];
  if (picked.content.length === 0) {
    // GitHub truncates large files; surface that distinctly so the user
    // knows the gist itself isn't broken — it's just too big for the API.
    if (picked.truncated) {
      throw new Error('That Gist is too large to import via the API. Try downloading it manually.');
    }
    throw new Error('The chosen Gist file was empty.');
  }

  return { files, defaultIndex };
}

/**
 * Back-compat wrapper: returns just the heuristically-picked file's body
 * and filename, matching the pre-#76 contract. Implemented as a thin
 * wrapper over `fetchGistFiles` so the network behaviour, error messages,
 * and pick heuristic stay in exactly one place.
 *
 * Prefer `fetchGistFiles` for any caller that wants to expose the
 * multi-file picker; this signature exists only to keep older callers
 * compiling without a forced edit.
 *
 * @param url The gist URL the user pasted.
 */
export async function fetchGistMarkdown(
  url: string,
): Promise<{ markdown: string; filename: string }> {
  const { files, defaultIndex } = await fetchGistFiles(url);
  const picked = files[defaultIndex];
  return {
    markdown: picked.content,
    filename: picked.filename || 'gist.md',
  };
}
