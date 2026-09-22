/**
 * Playwright config for the Works on My Resume end-to-end suite.
 *
 * The app is fully static. We build it once and serve it with `astro
 * preview`, which honours the configured `base: '/works-on-my-resume'`
 * — so every test navigates to URLs under that base.
 *
 * Two projects:
 *  - `chromium-desktop` at 1280×800: the canonical desktop viewport for
 *    the studio layout and the visual-regression baselines.
 *  - `mobile-iphone-13`: smoke coverage of the mobile journey so any
 *    layout assumption that breaks at narrow widths is surfaced.
 */
import { defineConfig, devices } from '@playwright/test';

/**
 * Preview-server port. Defaults to 4321 (Astro's default + what every doc
 * example assumes). Override via `E2E_PORT=4399 npm run test:e2e` when
 * running parallel worktrees so each agent's preview lives on its own port
 * instead of silently reusing a sibling worktree's via
 * `reuseExistingServer: !process.env.CI` (#146).
 */
const PORT = Number(process.env.E2E_PORT) || 4321;
const BASE_URL = `http://localhost:${PORT}/works-on-my-resume/`;

export default defineConfig({
  testDir: 'tests/e2e',
  /* Chromium text rendering differs between Windows and the Ubuntu runner.
     Keep a baseline for each platform so a locally generated snapshot cannot
     replace the Linux expectation used by CI. */
  snapshotPathTemplate: '{testDir}/screenshots/{platform}/{arg}{ext}',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  /* Single worker keeps the dev preview server's lifecycle predictable
     and the visual baselines deterministic. The suite is small. */
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  timeout: 30_000,
  expect: {
    timeout: 5_000,
    /* OKLCH theme rendering can produce sub-pixel anti-aliasing
       differences between local and CI Chromium builds. A small
       per-pixel tolerance keeps the visual baseline meaningful without
       flagging cosmetic noise. */
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.02,
      animations: 'disabled',
    },
  },
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
      },
    },
    {
      name: 'mobile-iphone-13',
      /* Smoke-test the mobile journey using the iPhone 13 viewport + UA
         on the Chromium engine. We intentionally do NOT use the full
         `devices['iPhone 13']` preset because that hard-pins
         `browserName: 'webkit'`, which would require an extra browser
         binary in CI. Chromium with the same viewport gives meaningful
         coverage of the narrow-width layout for a fraction of the cost. */
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        userAgent:
          'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) ' +
          'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
      },
    },
  ],
  webServer: {
    /* `astro preview` serves dist/ on the configured base path. We
       build once before tests so preview has something to serve. The port
       is read from the same `PORT` constant the BASE_URL uses (env-
       overridable via `E2E_PORT`, #146) so parallel-worktree runs can sit
       on different ports without colliding. */
    command: `npm run build && npm run preview -- --port ${PORT} --host 127.0.0.1`,
    // Astro 7 backgrounds preview automatically when an agent is detected.
    // Playwright owns this process, so it needs to remain in the foreground.
    env: {
      ASTRO_PREVIEW_BACKGROUND: '0',
    },
    url: BASE_URL,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
