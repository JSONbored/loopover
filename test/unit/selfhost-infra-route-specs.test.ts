import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildOpenApiSpec } from "../../src/openapi/spec";
import { createApp } from "../../src/api/routes";
import { listLiveRouteKeys } from "../../src/openapi/route-inventory";
import { SELFHOST_INFRA_PATHS, SELFHOST_INFRA_ROUTE_KEYS, SELFHOST_INFRA_SPEC_PATHS } from "../../src/openapi/selfhost-infra-route-specs";

// #9750: the self-host entrypoint answers these paths in its own fetch handler, ahead of the Hono app, so
// the route↔spec ratchet cannot see them -- and they were therefore served and undocumented since self-host
// shipped.
//
// Which means SELFHOST_INFRA_PATHS is a hand-written list of paths served in ANOTHER file, and a
// hand-written list that nothing checks is the exact failure mode this repo keeps finding (metagraphed's
// version-sync workflow watched a renamed path and passed for months while doing nothing). So the list is
// read back out of src/server.ts. It is also the only exemption the ratchet grants, which makes this test
// the thing standing between that exemption and becoming a place to hide an unspecced route.

const SERVER_SOURCE = readFileSync("src/server.ts", "utf8");

/**
 * Every path literal the entrypoint compares the request path against.
 *
 * Anchored on `path === "..."` specifically -- the shape every interception in that handler is written in --
 * rather than on any string that looks path-like, so a URL mentioned in a comment or built for an outbound
 * request is never mistaken for a route this process serves.
 */
export function interceptedPaths(source: string): string[] {
  return [...new Set([...source.matchAll(/\bpath === "([^"]+)"/g)].map((match) => match[1]!))].sort();
}

describe("the specced self-host infra set matches what src/server.ts intercepts (#9750)", () => {
  it("finds the interceptions in the real entrypoint", () => {
    // Guards the extractor itself: if the handler is ever rewritten into a form this regex cannot see, the
    // parity assertion below would pass by comparing two empty-ish sets.
    expect(interceptedPaths(SERVER_SOURCE).length).toBeGreaterThanOrEqual(SELFHOST_INFRA_PATHS.length);
  });

  it("declares exactly the paths the entrypoint names", () => {
    expect(interceptedPaths(SERVER_SOURCE)).toEqual([...SELFHOST_INFRA_PATHS].sort());
  });

  it("needs an operation for exactly those the Hono app does NOT serve — computed, not listed", () => {
    // The rule, rather than an exemption list: `/health` and `/v1/github/webhook` drop out because
    // createApp() serves and documents them, the entrypoint merely gets there first (answering one itself,
    // checking the other's path to dedup a delivery before letting the request through). Deriving this from
    // the live app means a route moving into or out of createApp cannot leave this set stale.
    const served = new Set(listLiveRouteKeys(createApp() as never).map((key) => key.slice(key.indexOf(" ") + 1)));
    const needsSpec = interceptedPaths(SERVER_SOURCE).filter((path) => !served.has(path));
    expect(needsSpec.sort()).toEqual([...SELFHOST_INFRA_SPEC_PATHS].sort());
  });

  it("ignores a path-shaped string that is not an interception", () => {
    expect(interceptedPaths('const target = "/v1/not-a-route"; if (path === "/real") {}')).toEqual(["/real"]);
  });

  it("de-duplicates a path the handler tests more than once", () => {
    // `/setup` and `/setup/callback` are each compared in three separate branches (brokered mode, the
    // wizard, the callback), which must not read as three routes.
    expect(interceptedPaths('if (path === "/setup") {} if (path === "/setup") {}')).toEqual(["/setup"]);
  });
});

describe("every intercepted path is documented (#9750)", () => {
  const paths = buildOpenApiSpec().paths as Record<string, Record<string, { tags?: string[]; operationId?: string; responses?: Record<string, unknown> } | undefined>>;

  it("publishes an operation for each one the Hono app does not already serve", () => {
    expect(SELFHOST_INFRA_SPEC_PATHS).not.toContain("/health");
    expect(SELFHOST_INFRA_SPEC_PATHS).not.toContain("/v1/github/webhook");
    for (const path of SELFHOST_INFRA_SPEC_PATHS) {
      expect(paths[path], `${path} is intercepted by src/server.ts but has no operation`).toBeDefined();
    }
    expect(paths["/health"]?.get, "/health stays the app's own operation").toBeDefined();
  });

  it("tags them so they are readable as one surface rather than scattered through the API", () => {
    for (const path of SELFHOST_INFRA_SPEC_PATHS) {
      for (const operation of Object.values(paths[path]!)) {
        if (operation) expect(operation.tags).toEqual(["Self-host infra"]);
      }
    }
  });

  it("declares `[]` security — these answer before any auth the app would run", () => {
    for (const path of SELFHOST_INFRA_SPEC_PATHS) {
      for (const operation of Object.values(paths[path]!)) {
        if (operation) expect((operation as { security?: unknown }).security).toEqual([]);
      }
    }
  });

  it("gives /ready both of the statuses an orchestrator gates on", () => {
    // The whole point of the endpoint: `ok: false` is a 503, not a 200 with a false in the body, so a
    // readiness gate can act on the status line alone.
    expect(Object.keys(paths["/ready"]!.get!.responses!).sort()).toEqual(["200", "503"]);
  });

  it("does not claim a JSON schema for the Prometheus scrape endpoint", () => {
    // /metrics answers text/plain exposition. Publishing a JSON body for it would be a lie a generated
    // client would act on.
    const metrics = paths["/metrics"]!.get!.responses!["200"] as { content?: unknown };
    expect(metrics.content).toBeUndefined();
  });

  it("documents both the header and the form half of the setup wizard", () => {
    expect(paths["/setup"]!.get?.operationId).toBe("getSelfhostSetupWizard");
    expect(paths["/setup"]!.post?.operationId).toBe("postSelfhostSetupWizard");
  });

  it("keeps the ratchet exemption exactly the set it publishes", () => {
    // The exemption list and the operations must be the same thing, or the exemption becomes a place to
    // park a route that is served by nothing at all.
    const published = SELFHOST_INFRA_SPEC_PATHS.flatMap((path) =>
      Object.keys(paths[path]!)
        .filter((method) => ["get", "post", "put", "patch", "delete"].includes(method))
        .map((method) => `${method.toUpperCase()} ${path}`),
    ).sort();
    expect([...SELFHOST_INFRA_ROUTE_KEYS].sort()).toEqual(published);
  });
});
