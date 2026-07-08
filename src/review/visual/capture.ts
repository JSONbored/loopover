// Realtime visual capture (reviewbot→gittensory convergence — visual port). taopedia-style before/after.
//
// before = production (PUBLIC_SITE_ORIGIN); after = the PR's preview-deploy URL, discovered the
// provider-agnostic way (Deployments API → commit checks → cloudflare-bot PR comment). Each page is
// rendered once here (in the queue consumer, which has the time budget), stored as a PNG in R2
// (env.REVIEW_AUDIT), and embedded as <PUBLIC_API_ORIGIN>/gittensory/shot?key=<r2key> so GitHub's image
// proxy fetches a fast static object instead of waiting on a live browser render.
//
// PORTED from reviewbot's src/agents/gittensory/capture.ts (mapFilesToRoutes / routeForFile / capturePage /
// buildCapture), adapted to gittensory bindings + origins. The agent-config-driven route rules, authed-route
// preview session, and explicit-route override are intentionally dropped here — gittensory's UI uses the
// default TanStack route convention; those hooks can return if a per-repo visual config is added.
import { sha256Hex } from "../../utils/crypto";
import type { GitHubRateLimitAdmissionKey } from "../../github/client";
import { dispatchVisualCaptureFallback, fallbackShotR2Key } from "./actions-fallback";
import {
  findPreviewUrlFromChecks,
  findPreviewUrlFromPrComments,
  getLatestDeploymentStatus,
  getPreviewBuildState,
  parseRepo,
} from "./preview-url";
import { captureScrollFrames, captureShot, DESKTOP_VIEWPORT, MOBILE_VIEWPORT, type ShotTheme, type Viewport } from "./shot";
import { compareCapturedScreenshots, isVisualDiffAvailable, type VisualDiffOutcome } from "./pixel-diff";
import { encodeScrollGif, isScrollGifAvailable } from "./scroll-gif";

const NAMESPACE = "gittensory";
const DEFAULT_ROUTES = ["/"];
const DEFAULT_ROUTE_FILE = /apps\/gittensory-ui\/src\/routes\/(.+?)\.(?:tsx|jsx)$/i;
// Each route renders desktop + mobile for before + after (up to 4 PNGs). Cap routes to bound browser-render
// wall-clock — Browser Rendering is the costliest binding.
const MAX_ROUTES = 2;
const MAX_CONFIGURED_ROUTES = 5;

/** A single captured route's before/after shot URLs (desktop + mobile), plus an optional pixel-diff overlay
 *  per viewport (#3674) — self-host only (isVisualDiffAvailable), and only when the diff clears the visual-
 *  diff module's own noise threshold; undefined slot ⇒ a dash cell either way. `theme` is set only when
 *  `review.visual.themes` (#3678) configured more than the implicit single default capture — undefined means
 *  "the one, un-emulated default render", exactly like today. `beforeGifUrl`/`afterGifUrl` (#3612) are a
 *  short scroll-through animation — self-host only (isScrollGifAvailable) and only when `review.visual.gif`
 *  opts in; desktop viewport only in this first cut (see buildCapture's scoping note). */
export interface CaptureRoute {
  path: string;
  theme?: ShotTheme | undefined;
  beforeUrl?: string | undefined;
  beforeUrlMobile?: string | undefined;
  afterUrl?: string | undefined;
  afterUrlMobile?: string | undefined;
  diffUrl?: string | undefined;
  diffUrlMobile?: string | undefined;
  beforeGifUrl?: string | undefined;
  afterGifUrl?: string | undefined;
}

/** The capture pipeline's result: the rendered routes, plus whether a preview build is still pending. */
export interface CaptureResult {
  routes: CaptureRoute[];
  previewPending: boolean;
}

/** True when `url` is a REAL rendered shot — not a missing slot (`undefined`) and not one of `capturePage`'s
 *  own placeholder cards (`?placeholder=loading|failed|auth`, minted when there's no preview yet, the deploy
 *  failed, or the route sign-in-walled). An on-demand `?url=` fallback link (no R2 binding configured) still
 *  counts as real — it resolves to an actual render, just not a cached one. */
function isRealShotUrl(url: string | undefined): boolean {
  return typeof url === "string" && url.length > 0 && !url.includes("placeholder=");
}

/** True when `route` has a real before+after PAIR on at least one viewport (desktop or mobile) — the
 *  deterministic signal {@link hasSuccessfulBotCapture} uses per-route. Requiring BOTH sides of the SAME
 *  viewport (not "any before" + "any after" mixed across viewports) mirrors what a reviewer actually sees in
 *  the "Visual preview" table: one comparable pair, not two unrelated renders. */
function routeHasRealBeforeAfterPair(route: CaptureRoute): boolean {
  const desktopReal = isRealShotUrl(route.beforeUrl) && isRealShotUrl(route.afterUrl);
  const mobileReal = isRealShotUrl(route.beforeUrlMobile) && isRealShotUrl(route.afterUrlMobile);
  return desktopReal || mobileReal;
}

/**
 * True when at least one captured route has a REAL before+after render pair (#4110) — the deterministic
 * signal the screenshot-table gate (`review/screenshot-table-gate.ts`) treats as equivalent to a hand-authored
 * before/after table: a bot-rendered pair already proves the reviewer can SEE the change, so demanding a
 * manual table on top of it would be redundant friction. A capture whose routes are all placeholders (preview
 * still building, deploy failed, auth-walled) or empty (capture never ran / found nothing) does NOT satisfy —
 * only a genuinely rendered pair does.
 */
export function hasSuccessfulBotCapture(routes: readonly CaptureRoute[]): boolean {
  return routes.some(routeHasRealBeforeAfterPair);
}

/** Inputs the capture pipeline needs about the PR under review (resolved by the caller from gittensory data). */
export interface CaptureTarget {
  repoFullName: string;
  prNumber: number;
  headSha?: string | undefined;
  headRef?: string | undefined;
  /** Preview URL carried from a deployment_status webhook (no API call needed when present). */
  previewUrl?: string | undefined;
  /** True when a deployment_status webhook reported the preview deploy FAILED. */
  previewFailed?: boolean | undefined;
  /** Whether to scan commit checks / the cloudflare-bot PR comment for the preview URL (Workers Builds). */
  previewFromChecks?: boolean | undefined;
  /** The repo's default branch -- REQUIRED to dispatch the actions_fallback workflow (#4112) against a
   *  trusted ref rather than the PR's own branch. Absent ⇒ the fallback is never dispatched (fail-safe: no
   *  ref to pin to means no dispatch, not a guess at "main"). */
  defaultBranchRef?: string | undefined;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Per-repo `review.visual.preview` config, as resolved by the caller from the manifest (#3609). */
export type VisualPreviewInput = { urlTemplate?: string | null | undefined };

/**
 * Substitute `{number}`/`{head_sha}`/`{head_sha_short}` in a `review.visual.preview.url_template` (#3609).
 * Pure string substitution — `number` and `headSha` are GitHub-controlled facts about the PR, never
 * attacker-supplied free text, so this carries no injection risk regardless of the template's own content
 * (which is maintainer-authored and already validated at parse time — see parseVisualUrlTemplate). A missing
 * headSha leaves the sha placeholders empty rather than throwing; the resolved URL still goes through the
 * SAME isSafeHttpUrl check every other capture URL does (in captureShot), so an unresolved/malformed result
 * degrades to a null render, never a crash.
 */
export function resolvePreviewUrlTemplate(template: string, vars: { number: number; headSha?: string | undefined }): string {
  const headSha = vars.headSha ?? "";
  return template
    .split("{number}").join(String(vars.number))
    .split("{head_sha_short}").join(headSha.slice(0, 7))
    .split("{head_sha}").join(headSha);
}

/**
 * Map changed UI files to navigable routes, honoring TanStack Router's file conventions (flat routing uses
 * `.` as the path separator; folders use `/`):
 *   __root.tsx / index.tsx -> "/"   ·   app.index.tsx -> "/app"   ·   app.analytics.tsx -> "/app/analytics"
 *   _authed.app.tsx -> "/app" (pathless `_` layout) · (marketing).about.tsx -> "/about" (route group)
 *   posts.$id.tsx -> "/" (dynamic param has no concrete value to render)
 * Anything we can't resolve to a concrete path falls back to "/" so we never screenshot a 404.
 */
export function mapFilesToRoutes(files: string[], pattern: RegExp = DEFAULT_ROUTE_FILE, maxRoutes: number = MAX_ROUTES): string[] {
  const routes = new Set<string>();
  for (const file of files) {
    const match = file.match(pattern);
    if (match) routes.add(routeForFile(match[1] as string));
  }
  if (routes.size === 0) for (const route of DEFAULT_ROUTES) routes.add(route);
  return [...routes].slice(0, maxRoutes);
}

/** Per-repo `review.visual.routes` config, as resolved by the caller from the manifest (#3610). */
export type VisualRoutesInput = { paths?: readonly string[] | null | undefined; maxRoutes?: number | null | undefined };

/**
 * Resolve which routes to screenshot for this PR: an explicit, always-screenshotted `paths` list from
 * `review.visual.routes` REPLACES automatic file-to-route inference entirely when non-empty (simpler and
 * more robust for a repo whose routing convention isn't gittensory-ui's TanStack file-based one); absent/
 * empty config falls through to `mapFilesToRoutes` unchanged, so this is byte-identical to today by default.
 * `maxRoutes` applies to either path — an explicit list is capped too, not just inferred routes.
 */
export function resolveVisualRoutes(files: string[], config?: VisualRoutesInput | null): string[] {
  const maxRoutes = config?.maxRoutes && config.maxRoutes > 0 ? Math.min(config.maxRoutes, MAX_CONFIGURED_ROUTES) : MAX_ROUTES;
  if (config?.paths && config.paths.length > 0) return [...config.paths].slice(0, maxRoutes);
  return mapFilesToRoutes(files, DEFAULT_ROUTE_FILE, maxRoutes);
}

/** Resolve one TanStack route-file name (extension already stripped) to a navigable path. */
function routeForFile(raw: string): string {
  if (/(^|[./])__/.test(raw)) return "/"; // root layout / "__"-prefixed framework file — not navigable
  const segments: string[] = [];
  for (const seg of raw.split(/[./]/)) {
    if (!seg) continue;
    if (/^(?:index|route|layout)$/i.test(seg)) continue; // index/layout markers add no path segment
    if (/^\(.*\)$/.test(seg)) continue; // route groups: (marketing)
    if (seg.startsWith("_")) continue; // pathless layout segments: _authed
    if (seg.startsWith("$")) return "/"; // dynamic param — no concrete value to render
    segments.push(seg);
  }
  return `/${segments.join("/")}`.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

/**
 * Render `page`, store the PNG in R2, and return its /gittensory/shot?key= URL. Falls back to an on-demand
 * ?url= link if R2 or the render is unavailable; returns {} when there is no page (no preview deploy yet) so
 * the cell shows a dash. Reuses an identical cached fingerprint (a deployment_status re-run filling "after"
 * cells would otherwise re-render the same screenshot — Browser Rendering is the costliest binding).
 */
async function capturePage(
  env: Env,
  target: CaptureTarget,
  page: string,
  slot: "before" | "after",
  viewportName: "desktop" | "mobile",
  viewport: Viewport,
  // #3674: when true, ALSO resolve the raw PNG bytes (not just the URL) so the caller can pixel-diff
  // before+after — including on a cache hit, which is the COMMON case for "before" (the same production
  // shot is reused across many PR reviews). Costs one extra read on a cache hit; false (every existing
  // caller) skips it entirely, so this is zero-cost unless a caller opts in.
  includeBytes = false,
  // #3678: emulate prefers-color-scheme before rendering. Undefined (every pre-#3678 caller) ⇒ no emulation
  // call and an UNCHANGED cache key — byte-identical to today.
  theme?: ShotTheme | undefined,
  // #4109: ALSO force `theme` via localStorage.setItem(themeStorageKey, theme) + a reload, for a target whose
  // theming ignores prefers-color-scheme (see shot.ts's CaptureShotOptions.theme doc). Only takes effect
  // together with `theme`; undefined (every pre-#4109 caller) ⇒ byte-identical to today.
  themeStorageKey?: string | undefined,
): Promise<{ url?: string | undefined; png?: Uint8Array | undefined }> {
  if (!page) return {};
  const shotBase = env.PUBLIC_API_ORIGIN; // this worker's public origin (serves /gittensory/shot)
  // Carries the theme (#3678) and, when set, the storage key (#4109) so a LATER on-demand fetch of this
  // exact URL (e.g. a failed/never-persisted render retried by GitHub's image proxy) still requests the
  // matching prefers-color-scheme/localStorage forcing, not the default — handleShot's Mode B reads these
  // same &theme=/&themeStorageKey= params. Omitted when unset, unchanged from today.
  const onDemand = shotBase
    ? `${shotBase}/${NAMESPACE}/shot?url=${encodeURIComponent(page)}&w=${viewport.width}&h=${viewport.height}${theme ? `&theme=${theme}` : ""}${theme && themeStorageKey ? `&themeStorageKey=${encodeURIComponent(themeStorageKey)}` : ""}`
    : page;

  if (env.REVIEW_AUDIT) {
    // Key includes the viewport (and, when set, the theme + storage key) so desktop/mobile, light/dark, and
    // differently-configured-storage-key shots of the same page don't collide in R2.
    const fingerprint = await sha256Hex(
      `${target.headSha ?? target.prNumber}:${slot}:${viewportName}:${page}${theme ? `:${theme}` : ""}${theme && themeStorageKey ? `:${themeStorageKey}` : ""}`,
    );
    const key = `${NAMESPACE}/shots/${fingerprint.slice(0, 40)}.png`;
    const url = shotBase ? `${shotBase}/${NAMESPACE}/shot?key=${encodeURIComponent(key)}` : onDemand;
    const cached = await env.REVIEW_AUDIT.get(key).catch(() => null);
    if (cached) {
      if (!includeBytes) return { url };
      const bytes = await new Response(cached.body).arrayBuffer().then((buf) => new Uint8Array(buf)).catch(() => undefined);
      return { url, ...(bytes ? { png: bytes } : {}) };
    }
    const { png, authWalled } = await captureShot(env, page, viewport, theme ? { theme, ...(themeStorageKey ? { themeStorageKey } : {}) } : {}).catch(() => ({ png: null, authWalled: false }));
    // A protected route that redirected to a sign-in wall: show an honest "requires authentication"
    // placeholder rather than caching/serving a screenshot of the login screen.
    if (authWalled) {
      return { url: shotBase ? `${shotBase}/${NAMESPACE}/shot?placeholder=auth` : onDemand };
    }
    if (png) {
      await env.REVIEW_AUDIT.put(key, png, { httpMetadata: { contentType: "image/png" } }).catch(() => undefined);
      return { url, ...(includeBytes ? { png } : {}) };
    }
  }
  return { url: onDemand };
}

/** Resolve the "after" shot when there is no real preview page to render (#4112): if `review.visual.
 *  actions_fallback` is enabled AND the workflow_run webhook handler has already stored a fallback-captured
 *  PNG in R2 for this exact head + route + viewport (fallbackShotR2Key), return its shot URL; otherwise fall
 *  back to the ordinary loading/failed placeholder. This never fetches or dispatches anything itself — a
 *  cache miss here just means the fallback hasn't landed yet (or was never enabled), degrading exactly like
 *  "no preview yet" does everywhere else in this pipeline. */
async function resolveFallbackAfterShot(
  env: Env,
  target: CaptureTarget,
  path: string,
  viewportName: "desktop" | "mobile",
  actionsFallbackEnabled: boolean,
  placeholder: string | undefined,
): Promise<{ url?: string | undefined; png?: Uint8Array | undefined }> {
  if (!actionsFallbackEnabled || !env.REVIEW_AUDIT || !target.headSha) return { url: placeholder };
  const key = await fallbackShotR2Key(target.headSha, path, viewportName);
  const cached = await env.REVIEW_AUDIT.get(key).catch(() => null);
  if (!cached) return { url: placeholder };
  const shotBase = env.PUBLIC_API_ORIGIN;
  return { url: shotBase ? `${shotBase}/${NAMESPACE}/shot?key=${encodeURIComponent(key)}` : placeholder };
}

/** Upload a computed diff-overlay PNG to the same store `capturePage` uses, returning its shot URL — or
 *  undefined when there's no diff image (unchanged/new/removed/no-diff-provider), storage is unavailable, or
 *  the upload fails. Mirrors capturePage's own key/URL scheme so the diff shares its caching story. */
async function uploadDiffImage(
  env: Env,
  target: CaptureTarget,
  path: string,
  viewportName: "desktop" | "mobile",
  diff: VisualDiffOutcome | null,
  theme?: ShotTheme | undefined,
): Promise<string | undefined> {
  if (!diff?.diffImagePng) return undefined;
  const shotBase = env.PUBLIC_API_ORIGIN;
  if (!env.REVIEW_AUDIT || !shotBase) return undefined;
  const fingerprint = await sha256Hex(`${target.headSha ?? target.prNumber}:diff:${viewportName}:${path}${theme ? `:${theme}` : ""}`);
  const key = `${NAMESPACE}/shots/${fingerprint.slice(0, 40)}-diff.png`;
  await env.REVIEW_AUDIT.put(key, diff.diffImagePng, { httpMetadata: { contentType: "image/png" } }).catch(() => undefined);
  return `${shotBase}/${NAMESPACE}/shot?key=${encodeURIComponent(key)}`;
}

// How long each frame shows when the assembled GIF plays back (#3612) — a quick "evidence clip" pace: the
// full MAX_SCROLL_STEPS (6, see shot.ts) loop takes ~3s, long enough to read, short enough to stay a glance.
const GIF_FRAME_DELAY_MS = 500;

/**
 * Capture a scroll-through sequence for `page` and assemble it into a GIF (#3612), or undefined when there's
 * no page, the render fails/auth-walls, storage is unavailable, or this build can't assemble GIFs at all
 * (isScrollGifAvailable — hosted mode; see scroll-gif.ts). Caches on the same fingerprint scheme as
 * `capturePage`/`uploadDiffImage` — a scroll capture is the most expensive thing this pipeline does (up to 6
 * extra renders plus a full encode), so a re-review of the same head must never redo it.
 */
async function captureScrollGif(
  env: Env,
  target: CaptureTarget,
  page: string,
  slot: "before" | "after",
  viewportName: "desktop" | "mobile",
  viewport: Viewport,
  theme?: ShotTheme | undefined,
  // #4109: see capturePage's own themeStorageKey param — same fallback, same "only with theme" guard.
  themeStorageKey?: string | undefined,
): Promise<string | undefined> {
  if (!page) return undefined;
  const shotBase = env.PUBLIC_API_ORIGIN;
  if (!env.REVIEW_AUDIT || !shotBase) return undefined;
  const fingerprint = await sha256Hex(
    `${target.headSha ?? target.prNumber}:scrollgif:${slot}:${viewportName}:${page}${theme ? `:${theme}` : ""}${theme && themeStorageKey ? `:${themeStorageKey}` : ""}`,
  );
  const key = `${NAMESPACE}/shots/${fingerprint.slice(0, 40)}.gif`;
  const url = `${shotBase}/${NAMESPACE}/shot?key=${encodeURIComponent(key)}`;
  const cached = await env.REVIEW_AUDIT.get(key).catch(() => null);
  if (cached) return url;
  const { frames, authWalled } = await captureScrollFrames(env, page, viewport, theme ? { theme, ...(themeStorageKey ? { themeStorageKey } : {}) } : {}).catch(() => ({ frames: [] as Uint8Array[], authWalled: false }));
  if (authWalled || frames.length === 0) return undefined;
  const gifBytes = await encodeScrollGif(
    frames.map((png) => ({ png })),
    GIF_FRAME_DELAY_MS,
  );
  if (!gifBytes) return undefined;
  await env.REVIEW_AUDIT.put(key, gifBytes, { httpMetadata: { contentType: "image/gif" } }).catch(() => undefined);
  return url;
}

/** Per-repo `review.visual` config, as resolved by the caller from the manifest (#3609 / #3610 / #3678 /
 *  #3612 / #4109). Absent ⇒ byte-identical to today (GitHub-native discovery, automatic route inference,
 *  single default-theme capture, built-in route cap, no scroll-GIF, no localStorage theme forcing). */
export type VisualCaptureConfig = {
  preview?: VisualPreviewInput | null | undefined;
  routes?: VisualRoutesInput | null | undefined;
  themes?: readonly ShotTheme[] | null | undefined;
  gif?: boolean | null | undefined;
  /** #4109: the localStorage key `emulateMediaFeatures`-driven captures fall back to for a target whose
   *  theming reads an explicit stored preference instead of `prefers-color-scheme` — see shot.ts's
   *  `CaptureShotOptions.theme` doc for the verified finding this fixes. null/undefined (default) ⇒ no
   *  localStorage write, byte-identical to today. Only takes effect when `themes` is also configured. */
  themeStorageKey?: string | null | undefined;
  /** `review.visual.actions_fallback` (#4112): dispatch the GitHub-Actions build-and-serve fallback when NO
   *  preview at all was found for this PR. false/absent (default) ⇒ byte-identical to today. */
  actionsFallback?: boolean | null | undefined;
};

/**
 * Build the before/after capture for a PR: resolve the preview URL, derive routes from the changed UI files,
 * render desktop + mobile before/after for each route, and return the route URL set (for the visual-preview
 * collapsible). Fully fail-safe — a missing preview / failed render degrades to placeholders or dashes; this
 * NEVER throws (the caller also wraps it in try/catch so a capture failure can't sink a review).
 */
export async function buildCapture(env: Env, token: string, target: CaptureTarget, visualFiles: string[], rateLimitAdmissionKey?: GitHubRateLimitAdmissionKey | undefined, visualConfig?: VisualCaptureConfig | null | undefined): Promise<CaptureResult> {
  const repo = parseRepo(target.repoFullName);
  const apiVersion = "2022-11-28";
  // before = production (PUBLIC_SITE_ORIGIN, e.g. https://gittensory.aethereal.dev).
  const prodBase = env.PUBLIC_SITE_ORIGIN ?? "";

  // after = the PR's preview deploy. An explicit review.visual.preview.url_template (#3609) ALWAYS wins —
  // a maintainer-configured template is a stronger signal than inference, and is the only option for a
  // provider (e.g. Cloudflare Workers Builds' non-production branch builds) that never surfaces a
  // GitHub-visible deployment at all. Otherwise, prefer the URL carried on the target (a deployment_status
  // webhook set it — no extra API call); otherwise look it up from Deployments, then commit checks, then
  // the cloudflare-bot PR comment. The lookups also tell us when the latest deploy FAILED (vs is still
  // building) so we can show a terminal "deploy failed" card instead of a spinner.
  let previewBase = "";
  let previewFailed = target.previewFailed === true;
  let previewPending = false;
  const urlTemplate = visualConfig?.preview?.urlTemplate;
  if (urlTemplate) {
    previewBase = resolvePreviewUrlTemplate(urlTemplate, { number: target.prNumber, headSha: target.headSha });
  } else {
    previewBase = typeof target.previewUrl === "string" ? target.previewUrl : "";
    if (!previewBase && !previewFailed) {
      try {
        const status = await getLatestDeploymentStatus({ token, repo, sha: target.headSha, ref: target.headRef, apiVersion, rateLimitAdmissionKey });
        previewBase = status.url ?? "";
        previewFailed = status.failed;
      } catch {
        previewBase = "";
      }
      if (!previewBase && !previewFailed && target.previewFromChecks && target.headSha) {
        previewBase = (await findPreviewUrlFromChecks({ token, repo, sha: target.headSha, apiVersion, rateLimitAdmissionKey })) ?? "";
        if (!previewBase && target.prNumber) {
          previewBase = (await findPreviewUrlFromPrComments({ token, repo, prNumber: target.prNumber, apiVersion, rateLimitAdmissionKey })) ?? "";
        }
        if (!previewBase && target.headSha) {
          const buildState = await getPreviewBuildState({ token, repo, sha: target.headSha, apiVersion, rateLimitAdmissionKey });
          if (buildState === "failed") previewFailed = true;
          else if (buildState === "building" || buildState === "succeeded") previewPending = true;
        }
      }
    }
  }

  // Fallback (#4112): the discovery chain above found NOTHING at all for this repo (no preview URL, not
  // failed, and no real build already in flight) -- if review.visual.actions_fallback is enabled, dispatch
  // .github/workflows/visual-capture-fallback.yml against the repo's own default branch and mark
  // previewPending so the EXISTING recapture-poll mechanism (processors.ts) retries this same buildCapture
  // call later, by which point the workflow_run webhook handler (running independently) has stored the
  // fallback's captured PNGs in R2 for resolveFallbackAfterShot below to find. Requires headSha + a resolved
  // default branch to pin the dispatch to a trusted ref; either missing ⇒ no dispatch (fail-safe).
  const actionsFallbackEnabled = visualConfig?.actionsFallback === true;
  const routes = resolveVisualRoutes(visualFiles, visualConfig?.routes);
  if (!previewBase && !previewFailed && !previewPending && actionsFallbackEnabled && target.headSha && target.defaultBranchRef) {
    const dispatched = await dispatchVisualCaptureFallback({
      token,
      repo,
      ref: target.defaultBranchRef,
      prNumber: target.prNumber,
      headSha: target.headSha,
      routes,
      rateLimitAdmissionKey,
    });
    if (dispatched) previewPending = true;
  }

  // With no real "after" shot, the cell shows a placeholder (same aspect ratio as a real shot): a spinner
  // while the preview is still building, or a static "deploy failed" card once it won't come.
  const shotBase = env.PUBLIC_API_ORIGIN;
  const loadingPlaceholder = shotBase ? `${shotBase}/${NAMESPACE}/shot?placeholder=loading` : undefined;
  const failedPlaceholder = shotBase ? `${shotBase}/${NAMESPACE}/shot?placeholder=failed` : undefined;
  const afterPlaceholder = previewFailed ? failedPlaceholder : loadingPlaceholder;

  // #3674: resolved ONCE per call, not per route/viewport — false in every hosted build (see pixel-diff.ts),
  // so capturePage never pays the extra cached-bytes-read cost unless self-host's real diff module is active.
  const diffAvailable = isVisualDiffAvailable();
  // #3612: gated on BOTH the opt-in config AND isScrollGifAvailable — hosted mode can never assemble a GIF
  // (see scroll-gif.ts), so this must short-circuit before capturing a single scroll frame there, not just
  // before encoding one. Desktop-viewport only in this first cut: a scroll-through GIF is already the
  // heaviest capture mode (up to 6 extra renders per side), and doubling it for mobile is a narrower-scope
  // call deferred to a follow-up rather than shipped speculatively (matches #3674's hosted-diff deferral).
  const gifWanted = visualConfig?.gif === true && isScrollGifAvailable();
  // #3678: an explicit, non-empty theme list captures the SAME routes once per theme, each tagged on its
  // CaptureRoute entry. [undefined] (the default, absent config) renders the single un-emulated default —
  // capturePage/captureShot already treat an undefined theme as "no emulation call at all", so this one
  // iteration is byte-identical to every pre-#3678 call.
  const themes: readonly (ShotTheme | undefined)[] = visualConfig?.themes && visualConfig.themes.length > 0 ? visualConfig.themes : [undefined];
  // #4109: the localStorage fallback only ever matters alongside a configured theme — resolved once, threaded
  // through every capturePage/captureScrollGif call below, each of which independently no-ops it when its own
  // `theme` iteration is undefined (the untagged default pass).
  const themeStorageKey = visualConfig?.themeStorageKey ? visualConfig.themeStorageKey : undefined;
  const captureRoutes: CaptureRoute[] = [];
  for (const theme of themes) {
    for (const path of routes) {
      const beforePage = prodBase ? joinUrl(prodBase, path) : "";
      const afterPage = previewBase ? joinUrl(previewBase, path) : "";
      // Render desktop + mobile for each slot in parallel (4 PNGs/route) to bound wall-clock.
      const [beforeShot, beforeMobileShot, afterShot, afterMobileShot] = await Promise.all([
        capturePage(env, target, beforePage, "before", "desktop", DESKTOP_VIEWPORT, diffAvailable, theme, themeStorageKey),
        capturePage(env, target, beforePage, "before", "mobile", MOBILE_VIEWPORT, diffAvailable, theme, themeStorageKey),
        afterPage
          ? capturePage(env, target, afterPage, "after", "desktop", DESKTOP_VIEWPORT, diffAvailable, theme, themeStorageKey)
          : resolveFallbackAfterShot(env, target, path, "desktop", actionsFallbackEnabled, afterPlaceholder),
        afterPage
          ? capturePage(env, target, afterPage, "after", "mobile", MOBILE_VIEWPORT, diffAvailable, theme, themeStorageKey)
          : resolveFallbackAfterShot(env, target, path, "mobile", actionsFallbackEnabled, afterPlaceholder),
      ]);
      // A diff needs BOTH sides' real bytes — a placeholder/dash slot (no preview yet, auth-walled, render
      // failure) has no `png`, so compareCapturedScreenshots degrades to null exactly like a missing shot does.
      const [desktopDiff, mobileDiff] = diffAvailable
        ? await Promise.all([
            compareCapturedScreenshots(beforeShot.png, afterShot.png),
            compareCapturedScreenshots(beforeMobileShot.png, afterMobileShot.png),
          ])
        : [null, null];
      const [diffUrl, diffUrlMobile] = await Promise.all([
        uploadDiffImage(env, target, path, "desktop", desktopDiff, theme),
        uploadDiffImage(env, target, path, "mobile", mobileDiff, theme),
      ]);
      const [beforeGifUrl, afterGifUrl] = gifWanted
        ? await Promise.all([
            captureScrollGif(env, target, beforePage, "before", "desktop", DESKTOP_VIEWPORT, theme, themeStorageKey),
            afterPage ? captureScrollGif(env, target, afterPage, "after", "desktop", DESKTOP_VIEWPORT, theme, themeStorageKey) : Promise.resolve<string | undefined>(undefined),
          ])
        : [undefined, undefined];
      captureRoutes.push({
        path,
        ...(theme ? { theme } : {}),
        beforeUrl: beforeShot.url,
        beforeUrlMobile: beforeMobileShot.url,
        afterUrl: afterShot.url,
        afterUrlMobile: afterMobileShot.url,
        ...(diffUrl ? { diffUrl } : {}),
        ...(diffUrlMobile ? { diffUrlMobile } : {}),
        ...(beforeGifUrl ? { beforeGifUrl } : {}),
        ...(afterGifUrl ? { afterGifUrl } : {}),
      });
    }
  }
  return { routes: captureRoutes, previewPending };
}
