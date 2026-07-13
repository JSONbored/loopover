// Screenshot endpoint for the realtime before/after capture (reviewbot→gittensory convergence — visual port).
//
// PORTED from reviewbot's src/agents/gittensory/shot.ts. CHANGES for gittensory:
//   • puppeteer import unchanged (@cloudflare/puppeteer), SSRF guard now isSafeHttpUrl from ../content-lane/safe-url
//   • bindings: env.BROWSER (Browser Rendering) + env.REVIEW_AUDIT (R2) — gittensory's R2 binding is
//     REVIEW_AUDIT, NOT reviewbot's env.AUDIT.
//   • r2 key prefix default 'loopover/shots/'; on-demand render allowlist's production host = PUBLIC_SITE_ORIGIN.
//   • no reviewbot REVIEWBOT_* secrets / REST fallback — gittensory renders via the BROWSER binding only.
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
import { isSafeHttpUrl } from "../content-lane/safe-url";

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
   *  `prefers-color-scheme`. This is reproducible today against gittensory's own UI: `apps/gittensory-ui`
   *  forces dark mode unconditionally in its no-flash script (`components/site/theme-toggle.tsx`), never
   *  consulting the media feature at all, so a `light` vs `dark` capture of gittensory's own site renders
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
// who wants tablet coverage. gittensory's own pair already straddles a real breakpoint on each side (1440 is
// past a typical Tailwind `lg`; 390 is an iPhone-class portrait well under `sm`), so it is not an arbitrary
// choice either. If a repo genuinely needs tablet coverage, that is a `review.visual` opt-in follow-up
// (mirroring `routes.maxRoutes`'s per-repo override precedent) -- not a default-on cost increase for repos
// that never asked for a 3rd viewport.
export const DESKTOP_VIEWPORT: Viewport = { width: 1440, height: 900 };
export const MOBILE_VIEWPORT: Viewport = { width: 390, height: 844 }; // iPhone-class portrait
const VIEWPORT = DESKTOP_VIEWPORT;
export const MAX_SCREENSHOT_HEIGHT = 10000;
export const MAX_SCREENSHOT_PIXELS = 14_400_000; // 1440 × 10000, matching the full-page cap.
export const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
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
export function isAuthWallUrl(url: string | undefined): boolean {
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
 * Render a page to a PNG via the Browser Rendering binding, also reporting whether the route redirected to a
 * sign-in wall. `authWalled` is true when the FINAL url looks like a login page that the REQUESTED url was
 * not — the caller then shows an honest "requires authentication" placeholder instead of a screenshot of the
 * login screen. `png` is null on any render failure (callers degrade gracefully).
 */
export async function captureShot(env: Env, url: string, viewport: Viewport = VIEWPORT, opts: CaptureShotOptions = {}): Promise<{ png: Uint8Array | null; authWalled: boolean }> {
  // SSRF defense-in-depth: NEVER navigate the headless browser to a non-public host (loopback / link-local /
  // private / cloud-metadata 169.254.169.254 / etc.). Callers may resolve `url` from a deployment_status
  // webhook or a PR-comment preview link, so guard at this choke point regardless of how the URL was obtained.
  if (!url || !isSafeHttpUrl(url) || (opts.isAllowedUrl && !opts.isAllowedUrl(url))) {
    console.log(JSON.stringify({ event: "render_screenshot_blocked", url: String(url).slice(0, 120) }));
    return { png: null, authWalled: false };
  }
  if (!env.BROWSER) return { png: null, authWalled: false };
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
      return { png: null, authWalled: false };
    }
    // A protected route that redirected to a login page: don't return a screenshot of the sign-in screen —
    // flag it so the caller renders an honest auth placeholder. (The requested URL not itself being a login
    // page guards a PR that legitimately changes the login screen.)
    if (isAuthWallUrl(page.url()) && !isAuthWallUrl(url)) {
      console.log(JSON.stringify({ event: "render_screenshot_auth_walled", url, final: page.url().slice(0, 200) }));
      return { png: null, authWalled: true };
    }
    // A configured themeStorageKey (#4109) ALSO forces the theme via localStorage, then reloads so the
    // app's own theme-init logic re-runs against the new stored value -- the fallback for a target whose
    // theming ignores prefers-color-scheme (see CaptureShotOptions.theme's doc for what this fixes and why).
    // Only after the safe-url/auth-wall checks above, so a page we're about to reject never pays for a reload.
    if (opts.theme && opts.themeStorageKey) {
      const storageKey = opts.themeStorageKey;
      const storageValue = opts.theme;
      if (!(await forceThemeStorage(page, storageKey, storageValue))) return { png: null, authWalled: false };
      await page.reload({ waitUntil: "networkidle0", timeout: THEME_STORAGE_RELOAD_TIMEOUT_MS });
    }
    // Full-page (not just the viewport), but bounded: before/after should include the same page position for
    // normal review pages without letting attacker-controlled document height or PNG size drive unbounded
    // Chromium raster work on the public screenshot route.
    const shot = await captureBoundedFullPageShot(page, viewport);
    return { png: shot, authWalled: false };
  } catch (error) {
    // Log before degrading to null — otherwise a networkidle0 timeout, a binding quota error, or a render
    // crash is indistinguishable from "no page" and the cell silently blanks.
    console.log(JSON.stringify({ event: "render_screenshot_error", mode: "binding", url, message: String(error).slice(0, 200) }));
    return { png: null, authWalled: false };
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}

/** Back-compat thin wrapper: render a page to a PNG (or null on failure / auth wall). The on-demand
 *  `/shot?url=` route uses this; the capture pipeline uses `captureShot` to also learn `authWalled`. */
export async function renderScreenshot(env: Env, url: string, viewport: Viewport = VIEWPORT, opts: CaptureShotOptions = {}): Promise<Uint8Array | null> {
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
  if (!url || !isSafeHttpUrl(url) || (opts.isAllowedUrl && !opts.isAllowedUrl(url))) {
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
