import type { AgentActionMode } from "../../settings/agent-execution";
// Realtime visual capture (reviewbot→loopover convergence — visual port). taopedia-style before/after.
//
// before = production (review.visual.production_url, falling back to the global PUBLIC_SITE_ORIGIN env var);
// after = the PR's preview-deploy URL, discovered the
// provider-agnostic way (Deployments API → commit checks → cloudflare-bot PR comment). Each page is
// rendered once here (in the queue consumer, which has the time budget), stored as a PNG in R2
// (env.REVIEW_AUDIT), and embedded either as <PUBLIC_API_ORIGIN>/loopover/shot?key=<r2key> (this
// instance's own proxy route) or, when REVIEW_AUDIT_S3_PUBLIC_URL is configured (an operator's own
// publicly-readable S3-compatible bucket — see src/selfhost/s3-blob-store.ts), a direct link at the
// bucket's own public URL — see resolveShotUrl below. Either way, GitHub's image proxy fetches a fast
// static object instead of waiting on a live browser render.
//
// PORTED from reviewbot's src/agents/loopover/capture.ts (mapFilesToRoutes / routeForFile / capturePage /
// buildCapture), adapted to loopover bindings + origins. The agent-config-driven route rules, authed-route
// preview session, and explicit-route override are intentionally dropped here — loopover's UI uses the
// default TanStack route convention; those hooks can return if a per-repo visual config is added.
import { base64Encode, sha256Hex } from "../../utils/crypto";
import type { AiContentBlock } from "../../types";
import { isSafeHttpUrl } from "../content-lane/safe-url";
import { downscaleForDisplay, downscaleForVision, isDisplayDownscaleAvailable } from "./image-downscale";
import type { GitHubRateLimitAdmissionKey } from "../../github/client";
import { dispatchVisualCaptureFallback, fallbackShotR2Key, isFallbackDispatchInFlight, markFallbackDispatched } from "./actions-fallback";
import { MAX_PREVIEW_POLL_ATTEMPTS, previewPollAttemptCount, recordPreviewPollAttempt } from "./preview-poll-budget";
import {
  findPreviewUrlFromChecks,
  findPreviewUrlFromPrComments,
  getLatestDeploymentStatus,
  getPreviewBuildState,
  parseRepo,
} from "./preview-url";
import { captureInteractionFrames, captureScrollFrames, captureShot, DESKTOP_VIEWPORT, MOBILE_VIEWPORT, type InteractionAction, type ShotTheme, type Viewport } from "./shot";
import { mintShotRenderToken } from "./shot-render-token";
import { compareCapturedScreenshots, isVisualDiffAvailable, type VisualDiffOutcome } from "./pixel-diff";
import { encodeScrollGif, isScrollGifAvailable } from "./scroll-gif";
import { detectAutoHoverInteractions, type ChangedCssFile } from "./interaction-detection";

const NAMESPACE = "loopover";
const DEFAULT_ROUTES = ["/"];
// The app-folder segment is a wildcard, not hardcoded to loopover-ui: metagraphed's UI (apps/ui/src/routes/)
// uses the identical TanStack flat-file convention `routeForFile` below implements, just under a different app
// folder name. Only ever matched against the CURRENT repo's own changed-file paths (see mapFilesToRoutes'
// caller), so widening this carries no cross-repo ambiguity risk.
const DEFAULT_ROUTE_FILE = /apps\/[^/]+\/src\/routes\/(.+?)\.(?:tsx|jsx)$/i;
// Each route renders desktop + mobile for before + after (up to 4 PNGs). Cap routes to bound browser-render
// wall-clock — Browser Rendering is the costliest binding.
const MAX_ROUTES = 2;
const MAX_CONFIGURED_ROUTES = 5;
const MAX_EXTERNAL_SCREENSHOT_REDIRECTS = 2;
const MAX_EXTERNAL_SCREENSHOT_BYTES = 4 * 1024 * 1024;
const EXTERNAL_SCREENSHOT_FETCH_TIMEOUT_MS = 8_000;
const ALLOWED_EXTERNAL_SCREENSHOT_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

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
  // #6324: a separate, downscaled DISPLAY copy of each shot -- self-host only (see capturePage's own doc
  // comment for why). beforeUrl/afterUrl above are UNCHANGED in meaning (still the full-resolution original,
  // still what "click to open full-size" resolves to); these are additive fields the comment table prefers
  // for the embedded <img> when present, falling back to beforeUrl/afterUrl when absent (hosted mode, or a
  // resize that didn't actually shrink anything). desktop/mobile get independent thumb fields, mirroring
  // beforeUrl/beforeUrlMobile's own split -- both viewports need a bounded thumbnail (see the mobile fix's
  // own doc comment on capturePage's thumbKey below), not just desktop.
  beforeThumbUrl?: string | undefined;
  afterThumbUrl?: string | undefined;
  beforeThumbUrlMobile?: string | undefined;
  afterThumbUrlMobile?: string | undefined;
  diffUrl?: string | undefined;
  diffUrlMobile?: string | undefined;
  beforeGifUrl?: string | undefined;
  afterGifUrl?: string | undefined;
}

/** The capture pipeline's result: the rendered routes, any captured interaction GIFs, plus whether a
 *  preview build is still pending. `interactions` is always `[]` when `review.visual.interactions` is
 *  unconfigured — byte-identical to today for every repo that hasn't opted in. */
export interface CaptureResult {
  routes: CaptureRoute[];
  interactions: CaptureInteractionRoute[];
  previewPending: boolean;
  /**
   * #9464: at least one shot in this capture failed because the RENDERER broke (see `CaptureShotResult.
   * renderFailed`) -- browserless down, saturated, or timing out. Distinct from `previewPending`, which means
   * the page we want to render does not exist yet.
   *
   * Both are "we could not obtain evidence", and the screenshot-table gate must defer its one-shot close for
   * either. Before this, a renderer failure was swallowed per shot and `buildCapture` returned NORMALLY with
   * `previewPending: false` and no throw, so the #9030/#9207 blip guards -- which trigger only on
   * previewPending or a thrown error -- never fired, and the gate closed legitimate visual PRs during a
   * browserless outage.
   */
  renderFailed: boolean;
  /** #9881: the preview is not late or broken -- this repo has NO preview pipeline at all. Set only when the
   *  build state was `absent` (no preview check-run found whatsoever, across every poll) AND the per-head
   *  poll budget is spent. That pair is the proof the screenshot-table gate needs to tell "no evidence found"
   *  apart from "evidence was never obtainable" before it closes anyone's PR. */
  previewUnobtainable: boolean;
}

/** True when `url` is a persisted rendered shot. `capturePage` can also return an on-demand `?url=`
 *  fallback when R2 is unavailable or a browser render fails; that link is useful review UI, but it is not
 *  proof the bot produced a before/after PNG pair for the current head. Only cached `?key=` shots are strong
 *  enough to satisfy the screenshot-table gate without a hand-authored table. */
function isPersistedShotUrl(url: string | undefined): boolean {
  return (
    typeof url === "string" &&
    url.length > 0 &&
    url.includes("/shot?") &&
    url.includes("key=") &&
    !url.includes("placeholder=")
  );
}

/** True when `route` has a real before+after PAIR on at least one viewport (desktop or mobile) — the
 *  deterministic signal {@link hasSuccessfulBotCapture} uses per-route. Requiring BOTH sides of the SAME
 *  viewport (not "any before" + "any after" mixed across viewports) mirrors what a reviewer actually sees in
 *  the "Visual preview" table: one comparable pair, not two unrelated renders. */
function routeHasRealBeforeAfterPair(route: CaptureRoute): boolean {
  const desktopReal = isPersistedShotUrl(route.beforeUrl) && isPersistedShotUrl(route.afterUrl);
  const mobileReal = isPersistedShotUrl(route.beforeUrlMobile) && isPersistedShotUrl(route.afterUrlMobile);
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

/**
 * Fetch an already-captured shot (a `CaptureRoute.before*`/`after*` URL) and return it as an `AiContentBlock`
 * for a vision-capable AI call (#4111 wiring) — every captured shot is a PNG (see `capturePage`'s
 * `screenshot({type: "png", ...})` call in `./shot.ts`), so the MIME type is fixed rather than sniffed.
 * Returns undefined on any fetch/read failure so one broken image degrades to "drop this image", never a
 * thrown error — mirrors `capturePage`'s own "returns null on any failure so callers degrade gracefully"
 * convention.
 */
export async function fetchShotContentBlock(url: string): Promise<AiContentBlock | undefined> {
  try {
    // Bound the fetch like every other external screenshot call in this file (#7070) -- resolveShotUrl below
    // already uses this same timeout; a TimeoutError rejection is caught by the surrounding catch.
    const response = await fetch(url, { signal: AbortSignal.timeout(EXTERNAL_SCREENSHOT_FETCH_TIMEOUT_MS) });
    if (!response.ok) return undefined;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { type: "image", data: base64Encode(await downscaleForVision(bytes)), mimeType: "image/png" };
  } catch {
    return undefined;
  }
}


function redirectLocation(response: Response, currentUrl: string): string {
  const location = response.headers.get("location");
  if (!location) return "";
  try {
    return new URL(location, currentUrl).toString();
  } catch {
    return "";
  }
}

async function readBoundedResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array | undefined> {
  const contentLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) return undefined;
  /* v8 ignore next -- Fetch Response bodies are present in Workers/Node; keep the fallback for nonstandard test doubles. */
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength > maxBytes ? undefined : bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) return undefined;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Fetch a contributor-supplied screenshot-table image with SSRF/resource guards before it can be compared
 * locally or forwarded to a vision provider. Unlike bot-produced shot URLs, these URLs come from PR markdown:
 * re-check every redirect hop, cap bytes before buffering, require a real image content type, and time out.
 */
export async function fetchExternalScreenshotContentBlock(url: string): Promise<AiContentBlock | undefined> {
  try {
    let currentUrl = url;
    for (let redirects = 0; redirects <= MAX_EXTERNAL_SCREENSHOT_REDIRECTS; redirects += 1) {
      if (!isSafeHttpUrl(currentUrl)) return undefined;
      const response = await fetch(currentUrl, { redirect: "manual", signal: AbortSignal.timeout(EXTERNAL_SCREENSHOT_FETCH_TIMEOUT_MS) });
      if (response.status >= 300 && response.status < 400) {
        const nextUrl = redirectLocation(response, currentUrl);
        if (!nextUrl) return undefined;
        currentUrl = nextUrl;
        continue;
      }
      if (!response.ok) return undefined;
      const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      if (!ALLOWED_EXTERNAL_SCREENSHOT_MIME_TYPES.has(mimeType)) return undefined;
      const bytes = await readBoundedResponseBytes(response, MAX_EXTERNAL_SCREENSHOT_BYTES);
      if (!bytes) return undefined;
      const imageBytes = mimeType === "image/png" ? await downscaleForVision(bytes) : bytes;
      return { type: "image", data: base64Encode(imageBytes), mimeType };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Inputs the capture pipeline needs about the PR under review (resolved by the caller from loopover data). */
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
  /** #9067: the pass's resolved AgentActionMode. REQUIRED to dispatch the actions_fallback workflow -- that
   *  dispatch is a real GitHub WRITE (it starts an Actions run and burns CI minutes in the target repo), but
   *  it goes out via raw timeoutFetch and so bypasses makeInstallationOctokit's mutation-suppression hook,
   *  which is the structural invariant every other installation write relies on. runVisualCapture only ever
   *  short-circuited on `paused`, so under `dry_run` this fired for real -- directly contradicting the
   *  documented dry-run contract. Absent ⇒ treated as non-live and the dispatch never fires (fail-safe). */
  mode?: AgentActionMode | undefined;
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
 * more robust for a repo whose routing convention isn't loopover-ui's TanStack file-based one); absent/
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
 * The publicly-servable URL for an already-stored REVIEW_AUDIT key. Prefers a direct link at the operator's
 * own S3-compatible bucket (REVIEW_AUDIT_S3_PUBLIC_URL) so GitHub's image proxy — and every other viewer —
 * fetches straight from that bucket's own CDN, never touching this instance at all. Falls back to this
 * instance's own /loopover/shot?key= proxy route (today's only option, and still the only option for the
 * filesystem-backed self-host store, which has no public URL of its own). Empty string when neither is
 * configured, matching every call site's existing "no shotBase" degradation.
 */
function resolveShotUrl(env: Env, key: string): string {
  if (env.REVIEW_AUDIT_S3_PUBLIC_URL) {
    return `${env.REVIEW_AUDIT_S3_PUBLIC_URL.replace(/\/+$/, "")}/${key}`;
  }
  const shotBase = env.PUBLIC_API_ORIGIN;
  return shotBase ? `${shotBase}/${NAMESPACE}/shot?key=${encodeURIComponent(key)}` : "";
}

/**
 * Render `page`, store the PNG in R2, and return its /loopover/shot?key= URL. Falls back to an on-demand
 * ?url= link if R2 or the render is unavailable; returns {} when there is no page (no preview deploy yet) so
 * the cell shows a dash. Reuses an identical cached fingerprint (a deployment_status re-run filling "after"
 * cells would otherwise re-render the same screenshot — Browser Rendering is the costliest binding).
 */
/** What `capturePage` and its no-preview sibling `resolveFallbackAfterShot` both resolve to. `renderFailed`
 *  is optional because only the live-render path can observe it -- see {@link CaptureResult.renderFailed}. */
type CapturedShot = { url?: string | undefined; thumbUrl?: string | undefined; png?: Uint8Array | undefined; renderFailed?: boolean | undefined };

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
): Promise<CapturedShot> {
  if (!page) return {};
  // #9464: sticky for the whole call, because the only return that can carry it is the on-demand tail below --
  // every earlier return is a definite outcome (cache hit, auth wall, a real PNG) that by construction cannot
  // have come from a broken renderer.
  let renderFailed = false;
  const shotBase = env.PUBLIC_API_ORIGIN; // this worker's public origin (serves /loopover/shot)
  // Carries the theme (#3678) and, when set, the storage key (#4109) so a LATER on-demand fetch of this
  // exact URL (e.g. a failed/never-persisted render retried by GitHub's image proxy) still requests the
  // matching prefers-color-scheme/localStorage forcing, not the default — handleShot's Mode B reads these
  // same &theme=/&themeStorageKey= params. Omitted when unset, unchanged from today. The trailing
  // &exp=&sig= (#9044) is a signed, expiring token ORB mints for exactly this url -- routes.ts requires it
  // before ever invoking the render path, so a live Chromium render only ever happens for a page ORB itself
  // decided to capture. See shot-render-token.ts's own doc comment for the full threat model.
  const onDemand = shotBase
    ? `${shotBase}/${NAMESPACE}/shot?url=${encodeURIComponent(page)}&w=${viewport.width}&h=${viewport.height}${theme ? `&theme=${theme}` : ""}${theme && themeStorageKey ? `&themeStorageKey=${encodeURIComponent(themeStorageKey)}` : ""}&${await mintShotRenderToken(env, page)}`
    : page;

  if (env.REVIEW_AUDIT) {
    // Key includes the viewport (and, when set, the theme + storage key) so desktop/mobile, light/dark, and
    // differently-configured-storage-key shots of the same page don't collide in R2.
    const fingerprint = await sha256Hex(
      `${target.headSha ?? target.prNumber}:${slot}:${viewportName}:${page}${theme ? `:${theme}` : ""}${theme && themeStorageKey ? `:${themeStorageKey}` : ""}`,
    );
    const key = `${NAMESPACE}/shots/${fingerprint.slice(0, 40)}.png`;
    const url = resolveShotUrl(env, key) || onDemand;
    // #6324 / mobile-thumb-fix: a downscaled DISPLAY copy, stored at a SIBLING key so the original at `key`
    // never changes -- diffing (compareCapturedScreenshots, via includeBytes below) always reads the true
    // original on both a fresh render AND a cache hit, and "click to open full-size" keeps resolving to it
    // unchanged. Self-host only (isDisplayDownscaleAvailable). Generated for BOTH viewports, not desktop-only
    // as originally shipped: that desktop-only gate assumed the mobile viewport's 390px WIDTH being already
    // close to the table's 360px display width meant a resize would "save little" -- true for width, but
    // shot.ts captures `fullPage: true`, so a mobile screenshot's HEIGHT is just as unbounded as desktop's,
    // and a narrow-but-very-tall capture rendered at native size in the comment table (the reported bug).
    // downscaleForDisplay now bounds height too (see its own doc comment), so a mobile thumb is worth
    // generating exactly like a desktop one.
    const thumbKey = isDisplayDownscaleAvailable() ? `${NAMESPACE}/shots/${fingerprint.slice(0, 40)}-thumb.png` : undefined;
    const cached = await env.REVIEW_AUDIT.get(key).catch(() => null);
    if (cached) {
      // Verified via a real read, not assumed from the original's own existence -- the sibling write below
      // is best-effort and can independently fail, so a stale/missing thumb must fall back to the full-res
      // URL rather than ever risk embedding a broken image link.
      const thumbCached = thumbKey ? await env.REVIEW_AUDIT.get(thumbKey).catch(() => null) : null;
      const thumbUrl = thumbCached && thumbKey ? resolveShotUrl(env, thumbKey) || undefined : undefined;
      if (!includeBytes) return { url, ...(thumbUrl ? { thumbUrl } : {}) };
      const bytes = await new Response(cached.body).arrayBuffer().then((buf) => new Uint8Array(buf)).catch(() => undefined);
      return { url, ...(thumbUrl ? { thumbUrl } : {}), ...(bytes ? { png: bytes } : {}) };
    }
    // The outer `.catch` reports renderFailed too: captureShot swallows its own renderer errors, so anything
    // that still escapes it (a DNS-guard or token-mint throw) is likewise an outcome we could not determine.
    const { png, authWalled, renderFailed: shotRenderFailed } = await captureShot(env, page, viewport, theme ? { theme, ...(themeStorageKey ? { themeStorageKey } : {}) } : {}).catch(() => ({
      png: null,
      authWalled: false,
      renderFailed: true,
    }));
    renderFailed = shotRenderFailed;
    // A protected route that redirected to a sign-in wall: show an honest "requires authentication"
    // placeholder rather than caching/serving a screenshot of the login screen.
    if (authWalled) {
      return { url: shotBase ? `${shotBase}/${NAMESPACE}/shot?placeholder=auth` : onDemand };
    }
    if (png) {
      await env.REVIEW_AUDIT.put(key, png, { httpMetadata: { contentType: "image/png" } }).catch(() => undefined);
      let thumbUrl: string | undefined;
      if (thumbKey) {
        const displayPng = await downscaleForDisplay(png).catch(() => png);
        // Skip storing/using the thumb entirely when downscaling genuinely didn't shrink anything (an
        // already-narrow capture, or a decode/resize failure that degraded to the original bytes) -- a
        // byte-identical copy at a second key is pure waste, not an optimization.
        if (displayPng.byteLength < png.byteLength) {
          // thumbUrl must only be set once the write is CONFIRMED to have succeeded -- a bare
          // `.catch(() => undefined)` here would swallow a write failure and still fall through to embed a
          // URL for an object that was never actually stored, a broken image link for every viewer.
          const stored = await env.REVIEW_AUDIT.put(thumbKey, displayPng, { httpMetadata: { contentType: "image/png" } }).then(() => true).catch(() => false);
          if (stored) thumbUrl = resolveShotUrl(env, thumbKey) || undefined;
        }
      }
      return { url, ...(thumbUrl ? { thumbUrl } : {}), ...(includeBytes ? { png } : {}) };
    }
  }
  return { url: onDemand, renderFailed };
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
): Promise<CapturedShot> {
  // #6324: never produces a thumbUrl (the actions_fallback artifact is stored as-is, no display downscale
  // applied) -- typed here purely so this function's return shape matches capturePage's, since buildCapture
  // uses both interchangeably for the "after" desktop slot.
  if (!actionsFallbackEnabled || !env.REVIEW_AUDIT || !target.headSha) return { url: placeholder };
  const key = await fallbackShotR2Key(target.headSha, path, viewportName);
  const cached = await env.REVIEW_AUDIT.get(key).catch(() => null);
  if (!cached) return { url: placeholder };
  return { url: resolveShotUrl(env, key) || placeholder };
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
  if (!env.REVIEW_AUDIT || (!env.PUBLIC_API_ORIGIN && !env.REVIEW_AUDIT_S3_PUBLIC_URL)) return undefined;
  const fingerprint = await sha256Hex(`${target.headSha ?? target.prNumber}:diff:${viewportName}:${path}${theme ? `:${theme}` : ""}`);
  const key = `${NAMESPACE}/shots/${fingerprint.slice(0, 40)}-diff.png`;
  await env.REVIEW_AUDIT.put(key, diff.diffImagePng, { httpMetadata: { contentType: "image/png" } }).catch(() => undefined);
  return resolveShotUrl(env, key);
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
  if (!env.REVIEW_AUDIT || (!env.PUBLIC_API_ORIGIN && !env.REVIEW_AUDIT_S3_PUBLIC_URL)) return undefined;
  const fingerprint = await sha256Hex(
    `${target.headSha ?? target.prNumber}:scrollgif:${slot}:${viewportName}:${page}${theme ? `:${theme}` : ""}${theme && themeStorageKey ? `:${themeStorageKey}` : ""}`,
  );
  const key = `${NAMESPACE}/shots/${fingerprint.slice(0, 40)}.gif`;
  const url = resolveShotUrl(env, key);
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

/** One `review.visual.interactions[]` entry, as resolved by the caller from the manifest. */
export type VisualInteractionInput = {
  selector: string;
  action: InteractionAction;
  /** The drag destination selector — required when `action` is `"drag"`, ignored otherwise. */
  dragTo?: string | null | undefined;
  path?: string | null | undefined;
  label?: string | null | undefined;
};

/** Capture `interaction` for `page` and assemble it into a GIF, or undefined when there's no page, the
 *  selector never matches / the render fails/auth-walls, storage is unavailable, or this build can't
 *  assemble GIFs at all (isScrollGifAvailable — reused here; the encode step is frame-source-agnostic, see
 *  scroll-gif.ts). Same fingerprint-cache scheme as `captureScrollGif`, with the selector+action folded into
 *  the key so two different interactions on the same page never collide.
 */
async function captureInteractionGif(
  env: Env,
  target: CaptureTarget,
  page: string,
  slot: "before" | "after",
  interaction: VisualInteractionInput,
  theme?: ShotTheme | undefined,
  themeStorageKey?: string | undefined,
): Promise<string | undefined> {
  if (!page) return undefined;
  if (!env.REVIEW_AUDIT || (!env.PUBLIC_API_ORIGIN && !env.REVIEW_AUDIT_S3_PUBLIC_URL)) return undefined;
  // JSON.stringify an array (not bare `:`-joined interpolation, unlike captureScrollGif's fingerprint above,
  // which has no arbitrary-text fields) -- selector/dragTo are maintainer-authored free text that can itself
  // contain ":", so a bare-delimiter join can collide (`{selector:"x:drag", dragTo:"y"}` and
  // `{selector:"x", dragTo:"drag:y"}` would otherwise both produce "...x:drag:drag:y..."). JSON's own string
  // quoting makes each array element self-delimiting, so two distinct field tuples can never hash identically.
  const fingerprint = await sha256Hex(
    JSON.stringify([
      target.headSha ?? target.prNumber,
      "interactiongif",
      slot,
      interaction.selector,
      interaction.action,
      interaction.action === "drag" ? (interaction.dragTo ?? null) : null,
      page,
      theme ?? null,
      theme && themeStorageKey ? themeStorageKey : null,
    ]),
  );
  const key = `${NAMESPACE}/shots/${fingerprint.slice(0, 40)}.gif`;
  const url = resolveShotUrl(env, key);
  const cached = await env.REVIEW_AUDIT.get(key).catch(() => null);
  if (cached) return url;
  const { frames, authWalled } = await captureInteractionFrames(
    env,
    page,
    interaction.selector,
    interaction.action,
    DESKTOP_VIEWPORT,
    theme ? { theme, ...(themeStorageKey ? { themeStorageKey } : {}) } : {},
    interaction.dragTo ?? undefined,
  ).catch(() => ({ frames: [] as Uint8Array[], authWalled: false }));
  if (authWalled || frames.length === 0) return undefined;
  const gifBytes = await encodeScrollGif(
    frames.map((png) => ({ png })),
    GIF_FRAME_DELAY_MS,
  );
  if (!gifBytes) return undefined;
  await env.REVIEW_AUDIT.put(key, gifBytes, { httpMetadata: { contentType: "image/gif" } }).catch(() => undefined);
  return url;
}

/** One `review.visual.interactions[]` entry's captured result (#interaction-gif-capture) — before/after GIF
 *  URLs for a specific hover/click interaction. Rendered as its own "Interaction preview" row, one per
 *  configured interaction (never multiplied by viewport/theme, unlike `CaptureRoute`). `selector`/`label`
 *  round-trip the input config so the comment can show a human-readable target without re-reading config. */
export interface CaptureInteractionRoute {
  selector: string;
  label?: string | undefined;
  beforeGifUrl?: string | undefined;
  afterGifUrl?: string | undefined;
}

// Bounds how many configured interactions actually get captured per PR — mirrors MAX_ROUTES's wall-clock
// reasoning (each interaction is at least as expensive as a scroll-GIF capture: a full render plus 3+ extra
// frames per side). parseVisualInteractions (packages/loopover-engine) already caps the CONFIG list itself
// at 5; this is a second, independent bound on what actually executes, so a future config-cap change can't
// silently blow the capture budget without a matching review here.
const MAX_INTERACTIONS = 3;

/** Per-repo `review.visual` config, as resolved by the caller from the manifest (#3609 / #3610 / #3678 /
 *  #3612 / #4109). Absent ⇒ byte-identical to today (GitHub-native discovery, automatic route inference,
 *  single default-theme capture, built-in route cap, no scroll-GIF, no localStorage theme forcing). */
export type VisualCaptureConfig = {
  /** `review.visual.production_url` (#3611 follow-up): overrides `env.PUBLIC_SITE_ORIGIN` (a single GLOBAL
   *  value with no per-repo awareness) as the "before" base for THIS repo. ALWAYS wins when set, mirroring
   *  `preview.urlTemplate`'s precedence over discovery. null/undefined ⇒ falls back to `env.PUBLIC_SITE_ORIGIN`,
   *  byte-identical to today. */
  productionUrl?: string | null | undefined;
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
  /** `review.visual.interactions`: specific elements to interact with (hover/click) and capture as animated
   *  evidence, for behavior a static screenshot can't show that isn't scroll-linked. Empty/absent (default)
   *  ⇒ byte-identical to today, no interaction capture. Capped at MAX_INTERACTIONS regardless of how many
   *  are configured. */
  interactions?: readonly VisualInteractionInput[] | null | undefined;
  /** `review.visual.autoDetectInteractions` (#auto-interaction-detection): capture a hover-interaction GIF
   *  for any CSS selector this PR's OWN diff newly adds a `:hover`/`:focus-visible` rule for — no maintainer
   *  selector-authoring needed, unlike `interactions` above (the two compose, deduped against each other).
   *  false/absent (default) ⇒ byte-identical to today. Requires `changedCssFiles` (below) to be passed too;
   *  without it there is nothing to detect against regardless of this flag. */
  autoDetectInteractions?: boolean | null | undefined;
};

/**
 * Build the before/after capture for a PR: resolve the preview URL, derive routes from the changed UI files,
 * render desktop + mobile before/after for each route, and return the route URL set (for the visual-preview
 * collapsible). Fully fail-safe — a missing preview / failed render degrades to placeholders or dashes; this
 * NEVER throws (the caller also wraps it in try/catch so a capture failure can't sink a review).
 */
export async function buildCapture(
  env: Env,
  token: string,
  target: CaptureTarget,
  visualFiles: string[],
  rateLimitAdmissionKey?: GitHubRateLimitAdmissionKey | undefined,
  visualConfig?: VisualCaptureConfig | null | undefined,
  // #auto-interaction-detection: the SAME changed-file set visualFiles is derived from, but carrying each
  // file's diff patch text too (visualFiles alone is bare paths) -- only ever read when
  // visualConfig.autoDetectInteractions is true. Absent/undefined (every pre-existing call site) ⇒
  // byte-identical to today, no auto-detection attempted regardless of the config flag.
  changedCssFiles?: readonly ChangedCssFile[] | undefined,
): Promise<CaptureResult> {
  const repo = parseRepo(target.repoFullName);
  const apiVersion = "2022-11-28";
  // before = production. review.visual.production_url (#3611 follow-up) ALWAYS wins when set -- PUBLIC_SITE_ORIGIN
  // is a single GLOBAL env var (e.g. https://loopover.ai) with no per-repo awareness, correct for at
  // most one repo on a multi-repo self-host instance; every other repo needs its own override here.
  const prodBase = visualConfig?.productionUrl ? visualConfig.productionUrl : (env.PUBLIC_SITE_ORIGIN ?? "");

  // after = the PR's preview deploy. An explicit review.visual.preview.url_template (#3609) ALWAYS wins —
  // a maintainer-configured template is a stronger signal than inference, and is the only option for a
  // provider (e.g. Cloudflare Workers Builds' non-production branch builds) that never surfaces a
  // GitHub-visible deployment at all. Otherwise, prefer the URL carried on the target (a deployment_status
  // webhook set it — no extra API call); otherwise look it up from Deployments, then commit checks, then
  // the cloudflare-bot PR comment. The lookups also tell us when the latest deploy FAILED (vs is still
  // building) so we can show a terminal "deploy failed" card instead of a spinner.
  let previewBase = "";
  let previewFailed = target.previewFailed === true;
  let previewUnobtainable = false;
  let previewPending = false;
  // Hoisted above the discovery block below (was previously computed after it) so the eternal-"loading"-
  // placeholder fix's `buildState === "absent"` branch can consult it -- seeing this whole file top to
  // bottom, its own later use (guarding the actions_fallback dispatch) is unchanged.
  const actionsFallbackEnabled = visualConfig?.actionsFallback === true;
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
          if (buildState === "failed") {
            previewFailed = true;
          } else if (buildState === "building" || buildState === "succeeded") {
            // #6323: bound how many times ANY trigger treats this head as worth another attempt, not just
            // the dedicated self-poll job chain -- see preview-poll-budget.ts's own doc comment for the bug
            // this fixes. Past the budget, give up honestly (the FAILED placeholder card, "review manually")
            // rather than an eternally-spinning "loading" placeholder that never resolves.
            const attempts = await previewPollAttemptCount(env, target.headSha);
            if (attempts >= MAX_PREVIEW_POLL_ATTEMPTS) {
              previewFailed = true;
            } else {
              await recordPreviewPollAttempt(env, target.headSha);
              previewPending = true;
            }
          } else if (buildState === "absent" && !actionsFallbackEnabled) {
            // Eternal-"loading"-placeholder fix: 'absent' means no Workers-Builds-named check-run was found
            // AT ALL, not "still building" -- previously this fell through as a silent no-op, leaving
            // previewPending/previewFailed both false, so the caller's afterPlaceholder always resolved to
            // the animated "Rendering preview…" spinner and NOTHING ever re-evaluated it to a terminal
            // state (this state was never fed into the recapture-poll mechanism at all). Confirmed live on a
            // repo whose UI has no preview-deploy CI configured: every PR's "after" cell spun forever. 'absent'
            // is genuinely ambiguous on its own (the check-run may just not have started yet), so apply the
            // SAME poll-budget-then-give-up treatment as 'building' above rather than assuming either
            // extreme. Skipped when actions_fallback is enabled for this repo: that feature's OWN dispatch
            // below already treats "found nothing" as its trigger condition, and marking previewPending here
            // first would starve it of the `!previewPending` gate it needs to ever fire.
            const attempts = await previewPollAttemptCount(env, target.headSha);
            if (attempts >= MAX_PREVIEW_POLL_ATTEMPTS) {
              previewFailed = true;
              // #9881: `absent` means no preview check-run was ever found, and the budget is now spent -- so
              // this is not a late or broken deploy, it is a repo with no preview pipeline. Recording it is
              // what lets the screenshot-table gate decline to CLOSE on evidence it could never obtain.
              previewUnobtainable = true;
            } else {
              await recordPreviewPollAttempt(env, target.headSha);
              previewPending = true;
            }
          }
        }
      }
    }
  }

  // Fallback (#4112): the discovery chain above found NOTHING at all for this repo (no preview URL, not
  // failed, and no real build already in flight) -- if review.visual.actions_fallback is enabled
  // (actionsFallbackEnabled, hoisted above), dispatch .github/workflows/visual-capture-fallback.yml against
  // the repo's own default branch and mark previewPending so the EXISTING recapture-poll mechanism
  // (processors.ts) retries this same buildCapture call later, by which point the workflow_run webhook
  // handler (running independently) has stored the fallback's captured PNGs in R2 for
  // resolveFallbackAfterShot below to find. Requires headSha + a resolved default branch to pin the dispatch
  // to a trusted ref; either missing ⇒ no dispatch (fail-safe).
  const routes = resolveVisualRoutes(visualFiles, visualConfig?.routes);
  if (!previewBase && !previewFailed && !previewPending && actionsFallbackEnabled && target.headSha && target.defaultBranchRef) {
    // Never re-dispatch onto an already in-flight run (#4112 review fix): the workflow's own `concurrency:
    // cancel-in-progress: true` group would CANCEL that run the instant a second dispatch for the same head
    // SHA lands, so a recapture-poll retry (every 90s -- see PREVIEW_POLL_SECONDS in processors.ts) firing
    // well within the workflow's 15-minute timeout could cancel-and-restart it on every poll and never
    // complete. isFallbackDispatchInFlight checks a PERSISTED R2 marker rather than querying GitHub's runs
    // API live, so there's no eventual-consistency gap right after a dispatch just succeeded -- see its own
    // doc comment for the full rationale. markFallbackDispatched writes that marker on a successful dispatch;
    // the webhook handler (processors.ts) clears it once the run settles.
    const alreadyInFlight = await isFallbackDispatchInFlight(env, target.headSha);
    let dispatched = alreadyInFlight;
    if (!dispatched) {
      dispatched = await dispatchVisualCaptureFallback({
        token,
        repo,
        ref: target.defaultBranchRef,
        prNumber: target.prNumber,
        headSha: target.headSha,
        routes,
        rateLimitAdmissionKey,
        // #9067: threaded so the writer itself can refuse under dry_run/paused (see its own doc comment).
        mode: target.mode,
      });
      if (dispatched) await markFallbackDispatched(env, target.headSha);
    }
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
  // #9464: ORed across every shot of every route/viewport/theme. ONE failed render is enough -- the gate's
  // question is "could we have missed evidence?", and a partial outage answers yes. When some routes DID
  // render, hasSuccessfulBotCapture already satisfies the gate and this never gets consulted.
  let renderFailed = false;
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
      if ([beforeShot, beforeMobileShot, afterShot, afterMobileShot].some((shot) => shot.renderFailed === true)) renderFailed = true;
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
      // #fairness-analytics follow-up: when there's no live preview page, fall back to the SAME
      // loading/failed placeholder the screenshot slot uses (afterPlaceholder) instead of leaving this
      // undefined -- otherwise buildScrollPreviewCollapsible's cell() renders a bare "—", indistinguishable
      // from "GIF capture isn't enabled for this repo at all". actions_fallback never produces a GIF (only
      // static PNGs — see visual-capture-fallback.yml), so there's no cached fallback artifact to look up
      // here the way resolveFallbackAfterShot does for the screenshot slot.
      const [beforeGifUrl, afterGifUrl] = gifWanted
        ? await Promise.all([
            captureScrollGif(env, target, beforePage, "before", "desktop", DESKTOP_VIEWPORT, theme, themeStorageKey),
            afterPage
              ? captureScrollGif(env, target, afterPage, "after", "desktop", DESKTOP_VIEWPORT, theme, themeStorageKey)
              : Promise.resolve<string | undefined>(afterPlaceholder),
          ])
        : [undefined, undefined];
      captureRoutes.push({
        path,
        ...(theme ? { theme } : {}),
        beforeUrl: beforeShot.url,
        beforeUrlMobile: beforeMobileShot.url,
        afterUrl: afterShot.url,
        afterUrlMobile: afterMobileShot.url,
        ...(beforeShot.thumbUrl ? { beforeThumbUrl: beforeShot.thumbUrl } : {}),
        ...(afterShot.thumbUrl ? { afterThumbUrl: afterShot.thumbUrl } : {}),
        ...(beforeMobileShot.thumbUrl ? { beforeThumbUrlMobile: beforeMobileShot.thumbUrl } : {}),
        ...(afterMobileShot.thumbUrl ? { afterThumbUrlMobile: afterMobileShot.thumbUrl } : {}),
        ...(diffUrl ? { diffUrl } : {}),
        ...(diffUrlMobile ? { diffUrlMobile } : {}),
        ...(beforeGifUrl ? { beforeGifUrl } : {}),
        ...(afterGifUrl ? { afterGifUrl } : {}),
      });
    }
  }

  // Interaction capture (#interaction-gif-capture): NOT multiplied by theme/route the way captureRoutes is
  // above -- a hover/click interaction is captured once per configured entry, against its OWN `path` (not
  // every route this PR touches), mirroring the contributor-facing animated-evidence contract's "one row per
  // interaction target" shape. Gated on isScrollGifAvailable() (reused: the encode step is frame-source-
  // agnostic, see scroll-gif.ts) since there is no point capturing frames this build can never assemble into
  // a GIF -- self-host only, same as the scroll-GIF path above.
  const manualInteractions = visualConfig?.interactions ?? [];
  // #auto-interaction-detection: a maintainer-configured selector always wins on overlap -- an explicit
  // entry may carry a label/path/action the detector could never infer, so a hand-authored duplicate is
  // dropped from the auto-detected set rather than the other way around. Both selector sets are compared
  // case-insensitively, matching detectAutoHoverInteractions' own dedup.
  const manualSelectors = new Set(manualInteractions.map((interaction) => interaction.selector.toLowerCase()));
  const autoDetectedInteractions: VisualInteractionInput[] =
    visualConfig?.autoDetectInteractions && changedCssFiles
      ? detectAutoHoverInteractions(changedCssFiles)
          .filter((selector) => !manualSelectors.has(selector.toLowerCase()))
          .map((selector) => ({
            selector,
            action: "hover" as const,
            // captureRoutes[0] is unreachable-undefined by construction here, not a reachable false case:
            // `themes` above is always at least `[undefined]` and `routes` (resolveVisualRoutes ->
            // mapFilesToRoutes) always falls back to DEFAULT_ROUTES when nothing else resolves, so the
            // routes x themes double loop above always pushes at least one entry -- noUncheckedIndexedAccess
            // still requires the optional chaining at the type level.
            /* v8 ignore next */
            path: captureRoutes[0]?.path ?? null,
          }))
      : [];
  const interactionsConfigured = [...manualInteractions, ...autoDetectedInteractions].slice(0, MAX_INTERACTIONS);
  const interactionRoutes: CaptureInteractionRoute[] = [];
  // Interactions aren't multiplied per-theme (see comment above) -- when review.visual.themes configures more
  // than one, the first configured theme is what interaction GIFs render in; themes[0] is `undefined` by
  // default (no theme config), matching every other un-emulated default capture in this file.
  const interactionTheme = themes[0];
  if (interactionsConfigured.length > 0 && isScrollGifAvailable()) {
    for (const interaction of interactionsConfigured) {
      const interactionPath = interaction.path ?? "/";
      const afterPage = previewBase ? joinUrl(previewBase, interactionPath) : "";
      // SECURITY (#interaction-gif-capture): click/drag are real, state-mutating browser actions -- a genuine
      // click event, or a real mouse-down/move/up drag sequence -- unlike hover, which can never trigger a
      // click handler, form submit, or same-origin mutating request. Running click/drag against `prodBase`
      // (the repo's PRODUCTION origin, see this function's own "before = production" comment above) would
      // fire that real action against the LIVE SITE on every qualifying commit of every PR that touches a
      // visual path, for as long as a maintainer has one configured -- the existing isSafeHttpUrl/
      // isAllowedUrl SSRF guard only validates a URL is safe to NAVIGATE to, it has no concept of "this
      // specific action is safe to perform" once there. hover never mutates state, so it's the only action
      // still captured against production (real before/after comparison value); click/drag are preview-only.
      const beforePage = interaction.action === "hover" && prodBase ? joinUrl(prodBase, interactionPath) : "";
      // beforePage is passed unconditionally (relying on captureInteractionGif's own `!page` guard) rather
      // than ternary-gated here -- mirrors captureScrollGif's call above (line 767), which does the same for
      // its own "before" side.
      const [beforeGifUrl, afterGifUrl] = await Promise.all([
        captureInteractionGif(env, target, beforePage, "before", interaction, interactionTheme, themeStorageKey),
        afterPage ? captureInteractionGif(env, target, afterPage, "after", interaction, interactionTheme, themeStorageKey) : Promise.resolve<string | undefined>(undefined),
      ]);
      if (beforeGifUrl || afterGifUrl) {
        interactionRoutes.push({
          selector: interaction.selector,
          ...(interaction.label ? { label: interaction.label } : {}),
          ...(beforeGifUrl ? { beforeGifUrl } : {}),
          ...(afterGifUrl ? { afterGifUrl } : {}),
        });
      }
    }
  }

  return { routes: captureRoutes, interactions: interactionRoutes, previewPending, renderFailed, previewUnobtainable };
}
