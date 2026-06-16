// #581 (epic #577, roadmap #525): Playwright before/after capture across viewports.
//
// This is the PURE, browser-agnostic core of the capture step: viewport config, the deterministic
// settling sources (style + init script), capture planning, stable object-key naming, and the capture
// orchestrator. The real Chromium runner (scripts/visual-capture.ts) injects a `CaptureBrowser` adapter,
// so this module stays unit-testable without launching a browser and is never bundled into the Worker
// (Cloudflare Workers cannot run a browser). It mirrors the Playwright reuse called for by #581
// (scripts/smoke-ui-browser.mjs) while keeping the testable logic out of the throwaway runner script.
//
// Determinism is the headline acceptance criterion: the SAME route on the SAME side must render
// byte-stably across runs. We get there by (a) freezing the wall clock + RNG before any app code runs,
// (b) killing animations/transitions/carets/scrollbars via injected CSS, and (c) waiting for network
// idle, optional hydration, and web fonts before the shot.

export type Viewport = { readonly name: string; readonly width: number; readonly height: number };

/** Default desktop + mobile viewports. Fixed, documented sizes so captures reproduce across runs.
 *  Callers may override; #579 will later drive viewport/route selection from affected-route detection. */
export const DEFAULT_VIEWPORTS: readonly Viewport[] = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];

/** Default routes to capture — the UI surfaces most likely to change visually. A subset of
 *  scripts/smoke-ui-browser.mjs; replaced by affected-route detection in #579. */
export const DEFAULT_ROUTES: readonly string[] = ["/", "/app", "/roadmap", "/changelog", "/extension", "/docs"];

/** Frozen wall-clock instant (2023-11-14T22:13:20Z) shared by the init script so time-driven UI is stable. */
export const FIXED_EPOCH_MS = 1_700_000_000_000;

/** CSS injected before every screenshot to strip non-determinism: no animation/transition, no caret, no
 *  smooth scroll, no scrollbar. Re-applied after each navigation (a style tag does not survive a goto). */
export const DETERMINISTIC_STYLE = [
  "*,*::before,*::after{",
  "animation:none!important;animation-duration:0s!important;animation-delay:0s!important;",
  "transition:none!important;transition-duration:0s!important;transition-delay:0s!important;",
  "caret-color:transparent!important;scroll-behavior:auto!important;",
  "}",
  "html{scrollbar-width:none!important;}",
  "::-webkit-scrollbar{display:none!important;}",
].join("");

/** Runs in page context BEFORE any app code: freeze Date (now + arg-less construction) and seed Math.random
 *  with a deterministic LCG so clock/RNG-driven rendering is stable shot-to-shot. Fonts are awaited
 *  separately via FONTS_READY_EXPRESSION (they need the document, which does not exist yet here). */
export const DETERMINISTIC_INIT_SCRIPT = `(() => {
  const FIXED = ${FIXED_EPOCH_MS};
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...args) { if (args.length === 0) { super(FIXED); } else { super(...args); } }
    static now() { return FIXED; }
  }
  globalThis.Date = FrozenDate;
  let seed = 0x2545f491;
  Math.random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
})();`;

/** Expression awaited after navigation so web fonts are loaded before the shot (prevents font-swap flicker). */
export const FONTS_READY_EXPRESSION = "document.fonts && document.fonts.ready ? document.fonts.ready.then(() => document.fonts.status) : 'ready'";

export type CaptureSide = "before" | "after";

/** A single planned shot: one side (base/head) of one route at one viewport. */
export type CapturePlanEntry = { readonly side: CaptureSide; readonly route: string; readonly viewport: Viewport };

/** Minimal page surface the orchestrator needs. The real runner adapts a Playwright `Page` to this; tests
 *  supply a fake. Kept intentionally narrow so the adapter (and fakes) stay trivial. */
export interface CapturePage {
  addInitScript(script: string): Promise<void>;
  goto(url: string, options: { waitUntil: "networkidle"; timeout: number }): Promise<{ status: number } | null>;
  waitForLoadState(state: "networkidle", options: { timeout: number }): Promise<void>;
  waitForSelector(selector: string, options: { timeout: number }): Promise<void>;
  evaluate(expression: string): Promise<unknown>;
  addStyleTag(options: { content: string }): Promise<void>;
  screenshot(options: { fullPage: boolean }): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** Page factory keyed by viewport. The runner returns a real Chromium page sized to the viewport. */
export interface CaptureBrowser {
  newPage(viewport: Viewport): Promise<CapturePage>;
}

export type VisualCaptureOptions = {
  /** Origin serving the BASE (pre-change) build — the "before" side. */
  readonly baseUrl: string;
  /** Origin serving the HEAD (PR) build — the "after" side. */
  readonly headUrl: string;
  readonly routes?: readonly string[] | undefined;
  readonly viewports?: readonly Viewport[] | undefined;
  /** Object-key prefix; defaults to "visual-review". */
  readonly keyPrefix?: string | undefined;
  /** Per-navigation timeout (ms); also used for hydration/load waits. */
  readonly navigationTimeoutMs?: number | undefined;
  /** Optional CSS selector that signals hydration is complete (waited for after network idle). */
  readonly hydrationSelector?: string | undefined;
};

export type CaptureArtifact = {
  readonly side: CaptureSide;
  readonly route: string;
  readonly viewport: string;
  readonly key: string;
  readonly bytes: Uint8Array;
};

const DEFAULT_NAV_TIMEOUT_MS = 30_000;

/** Stable, filesystem/R2-safe slug for a route. "/" -> "root"; "/app/repos" -> "app-repos". */
export function routeSlug(route: string): string {
  const trimmed = route.replace(/^\/+/, "").replace(/\/+$/, "");
  if (trimmed === "") return "root";
  return trimmed.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
}

/** Deterministic object key for one shot, e.g. `visual-review/desktop/app-repos.before.png`. The pair
 *  (before/after) for a route+viewport differs only in the `.before`/`.after` segment, so a diff step
 *  (#582) can pair them by replacing the side. */
export function captureObjectKey(args: { prefix?: string | undefined; viewport: string; route: string; side: CaptureSide }): string {
  const prefix = args.prefix ?? "visual-review";
  return `${prefix}/${args.viewport}/${routeSlug(args.route)}.${args.side}.png`;
}

/** Join an origin and a route into a single URL, tolerating trailing/leading slashes. */
export function joinUrl(origin: string, route: string): string {
  const base = origin.replace(/\/+$/, "");
  if (route === "" || route === "/") return `${base}/`;
  return `${base}/${route.replace(/^\/+/, "")}`;
}

/** Full plan of shots: for each viewport, every route on the `before` side then the `after` side. The
 *  ordering guarantees a matching before/after pair exists for every (route, viewport). */
export function planCaptures(routes: readonly string[], viewports: readonly Viewport[]): CapturePlanEntry[] {
  const plan: CapturePlanEntry[] = [];
  for (const viewport of viewports) {
    for (const side of ["before", "after"] as const) {
      for (const route of routes) plan.push({ side, route, viewport });
    }
  }
  return plan;
}

/**
 * Capture deterministic full-page screenshots of every route at every viewport, for both the base
 * ("before") and head ("after") origins. One page is created per (viewport, side) and reused across that
 * side's routes — the init script persists across navigations, while the settling style is re-applied
 * after each goto. Returns one artifact per shot; the result always contains a matching before/after pair
 * per (route, viewport).
 */
export async function runVisualCapture(browser: CaptureBrowser, options: VisualCaptureOptions): Promise<CaptureArtifact[]> {
  const routes = options.routes ?? DEFAULT_ROUTES;
  const viewports = options.viewports ?? DEFAULT_VIEWPORTS;
  const timeout = options.navigationTimeoutMs ?? DEFAULT_NAV_TIMEOUT_MS;
  const artifacts: CaptureArtifact[] = [];

  for (const viewport of viewports) {
    for (const side of ["before", "after"] as const) {
      const origin = side === "before" ? options.baseUrl : options.headUrl;
      const page = await browser.newPage(viewport);
      await page.addInitScript(DETERMINISTIC_INIT_SCRIPT);
      try {
        for (const route of routes) {
          const url = joinUrl(origin, route);
          const response = await page.goto(url, { waitUntil: "networkidle", timeout });
          const status = response?.status ?? 0;
          if (status === 0 || status >= 400) {
            throw new Error(`capture navigation failed for ${url} (status ${response ? status : "none"})`);
          }
          await page.waitForLoadState("networkidle", { timeout });
          if (options.hydrationSelector) await page.waitForSelector(options.hydrationSelector, { timeout });
          await page.evaluate(FONTS_READY_EXPRESSION);
          await page.addStyleTag({ content: DETERMINISTIC_STYLE });
          const bytes = await page.screenshot({ fullPage: true });
          artifacts.push({
            side,
            route,
            viewport: viewport.name,
            key: captureObjectKey({ prefix: options.keyPrefix, viewport: viewport.name, route, side }),
            bytes,
          });
        }
      } finally {
        await page.close();
      }
    }
  }

  return artifacts;
}
