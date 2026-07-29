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
import { SPEC_REGISTRARS, buildOpenApiSpec } from "../../src/openapi/spec";
import { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
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

// #9706: the ratchet compares SETS, so it is structurally blind to a path registered twice -- both
// directions of its diff still balance. @asteasolutions/zod-to-openapi silently keeps the last
// registration, which is how `POST /v1/internal/jobs/backfill-pr-details` came to publish one table's
// operation while a second, more accurate one (declaring the 400 the handler really returns) was
// discarded with nothing anywhere reporting it.
describe("no operation is registered twice (#9706)", () => {
  it("contributes each method+path exactly once", () => {
    const registry = new OpenAPIRegistry();
    for (const register of SPEC_REGISTRARS) register(registry);

    const seen = new Map<string, number>();
    for (const definition of registry.definitions) {
      if (definition.type !== "route") continue;
      const key = `${definition.route.method.toUpperCase()} ${definition.route.path}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    expect([...seen].filter(([, count]) => count > 1).map(([key]) => key)).toEqual([]);
  });

  it("declares every /v1/internal/ operation as bearer-gated", () => {
    // requiresApiToken returns false for this family -- it has its own middleware -- so the legacy
    // fill-in left any entry that did not declare `auth` with no stanza at all.
    const paths = buildOpenApiSpec().paths as Record<string, Record<string, { security?: unknown } | undefined>>;
    const wrong: string[] = [];
    for (const [path, item] of Object.entries(paths)) {
      if (!path.startsWith("/v1/internal/")) continue;
      for (const method of ["get", "post", "put", "patch", "delete"] as const) {
        const operation = item[method];
        if (!operation) continue;
        if (JSON.stringify(operation.security) !== JSON.stringify([{ LoopOverBearer: [] }])) wrong.push(`${method.toUpperCase()} ${path}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

// #9706: the published status has to be the one the handler returns. Every job route enqueues and
// answers 202; the SINGLE_JOBS table published a 200 that was unreachable for all five of them.
describe("job operations publish what their handlers actually return (#9706)", () => {
  const jobOperation = (path: string) => (buildOpenApiSpec().paths as Record<string, { post?: { responses?: Record<string, unknown>; summary?: string } }>)[path]?.post;

  it.each(["rag-index", "regate-pr", "build-contributor-evidence", "build-burden-forecasts", "repair-data-fidelity"])(
    "%s is queued (202), not run (200)",
    (segment) => {
      const operation = jobOperation(`/v1/internal/jobs/${segment}`);
      expect(Object.keys(operation!.responses!)).toContain("202");
      expect(Object.keys(operation!.responses!)).not.toContain("200");
      expect(operation!.summary).toMatch(/^Queue a job to /);
    },
  );

  it("rag-index declares a 404 and NO 400 — an unparseable body becomes {}, it is never rejected", () => {
    const responses = Object.keys(jobOperation("/v1/internal/jobs/rag-index")!.responses!);
    expect(responses).toContain("404");
    expect(responses).not.toContain("400");
  });

  it("regate-pr declares both — it validates its body AND 404s an uninstalled repo", () => {
    const responses = Object.keys(jobOperation("/v1/internal/jobs/regate-pr")!.responses!);
    expect(responses).toEqual(expect.arrayContaining(["400", "404"]));
  });

  it.each([
    "backfill-repo-segment",
    "backfill-repo-segment/run",
    "backfill-pr-details",
    "backfill-pr-details/run",
    "build-contributor-decision-packs/run",
    "refresh-contributor-activity",
    "refresh-contributor-activity/run",
    "generate-review-recap",
    "generate-review-recap/run",
  ])("%s validates its body, so it declares a 400", (segment) => {
    expect(Object.keys(jobOperation(`/v1/internal/jobs/${segment}`)!.responses!)).toContain("400");
  });

  it.each(["refresh-registry", "build-contributor-decision-packs", "generate-signal-snapshots", "rollup-product-usage"])(
    "%s accepts any body, so it must NOT claim a 400",
    (segment) => {
      // The other arm of the per-entry override, and the reason it is per-entry: widening the shared
      // QUEUED constant would have attached a 400 to every one of these.
      expect(Object.keys(jobOperation(`/v1/internal/jobs/${segment}`)!.responses!)).not.toContain("400");
    },
  );
});
