// The route↔spec ratchet (#9519).
//
// createApp() and buildOpenApiSpec() are two independently hand-maintained lists, and nothing
// compared them until now: `ui:openapi:check` only verifies the committed file matches its own
// generator, and test/unit/openapi.test.ts is a hand-written allowlist of paths that must exist --
// neither can notice a route that exists in the app and nowhere in the document. When this landed,
// 90 live routes had no spec entry, including every ORB management surface (/v1/orb/*,
// /v1/internal/orb/*, fleet config-push, kill-switch, the DLQ admin quartet).
//
// The baseline is a RATCHET, not an allowlist: it may only shrink. A route removed from it can
// never silently come back, and a NEW unspecced route fails immediately rather than joining a
// growing pile. #9531 drives it to zero, at which point the file is deleted and this test keeps
// enforcing the invariant with an empty set.
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { buildOpenApiSpec } from "../../src/openapi/spec";
import {
  diffRoutesAgainstSpec,
  isNonOperationRoute,
  listLiveRouteKeys,
  listSpecRouteKeys,
  normalizeRoutePath,
} from "../../src/openapi/route-inventory";
import baseline from "../../src/openapi/unspecced-routes-baseline.json" with { type: "json" };

const KNOWN_UNSPECCED = new Set<string>(baseline as string[]);

describe("route inventory helpers", () => {
  it("rewrites Hono path params into OpenAPI form", () => {
    expect(normalizeRoutePath("/v1/repos/:owner/:repo/pulls/:number")).toBe("/v1/repos/{owner}/{repo}/pulls/{number}");
    expect(normalizeRoutePath("/health")).toBe("/health");
  });

  it("skips middleware mounts and wildcard catch-alls, which have no OpenAPI operation", () => {
    expect(isNonOperationRoute("ALL", "/mcp")).toBe(true);
    expect(isNonOperationRoute("GET", "/v1/internal/*")).toBe(true);
    expect(isNonOperationRoute("GET", "/health")).toBe(false);
  });

  it("reports both directions of the diff", () => {
    const diff = diffRoutesAgainstSpec(["GET /a", "GET /b"], ["GET /b", "GET /c"]);
    expect(diff.missingFromSpec).toEqual(["GET /a"]);
    expect(diff.missingFromApp).toEqual(["GET /c"]);
  });

  it("reports nothing for identical inventories", () => {
    const diff = diffRoutesAgainstSpec(["GET /a"], ["GET /a"]);
    expect(diff.missingFromSpec).toEqual([]);
    expect(diff.missingFromApp).toEqual([]);
  });

  it("collapses duplicate live registrations of the same method and path", () => {
    // Hono records one entry per registered handler, so a route with middleware chained onto it
    // appears more than once. Counting those separately would inflate the gap and make the
    // baseline unstable against unrelated middleware edits.
    const app = createApp();
    const raw = (app as unknown as { routes: Array<{ method: string; path: string }> }).routes;
    expect(listLiveRouteKeys(app as never).length).toBeLessThan(raw.length);
  });
});

describe("route↔spec ratchet", () => {
  const diff = diffRoutesAgainstSpec(listLiveRouteKeys(createApp() as never), listSpecRouteKeys(buildOpenApiSpec() as never));

  it("describes every live route in the OpenAPI document, except the shrinking known-gap baseline", () => {
    const newlyUnspecced = diff.missingFromSpec.filter((key) => !KNOWN_UNSPECCED.has(key));
    expect(
      newlyUnspecced,
      `These routes exist in createApp() but have no OpenAPI operation. Register them through the spec ` +
        `(see src/openapi/spec.ts) rather than adding them to src/openapi/unspecced-routes-baseline.json -- ` +
        `that file may only shrink (#9531).`,
    ).toEqual([]);
  });

  it("keeps the baseline honest: an entry that is now specced must be removed from it", () => {
    // Without this, the baseline would quietly retain entries for routes someone specced along the
    // way, and the "may only shrink" promise would be unverifiable -- the file would stop
    // describing the real remaining work.
    const stale = [...KNOWN_UNSPECCED].filter((key) => !diff.missingFromSpec.includes(key));
    expect(
      stale,
      `These routes ARE now described in the OpenAPI document but are still listed in ` +
        `src/openapi/unspecced-routes-baseline.json. Delete them from that file.`,
    ).toEqual([]);
  });

  it("never publishes an operation for a route the app does not serve", () => {
    // Strictly worse than a missing entry: a generated client compiles a call that 404s at runtime.
    // No baseline for this one -- it is zero today and must stay zero.
    expect(
      diff.missingFromApp,
      "These operations are in the OpenAPI document but no live route serves them.",
    ).toEqual([]);
  });

  it("has a baseline that only contains real, currently-unspecced routes", () => {
    expect(KNOWN_UNSPECCED.size).toBeGreaterThan(0);
    for (const key of KNOWN_UNSPECCED) {
      expect(key, `baseline entry is not a METHOD /path key`).toMatch(/^(GET|POST|PUT|PATCH|DELETE) \//);
    }
  });
});
