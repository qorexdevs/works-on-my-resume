/**
 * SettingsDrawer — right-anchored modal drawer that consolidates low-
 * frequency controls into one discoverable surface (#128).
 *
 * The toolbar used to host four discoverable chips: the ATS preview toggle,
 * the Snapshots dropdown, the shortcuts-(?) chip popover, and the keyboard
 * help icon. Each one was an island, each one ate horizontal space, and the
 * pattern collapsed badly on narrow viewports. This drawer is the single
 * surface those controls now live behind — opened by a single gear icon at
 * the rightmost toolbar slot, dismissed via Esc / click-outside / explicit
 * close button. The toolbar reads as `Presets · Theme · Layout` (row 1) and
 * `Page-fit · Save as PDF · Export · ⚙` (row 2).
 *
 * Sections
 * --------
 *   1. Workspace — ATS preview toggle, draft-autosave toggle, Clear workspace
 *      action. Things that change the editing session as a whole.
 *   2. Snapshots — the full snapshots list (mounted via the existing
 *      SnapshotsMenu, opened inline; the drawer becomes its host).
 *   3. Help — shortcut legend chips + "Open the full keyboard shortcuts
 *      dialog" button + about/version. The legend is the same set of
 *      shortcut chips that used to live in the `shortcuts(?)` toolbar
 *      popover.
 *   4. Theme nav — prev / next / random theme step buttons (mirror the
 *      ThemeControls cluster; the keyboard shortcuts ←/→/r remain wired to
 *      ResumeStudio's handlers).
 *
 * Accessibility
 * -------------
 * Mirrors `KeyboardHelp.tsx` / `ExampleDialog.tsx`:
 *   - `role="dialog"` + `aria-modal="true"` + `aria-labelledby` heading id.
 *   - Focus moves to the close button on open; focus trap on Tab/Shift+Tab.
 *   - Esc closes; click outside closes; explicit close button closes.
 *   - The caller restores focus to the gear button after close (parent owns
 *     the trigger ref, the drawer signals via `onClose`).
 *
 * CSP
 * ---
 * No inline `style={...}` attributes. All visuals live in global.css under
 * `.settings-drawer__*`.
 */
import { useCallback, useEffect, useId, useRef } from 'react';
import type { ResumeSnapshot } from '../utils/storage';
import Icon from './Icon';
import SnapshotsMenu from './SnapshotsMenu';

/** Selector matching every focusable element for the focus trap. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface SettingsDrawerProps {
  /** Request the drawer be closed (Esc, click-outside, close button). */
  onClose: () => void;

  /* Workspace group ---------------------------------------------- */
  /** Whether the ATS preview is currently active. */
  atsActive: boolean;
  /** Toggle ATS preview mode. */
  onAtsChange: (active: boolean) => void;
  /** Whether draft autosave is enabled (the #32 opt-in). */
  draftEnabled: boolean;
  /** Toggle draft autosave. */
  onDraftEnabledChange: (enabled: boolean) => void;
  /** Clear the loaded resume — destructive, asks no confirmation here. */
  onClearWorkspace: () => void;

  /* Snapshots group ---------------------------------------------- */
  snapshots: ResumeSnapshot[];
  suggestedSnapshotName: string;
  onSaveSnapshot: (input: { name: string }) => void;
  onLoadSnapshot: (snap: ResumeSnapshot) => void;
  onDeleteSnapshot: (id: string) => void;

  /* Help group --------------------------------------------------- */
  /** Whether single-key shortcuts are enabled (WCAG 2.1.4 mitigation). */
  shortcutsEnabled: boolean;
  /** Open the full keyboard-shortcuts dialog (KeyboardHelp). */
  onOpenKeyboardHelp: () => void;
  /** Open the Markdown-format reference dialog (FormatDocsDialog, #157). */
  onOpenFormatDocs: () => void;

  /* Theme nav group --------------------------------------------- */
  onPreviousTheme: () => void;
  onNextTheme: () => void;
  onRandomTheme: () => void;
}

/**
 * One shortcut chip — keys (rendered as <kbd>) + a label. Used in the Help
 * group's legend. Reuses the same <kbd> tone the rest of the app does — no
 * new styles, just the existing dialog kbd rule.
 */
function ShortcutLegendRow({ keys, label }: { keys: string[]; label: string }) {
  return (
    <li className="settings-drawer__shortcut-row">
      <span className="settings-drawer__shortcut-keys">
        {keys.map((key, index) => (
          <span key={key}>
            {index > 0 && (
              <span className="settings-drawer__shortcut-sep" aria-hidden="true">
                {' '}
              </span>
            )}
            <kbd>{key}</kbd>
          </span>
        ))}
      </span>
      <span className="settings-drawer__shortcut-label">{label}</span>
    </li>
  );
}

export default function SettingsDrawer({
  onClose,
  atsActive,
  onAtsChange,
  draftEnabled,
  onDraftEnabledChange,
  onClearWorkspace,
  snapshots,
  suggestedSnapshotName,
  onSaveSnapshot,
  onLoadSnapshot,
  onDeleteSnapshot,
  shortcutsEnabled,
  onOpenKeyboardHelp,
  onOpenFormatDocs,
  onPreviousTheme,
  onNextTheme,
  onRandomTheme,
}: SettingsDrawerProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  const atsId = useId();
  const draftId = useId();

  /* On open: move focus to the Close button so keyboard users land inside. */
  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  /* Trap focus + Escape entirely within the dialog. Same pattern as
     KeyboardHelp + ExampleDialog so behavior across the three modals is
     identical from the user's perspective.
     One nuance: the Snapshots group hosts a nested popover with its own
     Escape handler (close the popover, not the drawer). If focus is
     currently inside that nested popover, defer to its handler — closing
     the drawer wholesale would feel like Esc skipped a level. */
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        const active = document.activeElement;
        if (active instanceof Element && active.closest('.snapshots-menu__popover')) {
          // Let the SnapshotsMenu's own Escape handler run — it closes the
          // popover and restores focus to the snapshots trigger. The drawer
          // stays open so the user can see the saved row.
          return;
        }
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
    <div className="settings-drawer__overlay" onPointerDown={onClose}>
      <aside
        ref={dialogRef}
        className="settings-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        onKeyDown={handleKeyDown}
        /* Clicks inside must not bubble to the overlay's dismiss handler. */
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="settings-drawer__header">
          <h2 id={headingId} className="settings-drawer__title">
            Settings
          </h2>
          <button
            type="button"
            ref={closeButtonRef}
            className="btn btn--ghost btn--icon"
            onClick={onClose}
            aria-label="Close settings"
          >
            <Icon name="close" />
          </button>
        </header>

        <div className="settings-drawer__body">
          {/* ----- Workspace group ----- */}
          <section className="settings-drawer__group" aria-labelledby={`${headingId}-workspace`}>
            <h3
              id={`${headingId}-workspace`}
              className="settings-drawer__group-title section-kicker"
            >
              Workspace
            </h3>
            <div className="settings-drawer__group-body">
              <label className="settings-drawer__toggle" htmlFor={atsId}>
                {/* role="switch" preserves the AT contract the old toolbar
                    AtsModeToggle exposed (#31) — screen readers announce
                    "ATS preview, switch, on/off" rather than a generic
                    checkbox, and the existing e2e suite targets the switch
                    role to flip ATS mode. */}
                <input
                  id={atsId}
                  type="checkbox"
                  role="switch"
                  checked={atsActive}
                  onChange={(event) => onAtsChange(event.target.checked)}
                />
                <span>
                  <span className="settings-drawer__toggle-name">ATS preview</span>
                  <span className="settings-drawer__toggle-hint">
                    Renders the resume the way an applicant-tracking system would parse it — a
                    plain, single-column reading. Session-only.
                  </span>
                </span>
              </label>

              <label className="settings-drawer__toggle" htmlFor={draftId}>
                <input
                  id={draftId}
                  type="checkbox"
                  checked={draftEnabled}
                  onChange={(event) => onDraftEnabledChange(event.target.checked)}
                />
                <span>
                  <span className="settings-drawer__toggle-name">
                    Remember this resume on this device
                  </span>
                  <span className="settings-drawer__toggle-hint">
                    Saves your Markdown to this browser's local storage so it survives a reload. Off
                    by default. Turning off deletes the saved copy immediately.
                  </span>
                </span>
              </label>

              <button
                type="button"
                className="btn settings-drawer__danger-btn"
                onClick={() => {
                  onClearWorkspace();
                  onClose();
                }}
              >
                <Icon name="trash" size={14} />
                Clear workspace
              </button>
            </div>
          </section>

          {/* ----- Snapshots group ----- */}
          <section className="settings-drawer__group" aria-labelledby={`${headingId}-snapshots`}>
            <h3
              id={`${headingId}-snapshots`}
              className="settings-drawer__group-title section-kicker"
            >
              Snapshots
            </h3>
            <div className="settings-drawer__group-body">
              {/* Mount SnapshotsMenu unconditionally — when draft autosave is
                  OFF the menu renders a disabled trigger with the explanatory
                  privacy tooltip, preserving the discoverability invariant
                  from #94 (the affordance is visible but inert). When ON it
                  expands to the full save / list / delete dropdown. */}
              <SnapshotsMenu
                snapshots={snapshots}
                enabled={draftEnabled}
                suggestedName={suggestedSnapshotName}
                onSave={onSaveSnapshot}
                onLoad={onLoadSnapshot}
                onDelete={onDeleteSnapshot}
              />
              {!draftEnabled && (
                <p className="settings-drawer__empty">
                  Enable <strong>Remember this resume on this device</strong> above to save
                  snapshots — local-only, up to 10 per device.
                </p>
              )}
            </div>
          </section>

          {/* ----- Theme nav group ----- */}
          <section className="settings-drawer__group" aria-labelledby={`${headingId}-theme-nav`}>
            <h3
              id={`${headingId}-theme-nav`}
              className="settings-drawer__group-title section-kicker"
            >
              Theme nav
            </h3>
            <div className="settings-drawer__group-body">
              <div className="settings-drawer__theme-nav" role="group" aria-label="Step themes">
                <button
                  type="button"
                  className="btn"
                  onClick={onPreviousTheme}
                  aria-label="Previous theme"
                  title="Previous theme (←)"
                >
                  <Icon name="chevron-left" size={14} />
                  <span>Previous</span>
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={onNextTheme}
                  aria-label="Next theme"
                  title="Next theme (→)"
                >
                  <span>Next</span>
                  <Icon name="chevron-right" size={14} />
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={onRandomTheme}
                  aria-label="Random theme"
                  title="Random theme (r)"
                >
                  <Icon name="shuffle" size={14} />
                  <span>Random</span>
                </button>
              </div>
              <p className="settings-drawer__hint">
                Keyboard shortcuts stay wired — <kbd>&larr;</kbd> <kbd>&rarr;</kbd> step,{' '}
                <kbd>r</kbd> random.
              </p>
            </div>
          </section>

          {/* ----- Help group ----- */}
          <section className="settings-drawer__group" aria-labelledby={`${headingId}-help`}>
            <h3 id={`${headingId}-help`} className="settings-drawer__group-title section-kicker">
              Help
            </h3>
            <div className="settings-drawer__group-body">
              <ul className="settings-drawer__shortcut-list">
                <ShortcutLegendRow keys={['←', '→']} label="Previous / next theme" />
                <ShortcutLegendRow keys={['r']} label="Random theme" />
                <ShortcutLegendRow keys={['/']} label="Search themes" />
                <ShortcutLegendRow keys={['p']} label="Print / Save as PDF" />
                <ShortcutLegendRow keys={['e']} label="Toggle the export panel" />
                <ShortcutLegendRow keys={['?']} label="Open the full shortcuts dialog" />
                <ShortcutLegendRow keys={['Esc']} label="Close a panel or field" />
              </ul>
              {!shortcutsEnabled && (
                <p className="settings-drawer__shortcuts-off">
                  Single-key shortcuts are off — only <kbd>Esc</kbd> works. Re-enable in the full
                  shortcuts dialog.
                </p>
              )}
              <button
                type="button"
                className="btn"
                onClick={() => {
                  onClose();
                  onOpenKeyboardHelp();
                }}
              >
                <Icon name="help" size={14} />
                Open the full shortcuts dialog
              </button>
              {/* Markdown format reference (#157) — opens the FormatDocsDialog
                  with the frontmatter contract, section vocabulary, and the
                  LLM-handoff prompt. Mirrors the keyboard-help handoff: close
                  the drawer first so the modal lands on a clean stage and
                  focus restore goes back to the gear button when the modal
                  closes. */}
              <button
                type="button"
                className="btn"
                onClick={() => {
                  onClose();
                  onOpenFormatDocs();
                }}
              >
                <Icon name="file" size={14} />
                Markdown format
              </button>
              <p className="settings-drawer__about">
                <span className="section-kicker">About</span>
                <span>
                  Works on My Resume — a static, local-first Markdown resume renderer. Your resume
                  never leaves the browser.
                </span>
              </p>
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
}
