// Centralized PostHog web-analytics seam for loopover-ui (#8293, #8299).
//
// Single chokepoint for client-side product analytics: the app calls
// `initAnalytics()` / `capturePageview()` / `captureEvent()` and never touches
// `posthog-js` directly anywhere else. This replaces the self-hosted Umami
// beacon that used to live in routes/__root.tsx (#8299's decommission).
//
// SCOPE. Web analytics only. Session replay (#8295), error tracking (#8291 --
// browser-sentry.ts still owns that seam), and feature flags (#8297) are each
// their own issue and are deliberately NOT configured here; adding them means
// opening the corresponding `posthog.init` block under that issue, not
// widening this one.
//
// `posthog-js` is loaded via a DYNAMIC import, mirroring browser-sentry.ts's
// exact `void import("@sentry/react")` pattern: a build with no
// VITE_POSTHOG_PROJECT_TOKEN configured (self-hosters, local dev, PR CI) never
// downloads or parses the library at all, the same "zero cost when
// unconfigured" guarantee every other telemetry integration in this app
// provides.
//
// Proxied first-party through this origin (posthogApiHost() below, served by
// lib/analytics-proxy.ts's handleAnalyticsProxy) rather than posthog.com
// directly -- the same ad-blocker-resilience rationale the Umami proxy this
// replaces already documented, and PostHog's own Cloudflare-proxy guide's
// stated purpose.
//
// Umami-parity audit (#8299's decommission gate -- PostHog must capture what
// the old beacon did), checked against the removed beacon's actual payload
// (`website`, `hostname`, `screen`, `language`, `title`, `url`, `referrer`):
//   - hostname/url/referrer/screen/language: posthog-js attaches these
//     automatically on every event ($current_url, $referrer, $screen_width/
//     $screen_height, $browser_language) -- nothing to configure.
//   - title: NOT a posthog-js default (it has no $title-equivalent the way it
//     auto-attaches referrer/browser/os) -- added explicitly in
//     `capturePageview` below, matching what the old beacon sent.
//   - Geo: populated server-side from the real client IP, which
//     analytics-proxy.ts forwards as `x-forwarded-for` -- the same mechanism
//     that fed Umami's geo, unaffected by anything in this file.
//   - DNT: the old beacon checked `navigator.doNotTrack === "1"` itself;
//     `respect_dnt` below is posthog-js's own equivalent.
//
// One behavior deliberately CHANGES vs. the beacon: the beacon fired once per
// full page load and never on a client-side route change, so SPA navigations
// were invisible to Umami. This module captures every navigation (see
// `capture_pageview: false` plus the router subscription in routes/__root.tsx),
// so post-cutover pageview counts run legitimately higher than Umami's for the
// same traffic. That is a fix, not a regression -- but it is a real
// discontinuity at the cutover date when comparing the two series.

import type { PostHog } from "posthog-js";

// Same VITE_*-prefixed build-time-injected convention as every other
// client-exposed config in this app (see lib/config.server.ts's own header on
// the split). A PostHog project token is a write-only ingest token and is safe
// to embed in client JS -- but it is injected at BUILD time by Vite, so it has
// to be set as a build variable on the UI's deploy workflow, NOT as a runtime
// Worker var/secret (setting it there silently leaves the bundle with no token
// and every call below a no-op with zero errors).
// Read at CALL time, not once at module scope, matching browser-sentry.ts's
// own convention for the same class of value. Beyond consistency this is what
// makes the gate testable: `vi.stubEnv` mutates `import.meta.env` in place, so
// a module-level `const` would capture whatever the value was at first import
// and no test could vary it afterwards without a module-registry reset dance.
function posthogToken(): string | undefined {
  return (import.meta.env?.VITE_POSTHOG_PROJECT_TOKEN as string | undefined)?.trim() || undefined;
}

// First-party proxy prefix (lib/analytics-proxy.ts), never PostHog's own
// domain directly. `/stats` is retained from the Umami proxy this replaces:
// PostHog's own proxy guide warns that ad blockers pattern-match
// "analytics"/"tracking"/"posthog"/"ph" in URLs even on a first-party origin,
// and `/stats` is exactly the kind of unrelated-sounding prefix it recommends.
function posthogApiHost(): string {
  return (import.meta.env?.VITE_POSTHOG_HOST as string | undefined) || "/stats";
}

// Only used for the in-app toolbar's deep-link (an optional, admin-only
// feature) -- never a tracking endpoint, so pointing this at PostHog's real
// app domain rather than the proxy is correct and matches PostHog's own guide.
function posthogUiHost(): string {
  return (import.meta.env?.VITE_POSTHOG_UI_HOST as string | undefined) || "https://us.posthog.com";
}

// Tracks PostHog's own "SDK defaults" versioning
// (posthog.com/docs/libraries/js#sdk-defaults) -- bump deliberately when
// adopting a newer default set, not on every posthog-js release. A typo here
// cannot silently degrade: posthog-js types this option as a closed
// string-literal union, and this `const` (no explicit annotation) infers that
// literal type, so a bad value fails `npm run typecheck` outright.
const SDK_DEFAULTS_DATE = "2026-05-30";

let posthogInit: Promise<PostHog | null> | null = null;

function loadPostHog(): Promise<PostHog | null> {
  if (posthogInit) return posthogInit;
  posthogInit = import("posthog-js")
    .then(({ default: posthog }) => {
      posthog.init(posthogToken() as string, {
        api_host: posthogApiHost(),
        ui_host: posthogUiHost(),
        defaults: SDK_DEFAULTS_DATE,
        // This is a client-side-routed SPA, so the single pageview `defaults`
        // would auto-fire on init only ever covers the first load. Every
        // navigation (including the first) is captured explicitly instead, via
        // the router subscription in routes/__root.tsx -- one predictable code
        // path rather than automatic-for-the-first-load plus
        // manual-for-the-rest.
        capture_pageview: false,
        // posthog-js's own default for this is 'if_capture_pageview' -- it
        // piggybacks on capture_pageview and is therefore OFF whenever that is
        // false. Disabling capture_pageview above would silently take
        // pageleave down with it unless overridden here, and pageleave has no
        // SPA caveat of its own (it is driven by page unload, which fires
        // correctly regardless of client-side routing). Without it, bounce
        // rate and session duration are both wrong.
        capture_pageleave: true,
        // Native Core Web Vitals capture (LCP/INP/CLS/FCP as $web_vitals).
        // Explicit here rather than relying solely on the project's own "Web
        // vitals autocapture" dashboard setting: that setting only reaches the
        // client through the /array/*/config remote-config fetch, so a
        // client-side default keeps this working even if that fetch is
        // degraded or blocked.
        capture_performance: { web_vitals: true },
        // Parity with the Umami beacon this replaces, which checked
        // `navigator.doNotTrack === "1"` before sending anything.
        respect_dnt: true,
        // "localStorage", NOT posthog-js's own 'localStorage+cookie' default
        // and NOT "memory". This is the one setting metagraphed got wrong
        // first and had to correct (JSONbored/metagraphed#8210), so it is
        // chosen here with that result already in hand: "memory" persists
        // nothing, so every reload / new tab / return visit mints a fresh
        // anonymous identity and is counted as a brand-new visitor -- which is
        // what made PostHog's unique-visitor count run far hotter than Umami's
        // for identical real traffic. "localStorage" persists a random
        // anonymous id with NO cookie set, so the cookieless posture the Umami
        // beacon had is preserved while a returning visitor in the same
        // browser actually gets continuity.
        //
        // Deliberately NOT `cookieless_mode`, PostHog's dedicated
        // cookieless-tracking feature -- rejected on its documented behavior,
        // not a guess: it strips the request IP server-side before any GeoIP
        // enrichment runs, unconditionally, so the country/city data the Umami
        // beacon's own geo provided would never populate again.
        persistence: "localStorage",
      });
      return posthog;
    })
    .catch((err) => {
      // Never let telemetry wiring crash the host app.
      if (import.meta.env?.DEV) console.error("[analytics] posthog load failed", err);
      return null;
    });
  return posthogInit;
}

/** True when VITE_POSTHOG_PROJECT_TOKEN is configured -- the same gate every
 *  export below uses, exposed so callers can show whether web analytics is
 *  active without importing the SDK (mirrors browser-sentry.ts's
 *  `isBrowserSentryConfigured`). */
export function isAnalyticsConfigured(): boolean {
  return Boolean(posthogToken());
}

/** Drops the memoized SDK promise so a test can exercise a fresh init. Never
 *  called by app code -- the singleton is the point at runtime. */
export function resetAnalyticsForTest(): void {
  posthogInit = null;
}

/** Starts loading PostHog. Idempotent (safe to call repeatedly); a no-op when
 *  unconfigured. Call once, early -- routes/__root.tsx's mount effect. */
export function initAnalytics(): void {
  if (!posthogToken()) return;
  void loadPostHog();
}

/** Captures one `$pageview`. Pass `url` explicitly on an SPA route change so
 *  the event reflects the route just navigated to rather than posthog-js's own
 *  read of a possibly-stale location.
 *
 *  `page_title` is set explicitly for Umami parity (#8299): posthog-js has no
 *  built-in $title-style property the way it auto-attaches referrer/browser/os,
 *  and the removed beacon did send `title`. `document.title` is read at call
 *  time rather than passed in, so it reflects the head the just-resolved route
 *  committed. */
export function capturePageview(url?: string): void {
  if (!posthogToken()) return;
  void loadPostHog().then((posthog) => {
    posthog?.capture("$pageview", {
      ...(url ? { $current_url: url } : undefined),
      ...(typeof document !== "undefined" ? { page_title: document.title } : undefined),
    });
  });
}

/** Captures a custom event. Best-effort: a no-op when unconfigured, and
 *  dropped (never queued or retried) if PostHog has not finished loading --
 *  matching this module's overall "telemetry must never affect the app"
 *  posture. */
export function captureEvent(name: string, properties?: Record<string, unknown>): void {
  if (!posthogToken()) return;
  void loadPostHog().then((posthog) => posthog?.capture(name, properties));
}
