// The route↔spec ratchet (#9519).
//
// createApp() and buildOpenApiSpec() are two independently hand-maintained lists, and nothing
// compared them until now: `ui:openapi:check` only verifies the committed file matches its own
// generator, and test/unit/openapi.test.ts is a hand-written allowlist of paths that must exist --
// neither can notice a route that exists in the app and nowhere in the document. When this landed,
// 90 live routes had no spec entry, including every ORB management surface (/v1/orb/*,
// /v1/internal/orb/*, fleet config-push, kill-switch, the DLQ admin quartet).
//
// The baseline WAS a ratchet that could only shrink. #9531 drove it to zero and deleted the file;
// what remains is the invariant it was protecting, now enforced absolutely: every live route has an
// operation, and every operation has a live route. There is no longer anywhere to record an
// exception, which is the point -- a new unspecced route fails immediately.
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

  it("describes every live route in the OpenAPI document", () => {
    expect(
      diff.missingFromSpec,
      `These routes exist in createApp() but have no OpenAPI operation. Register them through the ` +
        `seam (src/openapi/define-route.ts) -- there is no baseline to add them to (#9531).`,
    ).toEqual([]);
  });

  it("never publishes an operation for a route the app does not serve", () => {
    // Strictly worse than a missing entry: a generated client compiles a call that 404s at runtime.
    // This direction never had a baseline and caught two invented job routes during #9531 -- an
    // assumption that every internal job had both an enqueue and a `/run` form, which two of them
    // do not.
    expect(
      diff.missingFromApp,
      "These operations are in the OpenAPI document but no live route serves them.",
    ).toEqual([]);
  });

  it("describes a real, non-trivial surface -- so neither direction can pass by describing nothing", () => {
    // Both assertions above are satisfied by two empty lists. This is what makes them mean
    // something.
    expect(listLiveRouteKeys(createApp() as never).length).toBeGreaterThan(200);
    expect(listSpecRouteKeys(buildOpenApiSpec() as never).length).toBeGreaterThan(200);
  });
});
