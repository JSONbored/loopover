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
import {
  findPreviewUrlFromChecks,
  findPreviewUrlFromPrComments,
  getLatestDeploymentStatus,
  getPreviewBuildState,
  parseRepo,
} from "./preview-url";
import { captureShot, DESKTOP_VIEWPORT, MOBILE_VIEWPORT, type Viewport } from "./shot";

const NAMESPACE = "gittensory";
const DEFAULT_ROUTES = ["/"];
const DEFAULT_ROUTE_FILE = /apps\/gittensory-ui\/src\/routes\/(.+?)\.(?:tsx|jsx)$/i;
// Each route renders desktop + mobile for before + after (up to 4 PNGs). Cap routes to bound browser-render
// wall-clock — Browser Rendering is the costliest binding.
const MAX_ROUTES = 2;

/** A single captured route's before/after shot URLs (desktop + mobile). undefined slot ⇒ a dash cell. */
export interface CaptureRoute {
  path: string;
  beforeUrl?: string | undefined;
  beforeUrlMobile?: string | undefined;
  afterUrl?: string | undefined;
  afterUrlMobile?: string | undefined;
}

/** The capture pipeline's result: the rendered routes, plus whether a preview build is still pending. */
export interface CaptureResult {
  routes: CaptureRoute[];
  previewPending: boolean;
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
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Map changed UI files to navigable routes, honoring TanStack Router's file conventions (flat routing uses
 * `.` as the path separator; folders use `/`):
 *   __root.tsx / index.tsx -> "/"   ·   app.index.tsx -> "/app"   ·   app.analytics.tsx -> "/app/analytics"
 *   _authed.app.tsx -> "/app" (pathless `_` layout) · (marketing).about.tsx -> "/about" (route group)
 *   posts.$id.tsx -> "/" (dynamic param has no concrete value to render)
 * Anything we can't resolve to a concrete path falls back to "/" so we never screenshot a 404.
 */
export function mapFilesToRoutes(files: string[], pattern: RegExp = DEFAULT_ROUTE_FILE): string[] {
  const routes = new Set<string>();
  for (const file of files) {
    const match = file.match(pattern);
    if (match) routes.add(routeForFile(match[1] as string));
  }
  if (routes.size === 0) for (const route of DEFAULT_ROUTES) routes.add(route);
  return [...routes].slice(0, MAX_ROUTES);
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
): Promise<{ url?: string | undefined }> {
  if (!page) return {};
  const shotBase = env.PUBLIC_API_ORIGIN; // this worker's public origin (serves /gittensory/shot)
  const onDemand = shotBase ? `${shotBase}/${NAMESPACE}/shot?url=${encodeURIComponent(page)}&w=${viewport.width}&h=${viewport.height}` : page;

  if (env.REVIEW_AUDIT) {
    // Key includes the viewport so desktop + mobile of the same page don't collide in R2.
    const fingerprint = await sha256Hex(`${target.headSha ?? target.prNumber}:${slot}:${viewportName}:${page}`);
    const key = `${NAMESPACE}/shots/${fingerprint.slice(0, 40)}.png`;
    const url = shotBase ? `${shotBase}/${NAMESPACE}/shot?key=${encodeURIComponent(key)}` : onDemand;
    const cached = await env.REVIEW_AUDIT.get(key).catch(() => null);
    if (cached) return { url };
    const { png, authWalled } = await captureShot(env, page, viewport).catch(() => ({ png: null, authWalled: false }));
    // A protected route that redirected to a sign-in wall: show an honest "requires authentication"
    // placeholder rather than caching/serving a screenshot of the login screen.
    if (authWalled) {
      return { url: shotBase ? `${shotBase}/${NAMESPACE}/shot?placeholder=auth` : onDemand };
    }
    if (png) {
      await env.REVIEW_AUDIT.put(key, png, { httpMetadata: { contentType: "image/png" } }).catch(() => undefined);
      return { url };
    }
  }
  return { url: onDemand };
}

/**
 * Build the before/after capture for a PR: resolve the preview URL, derive routes from the changed UI files,
 * render desktop + mobile before/after for each route, and return the route URL set (for the visual-preview
 * collapsible). Fully fail-safe — a missing preview / failed render degrades to placeholders or dashes; this
 * NEVER throws (the caller also wraps it in try/catch so a capture failure can't sink a review).
 */
export async function buildCapture(env: Env, token: string, target: CaptureTarget, visualFiles: string[]): Promise<CaptureResult> {
  const repo = parseRepo(target.repoFullName);
  const apiVersion = "2022-11-28";
  // before = production (PUBLIC_SITE_ORIGIN, e.g. https://gittensory.aethereal.dev).
  const prodBase = env.PUBLIC_SITE_ORIGIN ?? "";

  // after = the PR's preview deploy. Prefer the URL carried on the target (a deployment_status webhook set
  // it — no extra API call); otherwise look it up from Deployments, then commit checks, then the
  // cloudflare-bot PR comment. The lookups also tell us when the latest deploy FAILED (vs is still building)
  // so we can show a terminal "deploy failed" card instead of a spinner.
  let previewBase = typeof target.previewUrl === "string" ? target.previewUrl : "";
  let previewFailed = target.previewFailed === true;
  let previewPending = false;
  if (!previewBase && !previewFailed) {
    try {
      const status = await getLatestDeploymentStatus({ token, repo, sha: target.headSha, ref: target.headRef, apiVersion });
      previewBase = status.url ?? "";
      previewFailed = status.failed;
    } catch {
      previewBase = "";
    }
    if (!previewBase && !previewFailed && target.previewFromChecks && target.headSha) {
      previewBase = (await findPreviewUrlFromChecks({ token, repo, sha: target.headSha, apiVersion })) ?? "";
      if (!previewBase && target.prNumber) {
        previewBase = (await findPreviewUrlFromPrComments({ token, repo, prNumber: target.prNumber, apiVersion })) ?? "";
      }
      if (!previewBase && target.headSha) {
        const buildState = await getPreviewBuildState({ token, repo, sha: target.headSha, apiVersion });
        if (buildState === "failed") previewFailed = true;
        else if (buildState === "building" || buildState === "succeeded") previewPending = true;
      }
    }
  }

  // With no real "after" shot, the cell shows a placeholder (same aspect ratio as a real shot): a spinner
  // while the preview is still building, or a static "deploy failed" card once it won't come.
  const shotBase = env.PUBLIC_API_ORIGIN;
  const loadingPlaceholder = shotBase ? `${shotBase}/${NAMESPACE}/shot?placeholder=loading` : undefined;
  const failedPlaceholder = shotBase ? `${shotBase}/${NAMESPACE}/shot?placeholder=failed` : undefined;
  const afterPlaceholder = previewFailed ? failedPlaceholder : loadingPlaceholder;

  const routes = mapFilesToRoutes(visualFiles);
  const captureRoutes: CaptureRoute[] = [];
  for (const path of routes) {
    const beforePage = prodBase ? joinUrl(prodBase, path) : "";
    const afterPage = previewBase ? joinUrl(previewBase, path) : "";
    // Render desktop + mobile for each slot in parallel (4 PNGs/route) to bound wall-clock.
    const [beforeShot, beforeMobileShot, afterShot, afterMobileShot] = await Promise.all([
      capturePage(env, target, beforePage, "before", "desktop", DESKTOP_VIEWPORT),
      capturePage(env, target, beforePage, "before", "mobile", MOBILE_VIEWPORT),
      afterPage ? capturePage(env, target, afterPage, "after", "desktop", DESKTOP_VIEWPORT) : Promise.resolve<{ url?: string | undefined }>({ url: afterPlaceholder }),
      afterPage ? capturePage(env, target, afterPage, "after", "mobile", MOBILE_VIEWPORT) : Promise.resolve<{ url?: string | undefined }>({ url: afterPlaceholder }),
    ]);
    captureRoutes.push({
      path,
      beforeUrl: beforeShot.url,
      beforeUrlMobile: beforeMobileShot.url,
      afterUrl: afterShot.url,
      afterUrlMobile: afterMobileShot.url,
    });
  }
  return { routes: captureRoutes, previewPending };
}
