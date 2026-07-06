// Screenshot endpoint for the realtime before/after capture (reviewbot→gittensory convergence — visual port).
//
// PORTED from reviewbot's src/agents/gittensory/shot.ts. CHANGES for gittensory:
//   • puppeteer import unchanged (@cloudflare/puppeteer), SSRF guard now isSafeHttpUrl from ../content-lane/safe-url
//   • bindings: env.BROWSER (Browser Rendering) + env.REVIEW_AUDIT (R2) — gittensory's R2 binding is
//     REVIEW_AUDIT, NOT reviewbot's env.AUDIT.
//   • r2 key prefix default 'gittensory/shots/'; on-demand render allowlist's production host = PUBLIC_SITE_ORIGIN.
//   • no reviewbot REVIEWBOT_* secrets / REST fallback — gittensory renders via the BROWSER binding only.
//
// Two modes:
//   GET /gittensory/shot?key=<r2key>  -> stream a pre-rendered PNG from R2 (fast; GitHub's image proxy
//                                       fetches this static object instead of waiting on a live render).
//   GET /gittensory/shot?url=<page>   -> render <page> on demand and return a PNG (host-allowlisted +
//                                       SSRF-guarded). A fallback / manual-check path.
//   GET /gittensory/shot?placeholder=loading|failed|auth -> a static SVG card (no render).
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
   *  no emulation call at all — Chromium's own unconfigured default, byte-identical to today. */
  theme?: ShotTheme;
}
type ScreenshotRequest = {
  url(): string;
  isNavigationRequest(): boolean;
  abort(): Promise<unknown>;
  continue(): Promise<unknown>;
};
export const DESKTOP_VIEWPORT: Viewport = { width: 1440, height: 900 };
export const MOBILE_VIEWPORT: Viewport = { width: 390, height: 844 }; // iPhone-class portrait
const VIEWPORT = DESKTOP_VIEWPORT;

/** Per-call shot-route options: the R2 namespace (key prefix) + the production host for the on-demand render
 *  allowlist. Defaults to gittensory so the /gittensory/shot route works with no options. */
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
    console.log(JSON.stringify({ ev: "render_screenshot_blocked", url: String(url).slice(0, 120) }));
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
          console.log(JSON.stringify({ ev: "render_screenshot_request_blocked", url: requestUrl.slice(0, 120) }));
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
      console.log(JSON.stringify({ ev: "render_screenshot_redirect_blocked", url, final: page.url().slice(0, 200) }));
      return { png: null, authWalled: false };
    }
    // A protected route that redirected to a login page: don't return a screenshot of the sign-in screen —
    // flag it so the caller renders an honest auth placeholder. (The requested URL not itself being a login
    // page guards a PR that legitimately changes the login screen.)
    if (isAuthWallUrl(page.url()) && !isAuthWallUrl(url)) {
      console.log(JSON.stringify({ ev: "render_screenshot_auth_walled", url, final: page.url().slice(0, 200) }));
      return { png: null, authWalled: true };
    }
    // Full-page (not just the viewport): before/after must show the SAME position on the page for any
    // change, however far down it is. A viewport-only shot only captures whatever happens to be in frame at
    // load time, which for a change midway down a long page would silently miss it in both cells. Capturing
    // the whole scrollable height means the changed region is always present in both images at the same
    // relative offset, with no need to locate/scroll to it first.
    const shot = (await page.screenshot({ type: "png", fullPage: true })) as Uint8Array;
    return { png: shot, authWalled: false };
  } catch (error) {
    // Log before degrading to null — otherwise a networkidle0 timeout, a binding quota error, or a render
    // crash is indistinguishable from "no page" and the cell silently blanks.
    console.log(JSON.stringify({ ev: "render_screenshot_error", mode: "binding", url, message: String(error).slice(0, 200) }));
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

export async function handleShot(request: Request, env: Env, opts: ShotOptions = {}): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const r2Prefix = `${opts.namespace ?? "gittensory"}/shots/`;

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
    return new Response(object.body, {
      headers: { "content-type": "image/png", "cache-control": "public, max-age=86400, immutable" },
    });
  }

  // Mode B: render on demand (host-allowlisted + SSRF-guarded). Optional &w=&h= selects the viewport;
  // optional &theme= (#3678) emulates prefers-color-scheme — an unrecognized value is ignored (falls back to
  // no emulation) rather than rejecting the whole request over a cosmetic param.
  const target = params.get("url");
  if (!target || !isSafeHttpUrl(target)) return new Response("bad url", { status: 400 });
  if (!isAllowedHost(target, env, opts.productionUrl)) return new Response("forbidden host", { status: 403 });
  const w = Number(params.get("w"));
  const h = Number(params.get("h"));
  const viewport: Viewport = Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0 ? { width: Math.min(w, 2560), height: Math.min(h, 2560) } : DESKTOP_VIEWPORT;
  const requestedTheme = params.get("theme");
  const theme: ShotTheme | undefined = requestedTheme === "light" || requestedTheme === "dark" ? requestedTheme : undefined;
  const png = await renderScreenshot(env, target, viewport, { isAllowedUrl: (candidate) => isAllowedHost(candidate, env, opts.productionUrl), ...(theme ? { theme } : {}) });
  if (!png) return new Response("screenshot unavailable", { status: 502 });
  return new Response(png, {
    headers: { "content-type": "image/png", "cache-control": "public, max-age=300" },
  });
}
