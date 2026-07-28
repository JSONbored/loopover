// Route↔spec inventory (#9519).
//
// The Worker's route table and its OpenAPI spec are two independently hand-maintained lists:
// createApp() registers the routes Hono actually serves, buildOpenApiSpec() registers the paths the
// published document describes, and until now nothing compared them. The measured gap when this
// landed was 91 live routes with no spec entry -- including every ORB management surface -- and no
// check could detect it, because ui:openapi:check only compares the generated file to its own
// generator, and test/unit/openapi.test.ts is a hand-written allowlist that never enumerates the
// app.
//
// This module is the comparison. It is deliberately pure (no fs, no env) so both the ratchet test
// and any future tooling can use it, and so it stays cheap enough to run on every CI job.
import type { Hono } from "hono";

/** A route as either side describes it, normalized to one comparable string. */
export type RouteKey = string;

/** Methods an OpenAPI path item can carry that this repo actually uses. */
const SPEC_METHODS = ["get", "post", "put", "patch", "delete"] as const;

/**
 * Hono writes path params as `:owner`; OpenAPI writes them as `{owner}`. Normalizing to the
 * OpenAPI form (rather than the reverse) keeps the baseline file readable as spec paths.
 *
 * A trailing wildcard (`/v1/foo/*`) has no OpenAPI equivalent at all -- it is a middleware mount or
 * a catch-all, not an operation -- so callers filter those out rather than trying to name them.
 */
export function normalizeRoutePath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

/** True for a Hono entry that is not a documentable operation: middleware registered with `use`,
 *  `app.all(...)` mounts, and wildcard catch-alls. */
export function isNonOperationRoute(method: string, path: string): boolean {
  return method === "ALL" || path.includes("*");
}

/**
 * Every operation the app actually serves, as `METHOD /normalized/path`.
 *
 * Reads Hono's own `routes` array rather than a hand-kept list -- that is the entire point: a route
 * added with `app.get(...)` and forgotten everywhere else still shows up here.
 */
export function listLiveRouteKeys(app: Hono<never>): RouteKey[] {
  const entries = (app as unknown as { routes: Array<{ method: string; path: string }> }).routes;
  const keys = new Set<RouteKey>();
  for (const entry of entries) {
    if (isNonOperationRoute(entry.method, entry.path)) continue;
    keys.add(`${entry.method.toUpperCase()} ${normalizeRoutePath(entry.path)}`);
  }
  return [...keys].sort();
}

/** Every operation the generated OpenAPI document describes, in the same key format. */
export function listSpecRouteKeys(document: { paths?: Record<string, unknown> }): RouteKey[] {
  const keys = new Set<RouteKey>();
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    if (!item || typeof item !== "object") continue;
    for (const method of SPEC_METHODS) {
      if ((item as Record<string, unknown>)[method]) keys.add(`${method.toUpperCase()} ${path}`);
    }
  }
  return [...keys].sort();
}

export type RouteSpecDiff = {
  /** Live routes with no operation in the spec -- the gap the ratchet drives to zero. */
  missingFromSpec: RouteKey[];
  /** Spec operations with no live route. These are worse than a gap: the published document
   *  promises an endpoint that does not exist, so a generated client compiles a call that 404s. */
  missingFromApp: RouteKey[];
};

export function diffRoutesAgainstSpec(liveKeys: readonly RouteKey[], specKeys: readonly RouteKey[]): RouteSpecDiff {
  const live = new Set(liveKeys);
  const spec = new Set(specKeys);
  return {
    missingFromSpec: liveKeys.filter((key) => !spec.has(key)),
    missingFromApp: specKeys.filter((key) => !live.has(key)),
  };
}
