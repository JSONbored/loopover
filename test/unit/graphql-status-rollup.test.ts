import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchLiveCiAggregate,
  fetchLiveCiAggregatePreferGraphQl,
  fetchLiveCiAggregateViaGraphQl,
  isStatusRollupGraphQlEnabled,
} from "../../src/github/backfill";
import { createTestEnv } from "../helpers/d1";

const REPO = "JSONbored/gittensory";
const SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const TOKEN = "test-token";

type Run = { name: string; conclusion?: string | null; status?: string | null; appSlug?: string | null; detailsUrl?: string | null; title?: string | null; summary?: string | null };
type Status = { context: string; state: string; description?: string | null; targetUrl?: string | null };
type Suite = { status: string; appSlug: string };

// GraphQL statusCheckRollup nodes use UPPERCASE enums (SUCCESS/FAILURE/COMPLETED/IN_PROGRESS) — the reducer
// lowercases them, so the fixtures below deliberately use GitHub's real GraphQL casing.
const runNode = (r: Run) => ({ __typename: "CheckRun", name: r.name, conclusion: r.conclusion ?? null, status: r.status ?? null, detailsUrl: r.detailsUrl ?? null, title: r.title ?? null, summary: r.summary ?? null, checkSuite: { app: { slug: r.appSlug ?? null } } });
const statusNode = (s: Status) => ({ __typename: "StatusContext", context: s.context, state: s.state, description: s.description ?? null, targetUrl: s.targetUrl ?? null });

function graphqlBody(opts: { runs?: Run[]; statuses?: Status[]; suites?: Suite[]; hasNextPage?: boolean; object?: unknown } = {}): unknown {
  const object =
    "object" in opts
      ? opts.object
      : {
          statusCheckRollup: { contexts: { nodes: [...(opts.runs ?? []).map(runNode), ...(opts.statuses ?? []).map(statusNode)], pageInfo: { hasNextPage: opts.hasNextPage ?? false } } },
          checkSuites: { nodes: (opts.suites ?? []).map((s) => ({ status: s.status, app: { slug: s.appSlug } })) },
        };
  return { data: { repository: { object } } };
}

// Stub ONLY the GraphQL endpoint; any REST call falling through 404s, proving the rollup path made no REST read.
function stubGraphql(body: unknown, opts: { status?: number } = {}): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    if (input.toString() === "https://api.github.com/graphql") {
      return opts.status && opts.status !== 200 ? new Response("boom", { status: opts.status }) : Response.json(body);
    }
    return new Response("not found", { status: 404 });
  });
}

// The REST equivalent, for the direct REST↔GraphQL equivalence checks. REST enums are lowercase.
function stubRest(opts: { runs?: Run[]; statuses?: Status[]; suites?: Suite[] }): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url.includes("/check-runs")) return Response.json({ check_runs: (opts.runs ?? []).map((r) => ({ id: 1, name: r.name, status: (r.status ?? "").toLowerCase(), conclusion: r.conclusion ? r.conclusion.toLowerCase() : null, details_url: r.detailsUrl ?? null, output: { title: r.title ?? null, summary: r.summary ?? null }, app: { slug: r.appSlug ?? null } })) });
    if (url.includes("/status")) return Response.json({ statuses: (opts.statuses ?? []).map((s) => ({ context: s.context, state: s.state.toLowerCase(), description: s.description ?? null, target_url: s.targetUrl ?? null })) });
    if (url.includes("/check-suites")) return Response.json({ check_suites: (opts.suites ?? []).map((s) => ({ status: s.status.toLowerCase(), app: { slug: s.appSlug } })) });
    return new Response("not found", { status: 404 });
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("isStatusRollupGraphQlEnabled", () => {
  it("is OFF by default and for falsy/absent values, ON for the truthy set", () => {
    expect(isStatusRollupGraphQlEnabled({})).toBe(false);
    expect(isStatusRollupGraphQlEnabled({ GITHUB_STATUS_ROLLUP_GRAPHQL: "" })).toBe(false);
    expect(isStatusRollupGraphQlEnabled({ GITHUB_STATUS_ROLLUP_GRAPHQL: "false" })).toBe(false);
    expect(isStatusRollupGraphQlEnabled({ GITHUB_STATUS_ROLLUP_GRAPHQL: "0" })).toBe(false);
    for (const v of ["1", "true", "yes", "on", "TRUE", "On"]) {
      expect(isStatusRollupGraphQlEnabled({ GITHUB_STATUS_ROLLUP_GRAPHQL: v })).toBe(true);
    }
  });
});

describe("fetchLiveCiAggregateViaGraphQl — verdicts", () => {
  const env = createTestEnv();

  it("returns null (→ REST fallback) on missing headSha, token, or malformed repo", async () => {
    stubGraphql(graphqlBody({ runs: [{ name: "build", conclusion: "SUCCESS", status: "COMPLETED" }] }));
    expect(await fetchLiveCiAggregateViaGraphQl(env, REPO, null, TOKEN)).toBeNull();
    expect(await fetchLiveCiAggregateViaGraphQl(env, REPO, SHA, undefined)).toBeNull();
    expect(await fetchLiveCiAggregateViaGraphQl(env, "no-slash", SHA, TOKEN)).toBeNull();
  });

  it("returns null on a GraphQL error or an unexpected/absent commit (→ REST fallback)", async () => {
    stubGraphql(graphqlBody(), { status: 500 });
    expect(await fetchLiveCiAggregateViaGraphQl(env, REPO, SHA, TOKEN)).toBeNull();
    stubGraphql(graphqlBody({ object: null }));
    expect(await fetchLiveCiAggregateViaGraphQl(env, REPO, SHA, TOKEN)).toBeNull();
  });

  it("returns null when the rollup has >100 contexts (a single page cannot enumerate them)", async () => {
    stubGraphql(graphqlBody({ runs: [{ name: "build", conclusion: "SUCCESS", status: "COMPLETED" }], hasNextPage: true }));
    expect(await fetchLiveCiAggregateViaGraphQl(env, REPO, SHA, TOKEN)).toBeNull();
  });

  it("passes when a required check-run and status are green", async () => {
    stubGraphql(graphqlBody({ runs: [{ name: "build", conclusion: "SUCCESS", status: "COMPLETED", appSlug: "github-actions" }], statuses: [{ context: "codecov/patch", state: "SUCCESS" }], suites: [{ status: "COMPLETED", appSlug: "github-actions" }] }));
    expect(await fetchLiveCiAggregateViaGraphQl(env, REPO, SHA, TOKEN, new Set(["build"]))).toMatchObject({ ciState: "passed", hasPending: false, failingDetails: [] });
  });

  it("fails on a red check-run and surfaces its name/summary", async () => {
    stubGraphql(graphqlBody({ runs: [{ name: "build", conclusion: "FAILURE", status: "COMPLETED", summary: "boom", detailsUrl: "https://ci/build" }] }));
    const agg = await fetchLiveCiAggregateViaGraphQl(env, REPO, SHA, TOKEN, new Set(["build"]));
    expect(agg?.ciState).toBe("failed");
    expect(agg?.failingDetails).toEqual([{ name: "build", summary: "boom", detailsUrl: "https://ci/build" }]);
  });

  it("fails on a red classic status (e.g. codecov) even when not required", async () => {
    stubGraphql(graphqlBody({ statuses: [{ context: "codecov/patch", state: "FAILURE" }] }));
    expect((await fetchLiveCiAggregateViaGraphQl(env, REPO, SHA, TOKEN, new Set(["build"])))?.ciState).toBe("failed");
  });

  it("holds pending on a REQUIRED check still in progress, but PASSES a pending NON-required one", async () => {
    stubGraphql(graphqlBody({ runs: [{ name: "build", conclusion: null, status: "IN_PROGRESS" }] }));
    expect((await fetchLiveCiAggregateViaGraphQl(env, REPO, SHA, TOKEN, new Set(["build"])))?.ciState).toBe("pending");
    stubGraphql(graphqlBody({ runs: [{ name: "flaky-optional", conclusion: null, status: "IN_PROGRESS" }, { name: "build", conclusion: "SUCCESS", status: "COMPLETED" }] }));
    expect(await fetchLiveCiAggregateViaGraphQl(env, REPO, SHA, TOKEN, new Set(["build"]))).toMatchObject({ ciState: "passed", hasPending: true, hasVisiblePending: false });
  });

  it("holds pending when a required context never appears", async () => {
    stubGraphql(graphqlBody({ runs: [{ name: "build", conclusion: "SUCCESS", status: "COMPLETED" }] }));
    expect((await fetchLiveCiAggregateViaGraphQl(env, REPO, SHA, TOKEN, new Set(["build", "e2e"])))?.ciState).toBe("pending");
  });

  it("treats a skipped conclusion as passing", async () => {
    stubGraphql(graphqlBody({ runs: [{ name: "build", conclusion: "SKIPPED", status: "COMPLETED" }], suites: [] }));
    expect((await fetchLiveCiAggregateViaGraphQl(env, REPO, SHA, TOKEN, new Set(["build"])))?.ciState).toBe("passed");
  });

  it("holds pending via the check-suite backstop when a first-party suite has not completed", async () => {
    stubGraphql(graphqlBody({ runs: [{ name: "build", conclusion: "SUCCESS", status: "COMPLETED" }], suites: [{ status: "IN_PROGRESS", appSlug: "github-actions" }] }));
    expect((await fetchLiveCiAggregateViaGraphQl(env, REPO, SHA, TOKEN, new Set(["build"])))?.ciState).toBe("pending");
  });

  it("does not mark suite-only optional pending as required-visible when required contexts are known", async () => {
    stubGraphql(graphqlBody({ runs: [{ name: "build", conclusion: "SUCCESS", status: "COMPLETED" }], suites: [{ status: "IN_PROGRESS", appSlug: "github-actions" }] }));

    expect(await fetchLiveCiAggregateViaGraphQl(env, REPO, SHA, TOKEN, new Set(["build"]))).toMatchObject({
      ciState: "pending",
      hasPending: true,
      hasVisiblePending: false,
    });
  });

  it("defensively defaults every missing field on sparse rollup nodes and suites", async () => {
    // Every optional field absent on each node/suite → exercises the nullish (??) fallbacks in the normalization
    // AND (via the null-valued normalized fields) the reducer's own status/context/state fallbacks.
    stubGraphql({ data: { repository: { object: { statusCheckRollup: { contexts: { nodes: [{ __typename: "CheckRun" }, { __typename: "StatusContext" }] } }, checkSuites: { nodes: [{}] } } } } });
    expect(await fetchLiveCiAggregateViaGraphQl(env, REPO, SHA, TOKEN)).not.toBeNull();
  });

  it("is unverified for a legitimate check-less commit (statusCheckRollup null)", async () => {
    // Real GitHub shape for a commit with no CI: the whole rollup is null (not an empty connection). This is the
    // ONLY empty-input case that must NOT fall back — it is genuinely "no checks".
    stubGraphql({ data: { repository: { object: { statusCheckRollup: null, checkSuites: { nodes: [] } } } } });
    expect((await fetchLiveCiAggregateViaGraphQl(env, REPO, SHA, TOKEN))?.ciState).toBe("unverified");
  });

  it("falls back to REST on a PARTIAL GraphQL response (top-level errors), never normalizing it to empty", async () => {
    // A field resolver failed: statusCheckRollup came back null but the top-level `errors` array is populated. This
    // must NOT be read as "no checks" (which could merge a PR whose CI is actually failing) — return null → REST.
    stubGraphql({ data: { repository: { object: { statusCheckRollup: null, checkSuites: { nodes: [] } } } }, errors: [{ message: "timeout resolving statusCheckRollup" }] });
    expect(await fetchLiveCiAggregateViaGraphQl(env, REPO, SHA, TOKEN)).toBeNull();
  });

  it("falls back when the object is not a resolved Commit (checkSuites connection absent/malformed)", async () => {
    stubGraphql({ data: { repository: { object: { statusCheckRollup: null } } } }); // no checkSuites key
    expect(await fetchLiveCiAggregateViaGraphQl(env, REPO, SHA, TOKEN)).toBeNull();
    stubGraphql({ data: { repository: { object: { statusCheckRollup: null, checkSuites: {} } } } }); // checkSuites.nodes not an array
    expect(await fetchLiveCiAggregateViaGraphQl(env, REPO, SHA, TOKEN)).toBeNull();
  });

  it("falls back when a NON-null statusCheckRollup carries a malformed contexts connection", async () => {
    stubGraphql({ data: { repository: { object: { statusCheckRollup: { contexts: {} }, checkSuites: { nodes: [] } } } } }); // contexts.nodes not an array
    expect(await fetchLiveCiAggregateViaGraphQl(env, REPO, SHA, TOKEN)).toBeNull();
  });

  it("(REST) defaults a check-runs/status response that omits its array", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/check-runs") || url.includes("/status") || url.includes("/check-suites")) return Response.json({});
      return new Response("not found", { status: 404 });
    });
    expect((await fetchLiveCiAggregate(env, REPO, SHA, TOKEN))?.ciState).toBe("unverified");
  });

  it("ignores rollup nodes that are neither CheckRun nor StatusContext", async () => {
    stubGraphql({ data: { repository: { object: { statusCheckRollup: { contexts: { nodes: [runNode({ name: "build", conclusion: "SUCCESS", status: "COMPLETED" }), { __typename: "Unknown" }], pageInfo: { hasNextPage: false } } }, checkSuites: { nodes: [] } } } } });
    expect((await fetchLiveCiAggregateViaGraphQl(env, REPO, SHA, TOKEN, new Set(["build"])))?.ciState).toBe("passed");
  });

  it("is unverified when the commit has no checks at all", async () => {
    stubGraphql(graphqlBody({ runs: [], statuses: [], suites: [] }));
    expect((await fetchLiveCiAggregateViaGraphQl(env, REPO, SHA, TOKEN, new Set(["build"])))?.ciState).toBe("pending"); // required 'build' absent → pending
    stubGraphql(graphqlBody({ runs: [], statuses: [], suites: [] }));
    expect((await fetchLiveCiAggregateViaGraphQl(env, REPO, SHA, TOKEN))?.ciState).toBe("unverified"); // fold-all, nothing seen
  });
});

describe("fetchLiveCiAggregateViaGraphQl — equivalence with the REST path", () => {
  const env = createTestEnv();
  const scenarios: Array<{ name: string; runs?: Run[]; statuses?: Status[]; suites?: Suite[]; required?: string[] }> = [
    { name: "all green", runs: [{ name: "build", conclusion: "SUCCESS", status: "COMPLETED", appSlug: "github-actions" }], statuses: [{ context: "codecov/patch", state: "SUCCESS" }], suites: [{ status: "COMPLETED", appSlug: "github-actions" }], required: ["build"] },
    { name: "failed check", runs: [{ name: "build", conclusion: "FAILURE", status: "COMPLETED", summary: "nope", detailsUrl: "https://x" }], required: ["build"] },
    { name: "failed status", statuses: [{ context: "codecov/patch", state: "ERROR", description: "coverage drop" }], required: ["build"] },
    { name: "pending required", runs: [{ name: "build", conclusion: null, status: "QUEUED" }], required: ["build"] },
    { name: "pending non-required passes", runs: [{ name: "opt", conclusion: null, status: "IN_PROGRESS" }, { name: "build", conclusion: "SUCCESS", status: "COMPLETED" }], required: ["build"] },
    { name: "missing required", runs: [{ name: "build", conclusion: "SUCCESS", status: "COMPLETED" }], required: ["build", "e2e"] },
    { name: "suite in progress", runs: [{ name: "build", conclusion: "SUCCESS", status: "COMPLETED" }], suites: [{ status: "IN_PROGRESS", appSlug: "github-actions" }], required: ["build"] },
  ];

  for (const s of scenarios) {
    it(`matches REST for: ${s.name}`, async () => {
      const required = s.required ? new Set(s.required) : undefined;
      stubRest({ runs: s.runs ?? [], statuses: s.statuses ?? [], suites: s.suites ?? [] });
      const rest = await fetchLiveCiAggregate(env, REPO, SHA, TOKEN, required);
      stubGraphql(graphqlBody({ runs: s.runs ?? [], statuses: s.statuses ?? [], suites: s.suites ?? [] }));
      const graphql = await fetchLiveCiAggregateViaGraphQl(env, REPO, SHA, TOKEN, required);
      expect(graphql).toEqual(rest);
    });
  }
});

describe("fetchLiveCiAggregatePreferGraphQl — flag routing + fallback", () => {
  it("uses the REST aggregate when the flag is OFF (never issues a GraphQL query)", async () => {
    const env = createTestEnv();
    stubRest({ runs: [{ name: "build", conclusion: "FAILURE", status: "COMPLETED" }], statuses: [], suites: [] });
    expect((await fetchLiveCiAggregatePreferGraphQl(env, REPO, SHA, TOKEN, new Set(["build"]))).ciState).toBe("failed");
  });

  it("uses the GraphQL rollup when the flag is ON and the query succeeds", async () => {
    const env = createTestEnv({ GITHUB_STATUS_ROLLUP_GRAPHQL: "true" });
    stubGraphql(graphqlBody({ runs: [{ name: "build", conclusion: "SUCCESS", status: "COMPLETED" }], suites: [{ status: "COMPLETED", appSlug: "github-actions" }] }));
    expect((await fetchLiveCiAggregatePreferGraphQl(env, REPO, SHA, TOKEN, new Set(["build"]))).ciState).toBe("passed");
  });

  it("falls back to REST when the flag is ON but the GraphQL rollup returns null (e.g. >100 contexts)", async () => {
    const env = createTestEnv({ GITHUB_STATUS_ROLLUP_GRAPHQL: "true" });
    // Both endpoints stubbed: GraphQL says hasNextPage (→null), so the aggregate must come from the REST reads.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.github.com/graphql") return Response.json(graphqlBody({ runs: [{ name: "build", conclusion: "SUCCESS", status: "COMPLETED" }], hasNextPage: true }));
      if (url.includes("/check-runs")) return Response.json({ check_runs: [{ id: 1, name: "build", status: "completed", conclusion: "failure" }] });
      if (url.includes("/status")) return Response.json({ statuses: [] });
      if (url.includes("/check-suites")) return Response.json({ check_suites: [] });
      return new Response("not found", { status: 404 });
    });
    // REST sees a FAILURE → 'failed', proving the fallback path ran rather than the GraphQL SUCCESS.
    expect((await fetchLiveCiAggregatePreferGraphQl(env, REPO, SHA, TOKEN, new Set(["build"]))).ciState).toBe("failed");
  });
});
