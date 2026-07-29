// Screenshot endpoint for the realtime before/after capture (reviewbot→loopover convergence — visual port).
//
// PORTED from reviewbot's src/agents/loopover/shot.ts. CHANGES for loopover:
//   • puppeteer import unchanged (@cloudflare/puppeteer), SSRF guard now isSafeHttpUrl from ../content-lane/safe-url
//   • bindings: env.BROWSER (Browser Rendering) + env.REVIEW_AUDIT (R2) — loopover's R2 binding is
//     REVIEW_AUDIT, NOT reviewbot's env.AUDIT.
//   • r2 key prefix default 'loopover/shots/'; on-demand render allowlist's production host = PUBLIC_SITE_ORIGIN.
//   • no reviewbot REVIEWBOT_* secrets / REST fallback — loopover renders via the BROWSER binding only.
//
// Two modes:
//   GET /loopover/shot?key=<r2key>  -> stream a pre-rendered PNG from R2 (fast; GitHub's image proxy
//                                       fetches this static object instead of waiting on a live render).
//   GET /loopover/shot?url=<page>   -> render <page> on demand and return a PNG (host-allowlisted +
//                                       SSRF-guarded). A fallback / manual-check path.
//   GET /loopover/shot?placeholder=loading|failed|auth -> a static SVG card (no render).
//
// Rendering uses the Cloudflare Browser Rendering *binding* (env.BROWSER) via @cloudflare/puppeteer — no
// account API token. Returns null on any failure so callers degrade gracefully (the cell becomes a dash).
import puppeteer from "@cloudflare/puppeteer";
import { hostIsPrivateOrLocal, isSafeHttpUrl } from "../content-lane/safe-url";
import { incr } from "../../selfhost/metrics";

export type Viewport = { width: number; height: number };
/** A `prefers-color-scheme` value the renderer can emulate before capture (#3678). */
export type ShotTheme = "light" | "dark";
export interface CaptureShotOptions {
  isAllowedUrl?: (targetUrl: string) => boolean;
  /** Emulate `prefers-color-scheme: <theme>` before navigation (#3678). Omitted (every existing caller) ⇒
   *  no emulation call at all — Chromium's own unconfigured default, byte-identical to today.
   *
   *  VERIFIED (#4109): `emulateMediaFeatures` maps to CDP's `Emulation.setEmulatedMedia`, which only changes
   *  what CSS media queries and `window.matchMedia` report — it cannot write `localStorage` and has NO effect
   *  on any theme mechanism that reads an explicit stored preference instead of consulting
   *  `prefers-color-scheme`. This is reproducible today against loopover's own UI: `apps/loopover-ui`
   *  forces dark mode unconditionally in its no-flash script (`components/site/theme-toggle.tsx`), never
   *  consulting the media feature at all, so a `light` vs `dark` capture of loopover's own site renders
   *  byte-identical regardless of this option. `themeStorageKey` below is the fallback for exactly that class
   *  of app. */
  theme?: ShotTheme;
  /** Also force `theme` via `localStorage.setItem(themeStorageKey, theme)` + a reload before capture (#4109),
   *  for apps (like metagraphed's own manual-screenshot convention) whose theme is driven by a stored
   *  preference rather than `prefers-color-scheme`. Configurable per-repo since the key name is
   *  app-specific — there is no universal convention. Only takes effect together with `theme`; omitted
   *  (every pre-#4109 caller) ⇒ no `localStorage` write and no reload, byte-identical to today. */
  themeStorageKey?: string;
}
type ScreenshotRequest = {
  url(): string;
  isNavigationRequest(): boolean;
  abort(): Promise<unknown>;
  continue(): Promise<unknown>;
};
type ScreenshotPage = {
  evaluate<T>(fn: () => T): Promise<T>;
  evaluate<T, A extends unknown[]>(fn: (...args: A) => T, ...args: A): Promise<T>;
  screenshot(options: { type: "png"; fullPage: true }): Promise<Uint8Array>;
};
// Viewport matrix (#4109): DELIBERATELY kept at 2 (desktop + mobile), not widened to metagraphed's 3-viewport
// manual convention (375×812 / 768×1024 / 1280×800). That convention is a human clicking through DevTools --
// free to run. This pipeline's cost is Browser Rendering wall-clock: every route already renders up to 4 PNGs
// (before+after × desktop+mobile), multiplied again by `review.visual.themes` when configured -- a 3rd
// viewport would raise that to 6 (a 50% jump) for every repo, every review, forever, not just the reviewer
// who wants tablet coverage. loopover's own pair already straddles a real breakpoint on each side (1440 is
// past a typical Tailwind `lg`; 390 is an iPhone-class portrait well under `sm`), so it is not an arbitrary
// choice either. If a repo genuinely needs tablet coverage, that is a `review.visual` opt-in follow-up
// (mirroring `routes.maxRoutes`'s per-repo override precedent) -- not a default-on cost increase for repos
// that never asked for a 3rd viewport.
export const DESKTOP_VIEWPORT: Viewport = { width: 1440, height: 900 };
export const MOBILE_VIEWPORT: Viewport = { width: 390, height: 844 }; // iPhone-class portrait
const VIEWPORT = DESKTOP_VIEWPORT;
// A sanity bound against a pathological infinite-scroll page, NOT a cost proxy -- cost is bounded by
// MAX_SCREENSHOT_PIXELS below, and separately by MAX_SCREENSHOT_BYTES.
//
// It used to be 10000, which was derived for the 1440-wide DESKTOP viewport (see the pixel cap's own
// comment: 1440 × 10000). Applied unchanged to the 390-wide MOBILE viewport it rejected captures costing a
// third as much: an ordinary long docs page renders ~10850px tall at 390 wide, which is 4.2M pixels against
// a 14.4M budget -- comfortably affordable, silently dropped. On the ORB that was 64 mobile screenshots
// discarded in a single hour, weakening the visual gate precisely on the viewport most likely to reveal a
// responsive regression.
//
// 20000 is empirically verified against this deployment's own renderer (browserless v2 / Chrome 149):
// a 390 × 20000 full-page capture returns 200 in ~157KB. The renderer was never the binding constraint.
// Desktop is unaffected -- 1440 × 20000 is 28.8M pixels and still fails the pixel cap.
export const MAX_SCREENSHOT_HEIGHT = 20000;
// The real cost ceiling: width × height, so a narrow-tall page is judged by what it actually costs to
// render rather than by height alone.
export const MAX_SCREENSHOT_PIXELS = 14_400_000; // 1440 × 10000 — one full desktop-width page.
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const SCREENSHOT_TIMEOUT_MS = 10000;
const SCREENSHOT_HEIGHT_PROBE_TIMEOUT_MS = 2_000;
const THEME_STORAGE_WRITE_TIMEOUT_MS = 2_000;
// The reload triggered by a configured `themeStorageKey` (#4109) waits for the same network-idle signal as
// the initial navigation, with the same bound -- a reload is not expected to be any slower than the first load.
const THEME_STORAGE_RELOAD_TIMEOUT_MS = 20000;

/** Per-call shot-route options: the R2 namespace (key prefix) + the production host for the on-demand render
 *  allowlist. Defaults to loopover so the /loopover/shot route works with no options. */
export interface ShotOptions {
  namespace?: string;
  productionUrl?: string;
}

// A loading placeholder for the "after" cell while the preview deploy renders. Same 1440×900 aspect ratio as
// a real screenshot so the table cell reserves space and never resizes when the image swaps in.
const LOADING_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1440 900" width="1440" height="900" role="img" aria-label="Rendering preview">
  <rect width="1440" height="900" fill="#0a1714"/>
  <g transform="translate(720 408)">
    <circle r="52" fill="none" stroke="#1f3b33" stroke-width="11"/>
    <path d="M0 -52 a52 52 0 0 1 52 52" fill="none" stroke="#9ef01a" stroke-width="11" stroke-linecap="round">
      <animateTransform attributeName="transform" type="rotate" from="0 0 0" to="360 0 0" dur="0.9s" repeatCount="indefinite"/>
    </path>
  </g>
  <text x="720" y="556" fill="#8aa39b" font-family="ui-monospace,Menlo,monospace" font-size="36" text-anchor="middle">Rendering preview…</text>
</svg>`;

// A STATIC placeholder for an "after" cell whose preview deploy FAILED (vs is still building). The spinner
// would lie here — it promises a render that is never coming — so this reads as a terminal state.
const FAILED_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1440 900" width="1440" height="900" role="img" aria-label="Preview deploy failed">
  <rect width="1440" height="900" fill="#1a0f0f"/>
  <g transform="translate(720 392)" fill="none" stroke="#f0741a" stroke-width="11" stroke-linecap="round" stroke-linejoin="round">
    <path d="M0 -56 L58 48 H-58 Z"/>
    <line x1="0" y1="-12" x2="0" y2="20"/>
    <circle cx="0" cy="40" r="1.5" stroke-width="14"/>
  </g>
  <text x="720" y="556" fill="#d99" font-family="ui-monospace,Menlo,monospace" font-size="36" text-anchor="middle">Preview deploy failed — review manually</text>
</svg>`;

// A placeholder for a route that redirected to a sign-in wall — an authenticated route we could not (and
// should not) screenshot as a misleading login screen. A padlock + an honest label.
const AUTH_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1440 900" width="1440" height="900" role="img" aria-label="Route requires authentication">
  <rect width="1440" height="900" fill="#0a1714"/>
  <g transform="translate(720 384)" fill="none" stroke="#8aa39b" stroke-width="10" stroke-linecap="round" stroke-linejoin="round">
    <rect x="-46" y="-8" width="92" height="74" rx="12"/>
    <path d="M-28 -8 v-26 a28 28 0 0 1 56 0 v26"/>
    <circle cx="0" cy="26" r="9" fill="#8aa39b" stroke="none"/>
  </g>
  <text x="720" y="556" fill="#8aa39b" font-family="ui-monospace,Menlo,monospace" font-size="36" text-anchor="middle">Route requires authentication — preview unavailable</text>
</svg>`;

/** True when `url`'s path looks like a sign-in / auth wall. Used to avoid presenting a screenshot of the
 *  login screen as the route's preview. */
function isAuthWallUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const p = new URL(url).pathname.toLowerCase();
    return /(^|\/)(login|signin|sign-in|sign_in|auth|oauth|authenticate)(\/|$)/.test(p);
  } catch {
    return false;
  }
}

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Host allowlist for the on-demand `?url=` render: only Cloudflare preview hosts (*.workers.dev /
 *  *.pages.dev) and the configured production host (PUBLIC_SITE_ORIGIN, or a per-call productionUrl). */
function isAllowedHost(targetUrl: string, env: Env, productionUrl?: string): boolean {
  const host = hostOf(targetUrl);
  if (!host) return false;
  if (host.endsWith(".workers.dev") || host.endsWith(".pages.dev")) return true;
  if (host === hostOf(productionUrl)) return true;
  if (host === hostOf(env.PUBLIC_SITE_ORIGIN)) return true;
  return false;
}

// #9044 (LOW severity per the issue's own triage -- the eventual output is just a PNG the attacker already
// controls the source page of): bounds the best-effort DNS-resolution pin below so an unresponsive resolver
// can never hang a capture -- mirrors every other bounded probe in this file (SCREENSHOT_HEIGHT_PROBE_TIMEOUT_MS
// et al).
const DNS_PIN_LOOKUP_TIMEOUT_MS = 1_500;

/**
 * Best-effort DNS-resolution pin (#9044): `isSafeHttpUrl`'s SSRF guard is purely NAME-based, so a PUBLIC
 * hostname whose A/AAAA record happens to resolve to a disallowed address (loopback / private / link-local,
 * including cloud metadata 169.254.169.254) passes it even though the real TCP connection would land
 * somewhere private. This resolves the hostname ONCE, up front, via Node's own resolver, and rejects it when
 * the resolved address is itself disallowed.
 *
 * NOT airtight, and deliberately not pretending to be: this is a single point-in-time resolution on OUR
 * side, not a pinned connection -- Chromium performs its OWN DNS resolution when it actually navigates, and
 * neither Puppeteer's API nor the CDP request-interception this file already uses (`page.on('request', ...)`)
 * exposes a way to force Chromium's socket to reuse the exact address validated here, so a DNS record that
 * changes between this check and Chromium's real connect (TOCTOU) can still slip through. Fails OPEN (true)
 * on any error, on a timeout, or on a runtime with no working `node:dns` (Cloudflare Workers has no real
 * socket-level resolution to offer here) -- this is ONE MORE defense-in-depth layer alongside isSafeHttpUrl's
 * name check and the per-request interception re-checks below, never the sole guard, so failing open here
 * matches this whole file's existing fail-open-to-the-other-guards posture.
 */
async function isDnsResolutionSafe(url: string): Promise<boolean> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    // Unreachable via every public entry point: isSafeHttpUrl (checked by the same `||` guard, before this
    // function ever runs) already calls `new URL()` itself and rejects an unparseable url first. Retained
    // as defense-in-depth for a hypothetical future direct caller, mirroring safe-url.ts's own convention for
    // guards that are provably unreachable today given the current call sites.
    /* v8 ignore next -- @preserve unreachable: isSafeHttpUrl already rejects an unparseable url first */
    return true;
  }
  // A single try/catch for BOTH the dynamic import (fails only on a runtime with no working `node:dns`, e.g.
  // Cloudflare Workers) and the lookup call itself (fails on an unresolvable/erroring hostname) -- both land
  // on the exact same fail-open outcome, so there is no behavioral reason to distinguish them.
  try {
    const { lookup } = await import("node:dns/promises");
    const result = await Promise.race([
      lookup(hostname),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), DNS_PIN_LOOKUP_TIMEOUT_MS)),
    ]);
    if (!result) return true; // timed out -- fail open, same posture as every other guard in this file
    return !hostIsPrivateOrLocal(result.address);
  } catch {
    return true; // no working node:dns, or an unresolvable/erroring lookup -- fail open
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Reads a PNG's real width/height straight from its IHDR chunk -- Chromium's own rasterized output, not a
 *  value the screenshotted page's JavaScript can influence. Returns null (fail-closed) for anything that
 *  isn't a well-formed PNG IHDR header, which the caller must treat as "reject", not "skip the check". */
function readPngDimensions(png: Uint8Array): { width: number; height: number } | null {
  if (png.byteLength < 24) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (png[i] !== PNG_SIGNATURE[i]) return null;
  }
  if (String.fromCharCode(png[12]!, png[13]!, png[14]!, png[15]!) !== "IHDR") return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
}

async function forceThemeStorage(page: ScreenshotPage, storageKey: string, storageValue: ShotTheme): Promise<boolean> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const write = page.evaluate(
    (key: string, value: string) => {
      try {
        (globalThis as unknown as { localStorage: Storage }).localStorage.setItem(key, value);
      } catch {
        // Storage can be unavailable (privacy mode, disabled storage, a cross-origin frame, etc.) -- best-effort only.
      }
    },
    storageKey,
    storageValue,
  );
  const completed = await Promise.race([
    write.then(() => true, () => true),
    new Promise<false>((resolve) => {
      timeoutId = setTimeout(() => resolve(false), THEME_STORAGE_WRITE_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timeoutId as ReturnType<typeof setTimeout>);
  if (!completed) console.log(JSON.stringify({ event: "render_theme_storage_write_timeout", timeoutMs: THEME_STORAGE_WRITE_TIMEOUT_MS }));
  return completed;
}

async function captureBoundedFullPageShot(page: ScreenshotPage, viewport: Viewport): Promise<Uint8Array | null> {
  // Fast-path only: this executes inside the screenshotted PAGE's own JS realm, so a hostile page can override
  // scrollHeight/offsetHeight getters (e.g. via Object.defineProperty) to under-report its height and sail
  // through this check -- it does not by itself guard anything (#3712 security review). Real enforcement is
  // the post-capture dimension re-check below, against Chromium's actual rasterized output. Keep this probe
  // time-bounded too: hostile getters/globals can hang before the screenshot timeout is even armed.
  let heightProbeTimeoutId: ReturnType<typeof setTimeout> | undefined;
  const height = await Promise.race([
    page.evaluate(() => {
      const doc = (globalThis as unknown as { document: { body: { scrollHeight: number; offsetHeight: number }; documentElement: { clientHeight: number; scrollHeight: number; offsetHeight: number } } }).document;
      const body = doc.body;
      const element = doc.documentElement;
      return Math.ceil(Math.max(body.scrollHeight, body.offsetHeight, element.clientHeight, element.scrollHeight, element.offsetHeight));
    }),
    new Promise<null>((resolve) => {
      heightProbeTimeoutId = setTimeout(() => resolve(null), SCREENSHOT_HEIGHT_PROBE_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(heightProbeTimeoutId as ReturnType<typeof setTimeout>);
  if (height === null) {
    console.log(JSON.stringify({ event: "render_screenshot_height_probe_timeout", timeoutMs: SCREENSHOT_HEIGHT_PROBE_TIMEOUT_MS }));
    return null;
  }
  const pixelArea = viewport.width * height;
  if (height > MAX_SCREENSHOT_HEIGHT || pixelArea > MAX_SCREENSHOT_PIXELS) {
    console.log(JSON.stringify({ event: "render_screenshot_too_large", width: viewport.width, height, maxHeight: MAX_SCREENSHOT_HEIGHT, maxPixels: MAX_SCREENSHOT_PIXELS }));
    return null;
  }

  const shot = await Promise.race([
    page.screenshot({ type: "png", fullPage: true }),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), SCREENSHOT_TIMEOUT_MS)),
  ]);
  if (!shot) {
    console.log(JSON.stringify({ event: "render_screenshot_timeout", timeoutMs: SCREENSHOT_TIMEOUT_MS }));
    return null;
  }
  if (shot.byteLength > MAX_SCREENSHOT_BYTES) {
    console.log(JSON.stringify({ event: "render_screenshot_bytes_too_large", bytes: shot.byteLength, maxBytes: MAX_SCREENSHOT_BYTES }));
    return null;
  }
  // Re-validate against the ACTUAL rendered PNG dimensions -- these come from Chromium's rasterizer, not page
  // script, so the height spoof above cannot reach them. Anything that isn't a readable PNG header is rejected
  // rather than let through, since that's precisely what a successful spoof would look like from here.
  const dims = readPngDimensions(shot);
  if (!dims || dims.height > MAX_SCREENSHOT_HEIGHT || dims.width * dims.height > MAX_SCREENSHOT_PIXELS) {
    console.log(JSON.stringify({ event: "render_screenshot_dimensions_too_large", width: dims?.width ?? null, height: dims?.height ?? null, maxHeight: MAX_SCREENSHOT_HEIGHT, maxPixels: MAX_SCREENSHOT_PIXELS }));
    return null;
  }
  return shot;
}

/**
 * `captureShot`'s outcome. `renderFailed` (#9464) separates "the RENDERER broke" -- a browserless outage, a
 * navigation timeout, a binding quota error, a Chromium crash -- from every other reason `png` can be null:
 * an SSRF/redirect refusal, an auth wall, or visual review simply not being configured (`!env.BROWSER`).
 *
 * The distinction is load-bearing, not cosmetic. The screenshot-table gate reads "no bot capture" as "the
 * author supplied no visual evidence" and CLOSES the PR one-shot. Only the renderer-broke case is a false
 * negative that must defer that close; the others are accurate answers the gate should keep acting on. Basing
 * the signal on "zero pairs were produced" instead would fold all of them together and neuter the gate.
 */
export interface CaptureShotResult {
  png: Uint8Array | null;
  authWalled: boolean;
  /** True ONLY for a thrown renderer error (the `catch` below). Never for a refusal or an unconfigured binding. */
  renderFailed: boolean;
}

/**
 * Render a page to a PNG via the Browser Rendering binding, also reporting whether the route redirected to a
 * sign-in wall. `authWalled` is true when the FINAL url looks like a login page that the REQUESTED url was
 * not — the caller then shows an honest "requires authentication" placeholder instead of a screenshot of the
 * login screen. `png` is null on any render failure (callers degrade gracefully).
 */
export async function captureShot(env: Env, url: string, viewport: Viewport = VIEWPORT, opts: CaptureShotOptions = {}): Promise<CaptureShotResult> {
  // SSRF defense-in-depth: NEVER navigate the headless browser to a non-public host (loopback / link-local /
  // private / cloud-metadata 169.254.169.254 / etc.). Callers may resolve `url` from a deployment_status
  // webhook or a PR-comment preview link, so guard at this choke point regardless of how the URL was obtained.
  if (!url || !isSafeHttpUrl(url) || (opts.isAllowedUrl && !opts.isAllowedUrl(url)) || !(await isDnsResolutionSafe(url))) {
    console.log(JSON.stringify({ event: "render_screenshot_blocked", url: String(url).slice(0, 120) }));
    return { png: null, authWalled: false, renderFailed: false };
  }
  if (!env.BROWSER) return { png: null, authWalled: false, renderFailed: false };
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    browser = await puppeteer.launch(env.BROWSER as unknown as Parameters<typeof puppeteer.launch>[0]);
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", (request: ScreenshotRequest) => {
      const requestUrl = request.url();
      let protocol = "";
      try {
        protocol = new URL(requestUrl).protocol;
      } catch {
        request.abort().catch(() => undefined);
        return;
      }
      if (protocol === "http:" || protocol === "https:") {
        const isAllowedNavigation = !request.isNavigationRequest() || !opts.isAllowedUrl || opts.isAllowedUrl(requestUrl);
        if (!isSafeHttpUrl(requestUrl) || !isAllowedNavigation) {
          console.log(JSON.stringify({ event: "render_screenshot_request_blocked", url: requestUrl.slice(0, 120) }));
          request.abort().catch(() => undefined);
          return;
        }
      }
      request.continue().catch(() => undefined);
    });
    await page.setViewport(viewport);
    if (opts.theme) await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: opts.theme }]);
    await page.goto(url, { waitUntil: "networkidle0", timeout: 20000 });
    if (!isSafeHttpUrl(page.url()) || (opts.isAllowedUrl && !opts.isAllowedUrl(page.url()))) {
      console.log(JSON.stringify({ event: "render_screenshot_redirect_blocked", url, final: page.url().slice(0, 200) }));
      return { png: null, authWalled: false, renderFailed: false };
    }
    // A protected route that redirected to a login page: don't return a screenshot of the sign-in screen —
    // flag it so the caller renders an honest auth placeholder. (The requested URL not itself being a login
    // page guards a PR that legitimately changes the login screen.)
    if (isAuthWallUrl(page.url()) && !isAuthWallUrl(url)) {
      console.log(JSON.stringify({ event: "render_screenshot_auth_walled", url, final: page.url().slice(0, 200) }));
      return { png: null, authWalled: true, renderFailed: false };
    }
    // A configured themeStorageKey (#4109) ALSO forces the theme via localStorage, then reloads so the
    // app's own theme-init logic re-runs against the new stored value -- the fallback for a target whose
    // theming ignores prefers-color-scheme (see CaptureShotOptions.theme's doc for what this fixes and why).
    // Only after the safe-url/auth-wall checks above, so a page we're about to reject never pays for a reload.
    if (opts.theme && opts.themeStorageKey) {
      const storageKey = opts.themeStorageKey;
      const storageValue = opts.theme;
      // A failed localStorage write is the PAGE refusing (storage disabled/partitioned), not the renderer
      // breaking -- the browser is demonstrably alive, since it navigated and ran script to get here.
      if (!(await forceThemeStorage(page, storageKey, storageValue))) return { png: null, authWalled: false, renderFailed: false };
      await page.reload({ waitUntil: "networkidle0", timeout: THEME_STORAGE_RELOAD_TIMEOUT_MS });
    }
    // Full-page (not just the viewport), but bounded: before/after should include the same page position for
    // normal review pages without letting attacker-controlled document height or PNG size drive unbounded
    // Chromium raster work on the public screenshot route.
    const shot = await captureBoundedFullPageShot(page, viewport);
    incr("loopover_visual_capture_total", { result: "ok" });
    return { png: shot, authWalled: false, renderFailed: false };
  } catch (error) {
    // Log before degrading to null — otherwise a networkidle0 timeout, a binding quota error, or a render
    // crash is indistinguishable from "no page" and the cell silently blanks.
    // #9487: also COUNTED. The log alone is invisible to Prometheus, so a browserless outage silently degraded
    // every screenshot to a dash cell with nothing to alert on -- and, because the screenshot-table gate treats
    // absent evidence as a close signal, that outage could close legitimate visual PRs before anyone noticed.
    incr("loopover_visual_capture_total", { result: "error" });
    console.log(JSON.stringify({ event: "render_screenshot_error", mode: "binding", url, message: String(error).slice(0, 200) }));
    // #9464: the ONLY site that reports renderFailed. Everything above returned a definite answer; this is the
    // one path where we do not know what the page looks like because the renderer itself failed to tell us.
    return { png: null, authWalled: false, renderFailed: true };
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}

/** Back-compat thin wrapper: render a page to a PNG (or null on failure / auth wall). The on-demand
 *  `/shot?url=` route uses this; the capture pipeline uses `captureShot` to also learn `authWalled`. */
async function renderScreenshot(env: Env, url: string, viewport: Viewport = VIEWPORT, opts: CaptureShotOptions = {}): Promise<Uint8Array | null> {
  return (await captureShot(env, url, viewport, opts)).png;
}

// A scroll-through capture is deliberately narrow (#3612): a fixed number of viewport-cropped frames taken
// while scrolling straight down the page, not a general "record any interaction" system. This is sufficient
// evidence for scroll-linked behavior (parallax, reveal-on-scroll, a sticky header) without the much harder,
// speculative problem of inferring WHICH interaction a change actually affects.
const MAX_SCROLL_STEPS = 6;
// Lets a scroll-linked CSS transition/JS listener finish reacting before the frame is captured — short enough
// that 6 steps stays a quick "evidence" clip, long enough that a typical transition (150–300ms) has settled.
const SCROLL_SETTLE_MS = 350;
const SCROLL_EVALUATE_TIMEOUT_MS = 2_000;

async function withScrollOperationTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`scroll ${label} timed out after ${SCROLL_EVALUATE_TIMEOUT_MS}ms`)), SCROLL_EVALUATE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timeoutId as ReturnType<typeof setTimeout>);
  }
}

async function waitForScrollSettle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, SCROLL_SETTLE_MS));
}

/**
 * Capture a short sequence of viewport-cropped frames while scrolling `url` from top to bottom, for assembly
 * into a scroll-through GIF (#3612) — evidence for scroll-linked behavior that a single static screenshot
 * can't show. Mirrors `captureShot`'s SSRF guard, sub-request interception, and auth-wall detection exactly
 * (duplicated rather than shared: this is security-sensitive code, and the two functions diverge only in
 * what they do with the page once navigation succeeds). A page shorter than one viewport yields a single
 * frame — nothing to scroll through, so no point animating a static page. `frames` is empty on any failure
 * (callers degrade gracefully, same contract as `captureShot` returning a null `png`).
 */
export async function captureScrollFrames(env: Env, url: string, viewport: Viewport = VIEWPORT, opts: CaptureShotOptions = {}): Promise<{ frames: Uint8Array[]; authWalled: boolean }> {
  if (!url || !isSafeHttpUrl(url) || (opts.isAllowedUrl && !opts.isAllowedUrl(url)) || !(await isDnsResolutionSafe(url))) {
    console.log(JSON.stringify({ event: "render_scroll_frames_blocked", url: String(url).slice(0, 120) }));
    return { frames: [], authWalled: false };
  }
  if (!env.BROWSER) return { frames: [], authWalled: false };
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    browser = await puppeteer.launch(env.BROWSER as unknown as Parameters<typeof puppeteer.launch>[0]);
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", (request: ScreenshotRequest) => {
      const requestUrl = request.url();
      let protocol = "";
      try {
        protocol = new URL(requestUrl).protocol;
      } catch {
        request.abort().catch(() => undefined);
        return;
      }
      if (protocol === "http:" || protocol === "https:") {
        const isAllowedNavigation = !request.isNavigationRequest() || !opts.isAllowedUrl || opts.isAllowedUrl(requestUrl);
        if (!isSafeHttpUrl(requestUrl) || !isAllowedNavigation) {
          console.log(JSON.stringify({ event: "render_scroll_frames_request_blocked", url: requestUrl.slice(0, 120) }));
          request.abort().catch(() => undefined);
          return;
        }
      }
      request.continue().catch(() => undefined);
    });
    await page.setViewport(viewport);
    if (opts.theme) await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: opts.theme }]);
    await page.goto(url, { waitUntil: "networkidle0", timeout: 20000 });
    if (!isSafeHttpUrl(page.url()) || (opts.isAllowedUrl && !opts.isAllowedUrl(page.url()))) {
      console.log(JSON.stringify({ event: "render_scroll_frames_redirect_blocked", url, final: page.url().slice(0, 200) }));
      return { frames: [], authWalled: false };
    }
    if (isAuthWallUrl(page.url()) && !isAuthWallUrl(url)) {
      console.log(JSON.stringify({ event: "render_scroll_frames_auth_walled", url, final: page.url().slice(0, 200) }));
      return { frames: [], authWalled: true };
    }
    // A configured themeStorageKey (#4109) ALSO forces the theme via localStorage, then reloads -- mirrors
    // captureShot's own fallback exactly (see CaptureShotOptions.theme's doc for what this fixes and why).
    if (opts.theme && opts.themeStorageKey) {
      const storageKey = opts.themeStorageKey;
      const storageValue = opts.theme;
      if (!(await forceThemeStorage(page, storageKey, storageValue))) return { frames: [], authWalled: false };
      await page.reload({ waitUntil: "networkidle0", timeout: THEME_STORAGE_RELOAD_TIMEOUT_MS });
    }
    // `document`/`window` below run inside the real page (the callback is serialized and executed in the
    // browser realm, not this Worker/Node one) — this project's `lib` deliberately excludes `dom` (it would
    // shadow the Workers-runtime `Request`/`Response` globals used everywhere else), so these two reach the
    // browser globals via `globalThis` instead of the bare identifiers, which don't resolve at compile time.
    const scrollHeight = await withScrollOperationTimeout(
      page.evaluate(() => (globalThis as unknown as { document: { documentElement: { scrollHeight: number } } }).document.documentElement.scrollHeight),
      "height",
    );
    const maxScroll = Math.max(0, scrollHeight - viewport.height);
    const stepCount = maxScroll === 0 ? 1 : MAX_SCROLL_STEPS;
    const frames: Uint8Array[] = [];
    for (let step = 0; step < stepCount; step++) {
      const position = stepCount === 1 ? 0 : Math.round((maxScroll * step) / (stepCount - 1));
      await withScrollOperationTimeout(
        page.evaluate((y) => (globalThis as unknown as { window: { scrollTo: (x: number, yPos: number) => void } }).window.scrollTo(0, y), position),
        "scroll",
      );
      await waitForScrollSettle();
      frames.push((await page.screenshot({ type: "png", fullPage: false })) as Uint8Array);
    }
    return { frames, authWalled: false };
  } catch (error) {
    console.log(JSON.stringify({ event: "render_scroll_frames_error", mode: "binding", url, message: String(error).slice(0, 200) }));
    return { frames: [], authWalled: false };
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}

// Mirrors MAX_SCROLL_STEPS/SCROLL_SETTLE_MS's reasoning above: a fixed, small number of post-interaction
// frames is enough evidence for a hover/click-triggered CSS transition or state change without turning this
// into an unbounded "record everything" system. One extra frame at rest (step 0, before the interaction
// fires) plus 3 post-interaction frames covers "mid-transition" and "settled" without much added cost.
const MAX_INTERACTION_STEPS = 4;
const INTERACTION_ELEMENT_TIMEOUT_MS = 3_000;
// A drag needs enough intermediate mouse-move events for a drag-and-drop library's own dragover/mousemove
// listeners to register motion (a single instant jump from source to destination often fails to trigger a
// library's drop-target highlighting) — 8 steps is a cheap, smooth-enough interpolation without materially
// adding to this capture mode's already-heaviest-in-class cost (mirrors MAX_SCROLL_STEPS's reasoning: enough
// to be convincing evidence, not a frame-perfect recording).
const DRAG_MOVE_STEPS = 8;

export type InteractionAction = "hover" | "click" | "drag";

/** Drag `source` onto `destination` via a real mouse-down → interpolated-move → mouse-up sequence, using each
 *  element's own bounding-box CENTER as the drag/drop point. A `null` bounding box (a display:none or
 *  zero-size element) means there is nothing visibly draggable to animate — a no-op, not an error, matching
 *  this whole capture mode's fail-open contract. Interpolating {@link DRAG_MOVE_STEPS} intermediate positions
 *  (rather than one instant jump) mirrors how a real user drags and is what most drag-and-drop libraries'
 *  own dragover/mousemove listeners need to actually register motion and highlight a drop target.
 *
 *  Scrolls each element into view (sequentially, before reading ITS OWN bounding box) the same way Puppeteer's
 *  own `hover()`/`click()` do internally for a single element — `boundingBox()` alone does not scroll, so a
 *  drag source/destination below the fold (the documented use case: "a reorderable list/kanban card") would
 *  otherwise read a stale/off-viewport position and target the wrong screen point. Scrolling to the
 *  destination after already reading the source's box is safe even if it scrolls the source back out of
 *  view — the source's coordinates were already captured and the mouse sequence below uses those fixed
 *  numbers, not a live re-query. */
async function performDrag(
  page: { mouse: { move: (x: number, y: number) => Promise<void>; down: () => Promise<void>; up: () => Promise<void> } },
  source: { boundingBox: () => Promise<{ x: number; y: number; width: number; height: number } | null>; scrollIntoViewIfNeeded?: () => Promise<void> },
  destination: { boundingBox: () => Promise<{ x: number; y: number; width: number; height: number } | null>; scrollIntoViewIfNeeded?: () => Promise<void> },
): Promise<void> {
  await source.scrollIntoViewIfNeeded?.().catch(() => undefined);
  const sourceBox = await source.boundingBox();
  await destination.scrollIntoViewIfNeeded?.().catch(() => undefined);
  const destinationBox = await destination.boundingBox();
  if (!sourceBox || !destinationBox) return;
  const sourceX = sourceBox.x + sourceBox.width / 2;
  const sourceY = sourceBox.y + sourceBox.height / 2;
  const destinationX = destinationBox.x + destinationBox.width / 2;
  const destinationY = destinationBox.y + destinationBox.height / 2;
  await page.mouse.move(sourceX, sourceY);
  await page.mouse.down();
  for (let step = 1; step <= DRAG_MOVE_STEPS; step++) {
    const t = step / DRAG_MOVE_STEPS;
    await page.mouse.move(sourceX + (destinationX - sourceX) * t, sourceY + (destinationY - sourceY) * t);
  }
  await page.mouse.up();
}

/**
 * Capture a short sequence of frames around a specific interaction: one frame at rest, then trigger `action`
 * on `selector` (a drag onto `dragTo` when `action` is `"drag"`), then a few more frames at intervals to
 * catch a CSS transition or JS-driven state change mid-flight and settled — evidence for a hover-triggered
 * popover, a click-triggered state change, a drag-and-drop reorder, or similar behavior a single static
 * screenshot can't show.
 *
 * Mirrors `captureScrollFrames`'s SSRF guard, sub-request interception, and auth-wall detection exactly
 * (duplicated rather than shared — see that function's own doc comment for why). `selector`/`dragTo` matching
 * nothing on the page is NOT an error — it's a normal "this interaction doesn't apply to this side" outcome
 * (e.g. an element only present after the PR's change adds it): returns empty frames, the same fail-open
 * contract as every other capture failure here.
 */
export async function captureInteractionFrames(
  env: Env,
  url: string,
  selector: string,
  action: InteractionAction,
  viewport: Viewport = VIEWPORT,
  opts: CaptureShotOptions = {},
  dragTo?: string | undefined,
): Promise<{ frames: Uint8Array[]; authWalled: boolean }> {
  if (!url || !isSafeHttpUrl(url) || (opts.isAllowedUrl && !opts.isAllowedUrl(url)) || !(await isDnsResolutionSafe(url))) {
    console.log(JSON.stringify({ event: "render_interaction_frames_blocked", url: String(url).slice(0, 120) }));
    return { frames: [], authWalled: false };
  }
  if (!env.BROWSER) return { frames: [], authWalled: false };
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    browser = await puppeteer.launch(env.BROWSER as unknown as Parameters<typeof puppeteer.launch>[0]);
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", (request: ScreenshotRequest) => {
      const requestUrl = request.url();
      let protocol = "";
      try {
        protocol = new URL(requestUrl).protocol;
      } catch {
        request.abort().catch(() => undefined);
        return;
      }
      if (protocol === "http:" || protocol === "https:") {
        const isAllowedNavigation = !request.isNavigationRequest() || !opts.isAllowedUrl || opts.isAllowedUrl(requestUrl);
        if (!isSafeHttpUrl(requestUrl) || !isAllowedNavigation) {
          console.log(JSON.stringify({ event: "render_interaction_frames_request_blocked", url: requestUrl.slice(0, 120) }));
          request.abort().catch(() => undefined);
          return;
        }
      }
      request.continue().catch(() => undefined);
    });
    await page.setViewport(viewport);
    if (opts.theme) await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: opts.theme }]);
    await page.goto(url, { waitUntil: "networkidle0", timeout: 20000 });
    if (!isSafeHttpUrl(page.url()) || (opts.isAllowedUrl && !opts.isAllowedUrl(page.url()))) {
      console.log(JSON.stringify({ event: "render_interaction_frames_redirect_blocked", url, final: page.url().slice(0, 200) }));
      return { frames: [], authWalled: false };
    }
    if (isAuthWallUrl(page.url()) && !isAuthWallUrl(url)) {
      console.log(JSON.stringify({ event: "render_interaction_frames_auth_walled", url, final: page.url().slice(0, 200) }));
      return { frames: [], authWalled: true };
    }
    // A configured themeStorageKey (#4109) ALSO forces the theme via localStorage, then reloads -- mirrors
    // captureShot's own fallback exactly (see CaptureShotOptions.theme's doc for what this fixes and why).
    if (opts.theme && opts.themeStorageKey) {
      const storageKey = opts.themeStorageKey;
      const storageValue = opts.theme;
      if (!(await forceThemeStorage(page, storageKey, storageValue))) return { frames: [], authWalled: false };
      await page.reload({ waitUntil: "networkidle0", timeout: THEME_STORAGE_RELOAD_TIMEOUT_MS });
    }
    const element = await page.waitForSelector(selector, { timeout: INTERACTION_ELEMENT_TIMEOUT_MS }).catch(() => null);
    if (!element) {
      console.log(JSON.stringify({ event: "render_interaction_frames_selector_not_found", url, selector: selector.slice(0, 120) }));
      return { frames: [], authWalled: false };
    }
    let dragToElement: typeof element | null = null;
    if (action === "drag") {
      if (!dragTo) {
        console.log(JSON.stringify({ event: "render_interaction_frames_missing_drag_target", url, selector: selector.slice(0, 120) }));
        return { frames: [], authWalled: false };
      }
      dragToElement = await page.waitForSelector(dragTo, { timeout: INTERACTION_ELEMENT_TIMEOUT_MS }).catch(() => null);
      if (!dragToElement) {
        console.log(JSON.stringify({ event: "render_interaction_frames_drag_target_not_found", url, dragTo: dragTo.slice(0, 120) }));
        return { frames: [], authWalled: false };
      }
    }
    const frames: Uint8Array[] = [];
    // Frame 0: the at-rest state, before the interaction fires — the "before" half of the animated evidence.
    frames.push((await page.screenshot({ type: "png", fullPage: false })) as Uint8Array);
    if (action === "hover") {
      await element.hover();
    } else if (action === "click") {
      await element.click();
    } else {
      await performDrag(page, element, dragToElement!);
    }
    for (let step = 1; step < MAX_INTERACTION_STEPS; step++) {
      // Reuses captureScrollFrames' own settle delay (SCROLL_SETTLE_MS/waitForScrollSettle above) rather than
      // a second, numerically-identical constant+function -- same 350ms "long enough for a typical transition,
      // short enough to stay a quick evidence clip" reasoning applies to a post-interaction frame too.
      await waitForScrollSettle();
      frames.push((await page.screenshot({ type: "png", fullPage: false })) as Uint8Array);
    }
    return { frames, authWalled: false };
  } catch (error) {
    console.log(JSON.stringify({ event: "render_interaction_frames_error", mode: "binding", url, message: String(error).slice(0, 200) }));
    return { frames: [], authWalled: false };
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}

export async function handleShot(request: Request, env: Env, opts: ShotOptions = {}): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const r2Prefix = `${opts.namespace ?? "loopover"}/shots/`;

  // Mode 0: a placeholder for an "after" cell with no real screenshot yet — the animated spinner (preview
  // still building), the static "deploy failed" card (preview won't come), or the auth-wall card.
  const placeholder = params.get("placeholder");
  if (placeholder === "loading" || placeholder === "failed" || placeholder === "auth") {
    const svg = placeholder === "failed" ? FAILED_SVG : placeholder === "auth" ? AUTH_SVG : LOADING_SVG;
    return new Response(svg, {
      headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=60" },
    });
  }

  // Mode A: serve a pre-rendered screenshot from R2 (fast path for the image proxy). The key MUST be inside
  // our R2 prefix and MUST NOT traverse — so a crafted ?key= can never read another object.
  const key = params.get("key");
  if (key) {
    if (!key.startsWith(r2Prefix) || key.includes("..")) {
      return new Response("bad key", { status: 400 });
    }
    const object = await env.REVIEW_AUDIT?.get(key);
    if (!object) return new Response("not found", { status: 404 });
    // By extension, not stored httpMetadata: the self-host filesystem blob store never round-trips it (see
    // src/selfhost/blob-store.ts), so a GIF (#3612) served with a hardcoded image/png content-type would
    // fail to animate in most viewers even though the bytes themselves are a perfectly valid GIF.
    const contentType = key.endsWith(".gif") ? "image/gif" : "image/png";
    return new Response(object.body, {
      headers: { "content-type": contentType, "cache-control": "public, max-age=86400, immutable" },
    });
  }

  // Mode B: render on demand (host-allowlisted + SSRF-guarded). Optional &w=&h= selects the viewport;
  // optional &theme= (#3678) emulates prefers-color-scheme — an unrecognized value is ignored (falls back to
  // no emulation) rather than rejecting the whole request over a cosmetic param. Optional &themeStorageKey=
  // (#4109) ALSO forces the theme via localStorage + reload — only applied alongside a recognized &theme=,
  // same as capturePage's own guard.
  const target = params.get("url");
  if (!target || !isSafeHttpUrl(target)) return new Response("bad url", { status: 400 });
  if (!isAllowedHost(target, env, opts.productionUrl)) return new Response("forbidden host", { status: 403 });
  const w = Number(params.get("w"));
  const h = Number(params.get("h"));
  const viewport: Viewport = Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0 ? { width: Math.min(w, 2560), height: Math.min(h, 2560) } : DESKTOP_VIEWPORT;
  const requestedTheme = params.get("theme");
  const theme: ShotTheme | undefined = requestedTheme === "light" || requestedTheme === "dark" ? requestedTheme : undefined;
  const requestedThemeStorageKey = params.get("themeStorageKey");
  const themeStorageKey: string | undefined = theme && requestedThemeStorageKey ? requestedThemeStorageKey : undefined;
  const png = await renderScreenshot(env, target, viewport, {
    isAllowedUrl: (candidate) => isAllowedHost(candidate, env, opts.productionUrl),
    ...(theme ? { theme } : {}),
    ...(themeStorageKey ? { themeStorageKey } : {}),
  });
  if (!png) return new Response("screenshot unavailable", { status: 502 });
  // png is always a plain (never shared) ArrayBuffer view — the cast only narrows the TYPE for the UI
  // workspace's stricter DOM-lib BodyInit, which excludes SharedArrayBuffer from ArrayBufferLike.
  return new Response(png as Uint8Array<ArrayBuffer>, {
    headers: { "content-type": "image/png", "cache-control": "public, max-age=300" },
  });
}
