/**
 * AppHero — empty-state hero shown above the workbench when no resume is
 * loaded yet (#127). Brand title, kbd-chip tagline, and a stat counter row
 * (THEMES · LAYOUTS · TEMPLATES · OFFLINE-READY) sourced from in-tree data.
 *
 * Mount animation (#140): the three numeric stats tick up from 0 to their
 * final values via rAF (ease-out, ~500 ms), staggered Themes / +100 ms /
 * +200 ms; the Offline-ready check fades in at +400 ms via a CSS class.
 * Under `prefers-reduced-motion: reduce` the effect is skipped — values
 * render at their final state and the check's `--check-enter` class is
 * omitted.
 *
 * CSP: no inline `style={...}` attributes. The animation writes only
 * `textContent`; class toggles govern fade/shimmer.
 *
 * Trust: every value rendered is either a static literal or a number
 * derived from in-tree data — no user-controlled strings.
 */
import { useEffect, useRef } from 'react';
import Icon from './Icon';

interface AppHeroProps {
  /** Total number of themes available — usually ~465 once the dataset loads
      (every theme in the dataset is resume-safe — body text clears 7:1 — so
      the unsafe slice was dropped in #153 along with the picker's redundant
      toggle). */
  themeCount: number;
  /** Number of layout templates — sourced from RESUME_TEMPLATES. */
  layoutCount: number;
  /** Number of starter templates in `public/templates/*.md`. */
  templateCount: number;
}

/** True when the user has NOT asked for reduced motion (matches Toast.tsx). */
function motionOk(): boolean {
  try {
    return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return true;
  }
}

/** Ease-out cubic — gentle decel for a tick-up that lands cleanly. */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Animate `node`'s textContent from 0 → `target` over `duration` ms after
 * `delay` ms. Returns a cancel handle for effect cleanup.
 */
function tickUpTo(node: HTMLElement, target: number, duration: number, delay: number): () => void {
  let rafId = 0;
  let startedAt = 0;
  let cancelled = false;
  // Render 0 immediately so the entrance is visible even if the first
  // animation frame lands slightly late.
  node.textContent = '0';

  const timer = window.setTimeout(() => {
    const step = (now: number) => {
      if (cancelled) return;
      if (startedAt === 0) startedAt = now;
      const t = Math.min(1, (now - startedAt) / duration);
      node.textContent = String(Math.round(easeOutCubic(t) * target));
      if (t < 1) {
        rafId = window.requestAnimationFrame(step);
      } else {
        node.textContent = String(target); // pin the final value exactly
      }
    };
    rafId = window.requestAnimationFrame(step);
  }, delay);

  return () => {
    cancelled = true;
    window.clearTimeout(timer);
    if (rafId !== 0) window.cancelAnimationFrame(rafId);
  };
}

interface HeroStatProps {
  /** Final integer value the counter should reach. */
  value: number;
  /** Small-caps kicker rendered to the right of the number. */
  label: string;
  /** ms after the first stat starts ticking — drives the stagger. */
  delayMs: number;
}

/** One stat: a loud mono number + small-caps kicker. Ticks up on mount. */
function HeroStat({ value, label, delayMs }: HeroStatProps) {
  const valueRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const node = valueRef.current;
    if (!node) return;
    if (!motionOk()) {
      node.textContent = String(value);
      return;
    }
    return tickUpTo(node, value, 500, delayMs);
  }, [value, delayMs]);
  return (
    <span className="app-hero__stat" role="listitem">
      <span className="app-hero__stat-value" ref={valueRef}>
        {value}
      </span>
      <span className="app-hero__stat-label section-kicker">{label}</span>
    </span>
  );
}

export default function AppHero({ themeCount, layoutCount, templateCount }: AppHeroProps) {
  // Static at mount (matches Toast.tsx): when reduced-motion is on, omit
  // the entrance modifier so the check renders fully visible from frame 0.
  const reduced = typeof window !== 'undefined' && !motionOk();
  const checkClass = reduced
    ? 'app-hero__stat app-hero__stat--check'
    : 'app-hero__stat app-hero__stat--check app-hero__stat--check-enter';

  return (
    <section className="app-hero" aria-label="Welcome to Works on My Resume">
      <div className="app-hero__brand">
        <h1 className="app-hero__title">Works on My Resume</h1>
      </div>

      <p className="app-hero__tagline">
        A Markdown resume renderer for the browser. Type, pick a theme, export a PDF — your file
        stays on your device. Swap themes with <kbd>&larr;</kbd> <kbd>&rarr;</kbd>, <kbd>/</kbd> to
        search, <kbd>r</kbd> for random.
      </p>

      <div className="app-hero__stats" role="list" aria-label="At a glance">
        <HeroStat value={themeCount} label="Themes" delayMs={0} />
        <span className="app-hero__stat-sep" aria-hidden="true">
          ·
        </span>
        <HeroStat value={layoutCount} label="Layouts" delayMs={100} />
        <span className="app-hero__stat-sep" aria-hidden="true">
          ·
        </span>
        <HeroStat value={templateCount} label="Templates" delayMs={200} />
        <span className="app-hero__stat-sep" aria-hidden="true">
          ·
        </span>
        <span className={checkClass} role="listitem">
          <span className="app-hero__stat-value app-hero__stat-value--icon">
            <Icon name="check" size={18} />
          </span>
          <span className="app-hero__stat-label section-kicker">Offline-ready</span>
        </span>
      </div>
    </section>
  );
}
