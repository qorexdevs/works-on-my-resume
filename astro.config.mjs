// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';

// Works on My Resume is a fully static, local-first app.
// Deployed to GitHub Pages at https://qorexdevs.github.io/works-on-my-resume/
// https://astro.build/config
export default defineConfig({
  site: 'https://qorexdevs.github.io',
  base: '/works-on-my-resume',
  output: 'static',
  integrations: [react()],

  // Force every stylesheet external. Astro normally inlines small CSS chunks
  // into `<style>` tags in `<head>`; with auto-CSP that's fine (it would hash
  // them), but keeping all CSS external means the same hashes survive across
  // builds whether or not a chunk happens to fall under the inline-size
  // threshold. Pairs with `security.csp` below — see issue #38.
  build: { inlineStylesheets: 'never' },

  // Auto-CSP. Astro hashes every inline <script> and inline <style> it emits
  // (island hydration scripts, scoped component styles, etc.) and writes the
  // hashes into a `<meta http-equiv="content-security-policy">` element so
  // the page never needs `'unsafe-inline'` on script-src or style-src.
  //
  // We list ONLY the non-script/style directives here — Astro builds
  // `script-src` and `style-src` itself from the hashes it computed.
  //
  // connect-src exception — `https://api.github.com` (#33):
  // A single, deliberate allowance for the user-initiated "Import from Gist"
  // flow. The fetch only happens when the user pastes a gist URL and clicks
  // Import; it carries no auth and no resume content outbound. This is the
  // lone exception to the otherwise self-only connect-src and MUST be
  // preserved when changing this config.
  security: {
    csp: {
      directives: [
        "default-src 'self'",
        "img-src 'self' data: blob:",
        "font-src 'self'",
        "connect-src 'self' https://api.github.com",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'none'",
      ],
      // No styleDirective / scriptDirective overrides — let Astro auto-hash.
    },
  },

  // Resume content never touches a server; no SSR, no adapters, no analytics.
});
