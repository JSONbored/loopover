import { describe, expect, it, vi } from "vitest";
import { buildGatePrecisionReport, buildGatePrecisionSignals, loadGatePrecisionReport } from "../../src/services/gate-precision";
import type { GatePrecisionPerType } from "../../src/services/gate-precision";
import {
  recordGateBlockOutcome,
  markGateOutcomeOverridden,
  listGateOutcomes,
  upsertPullRequestFromGitHub,
} from "../../src/db/repositories";
import type { GateOutcomeRecord, PullRequestRecord } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

// A recorded gate block for one PR, citing the given blocker codes.
function block(pullNumber: number, blockerCodes: string[], overridden = false): GateOutcomeRecord {
  return { repoFullName: "owner/repo", pullNumber, blockerCodes, overridden };
}

// A resolved PR: `merged` → has a merge timestamp (a false positive when it was also blocked); otherwise
// closed-unmerged (the block held). `open` PRs have no terminal outcome yet. `authorLogin` is optional
// (#4520 cohort-split tests only) — omitted matches every pre-existing call site exactly.
function pr(number: number, outcome: "merged" | "closed" | "open", authorLogin?: string): PullRequestRecord {
  return {
    repoFullName: "owner/repo",
    number,
    title: `PR ${number}`,
    state: outcome === "open" ? "open" : "closed",
    mergedAt: outcome === "merged" ? "2026-06-01T00:00:00.000Z" : null,
    labels: [],
    linkedIssues: [],
    ...(authorLogin !== undefined ? { authorLogin } : {}),
  };
}

// n blocks citing one code, `merged` of them on PRs that later merged (false positives); plus the matching PRs.
function scenario(code: string, n: number, merged: number, base: number): { blocks: GateOutcomeRecord[]; prs: PullRequestRecord[] } {
  const blocks: GateOutcomeRecord[] = [];
  const prs: PullRequestRecord[] = [];
  for (let i = 0; i < n; i += 1) {
    const num = base + i;
    blocks.push(block(num, [code]));
    prs.push(pr(num, i < merged ? "merged" : "closed"));
  }
  return { blocks, prs };
}

describe("buildGatePrecisionReport", () => {
  it("counts a blocked-then-merged PR as a per-gate-type false positive and computes the rate", () => {
    // missing_linked_issue: 6 blocks, 2 merged anyway → 2/6 false positive. slop_risk: 5 blocks, 0 merged → 0.
    const a = scenario("missing_linked_issue", 6, 2, 0);
    const b = scenario("slop_risk", 5, 0, 100);
    const report = buildGatePrecisionReport([...a.blocks, ...b.blocks], [...a.prs, ...b.prs]);
    const byType = Object.fromEntries(report.perGateType.map((t) => [t.gateType, t]));
    expect(byType.missing_linked_issue).toMatchObject({ blocked: 6, blockedThenMerged: 2, falsePositiveRate: 0.333 });
    expect(byType.slop_risk).toMatchObject({ blocked: 5, blockedThenMerged: 0, falsePositiveRate: 0 });
    expect(report.overall).toMatchObject({ blocked: 11, blockedThenMerged: 2, falsePositiveRate: 0.182 });
  });

  it("attributes a multi-code block to every cited gate type", () => {
    // One block citing two codes on a merged PR → both codes get a false positive.
    const report = buildGatePrecisionReport([block(1, ["missing_linked_issue", "slop_risk"])], [pr(1, "merged")]);
    const byType = Object.fromEntries(report.perGateType.map((t) => [t.gateType, t]));
    expect(byType.missing_linked_issue).toMatchObject({ blocked: 1, blockedThenMerged: 1 });
    expect(byType.slop_risk).toMatchObject({ blocked: 1, blockedThenMerged: 1 });
    expect(report.overall.blocked).toBe(1); // a multi-code block is ONE blocked PR overall
  });

  it("returns a null rate per type below the min sample", () => {
    const report = buildGatePrecisionReport([block(1, ["x"]), block(2, ["x"])], [pr(1, "merged"), pr(2, "merged")]);
    expect(report.perGateType[0]).toMatchObject({ gateType: "x", blocked: 2, blockedThenMerged: 2, falsePositiveRate: null });
    expect(report.overall.falsePositiveRate).toBeNull();
  });

  it("excludes still-open PRs and blocks with no matching PR from the false-positive count", () => {
    const blocks = [block(1, ["x"]), block(2, ["x"]), block(3, ["x"]), block(4, ["x"]), block(5, ["x"])];
    // pr 1 merged (false positive); pr 2 closed (held); pr 3 open (no outcome); pr 4 missing entirely; pr 5 merged.
    const prs = [pr(1, "merged"), pr(2, "closed"), pr(3, "open"), pr(5, "merged")];
    const report = buildGatePrecisionReport(blocks, prs);
    expect(report.overall).toMatchObject({ blocked: 5, blockedThenMerged: 2 }); // only the two merged ones
  });

  it("tracks overridden blocks separately as the strongest false-positive signal", () => {
    const report = buildGatePrecisionReport([block(1, ["x"], true), block(2, ["x"], false)], [pr(1, "merged"), pr(2, "merged")]);
    expect(report.perGateType[0]).toMatchObject({ blocked: 2, overridden: 1 });
  });

  it("carries no actor login or trust/reward fields (privacy)", () => {
    const report = buildGatePrecisionReport([block(1, ["x"])], [pr(1, "merged")]);
    expect(JSON.stringify(report)).not.toMatch(/login|actor|reward|payout|trust|wallet|hotkey|credibility/i);
  });

  it("scopes to options.repoFullName — ignores blocks and PRs from other repos", () => {
    const own = { repoFullName: "owner/repo", pullNumber: 1, blockerCodes: ["x"], overridden: false };
    const other = { repoFullName: "other/repo", pullNumber: 2, blockerCodes: ["x"], overridden: false };
    const otherPr: PullRequestRecord = { repoFullName: "other/repo", number: 2, title: "PR 2", state: "closed", mergedAt: "2026-06-01T00:00:00.000Z", labels: [], linkedIssues: [] };
    // A PR with a null repoFullName exercises sameRepo's nullish-coalesce guard.
    const nullRepoPr: PullRequestRecord = { repoFullName: null as unknown as string, number: 3, title: "PR 3", state: "closed", mergedAt: null, labels: [], linkedIssues: [] };
    const report = buildGatePrecisionReport([own, other], [pr(1, "merged"), otherPr, nullRepoPr], { repoFullName: "owner/repo" });
    // Only owner/repo's single block counts; other/repo's block + merged PR (and the null-repo PR) are filtered out.
    expect(report.overall).toMatchObject({ blocked: 1, blockedThenMerged: 1 });
  });
});

// #4520: additive miner-vs-human split, only computed when options.minerLogins is supplied. Reuses the SAME
// blocked/blockedThenMerged/overridden fold every existing test above already exercises for the blended
// report — these tests only pin the NEW split behavior, not the fold itself.
describe("buildGatePrecisionReport cohort split (#4520)", () => {
  it("is absent from the report when minerLogins is not supplied (byte-identical to before the split existed)", () => {
    const report = buildGatePrecisionReport([block(1, ["x"])], [pr(1, "merged", "some-miner")]);
    expect(report.cohorts).toBeUndefined();
  });

  it("splits blocked/blockedThenMerged/overridden between miner and human authors, each independently below/above MIN_SAMPLE", () => {
    const minerLogins = new Set(["miner-alice"]);
    // Miner: 2 blocks, 1 merged (below MIN_SAMPLE=5 -> null rate). Human: 6 blocks, 3 merged (>= 5 -> real rate).
    const blocks = [
      block(1, ["x"]), block(2, ["x"]),
      block(10, ["x"]), block(11, ["x"]), block(12, ["x"], true), block(13, ["x"]), block(14, ["x"]), block(15, ["x"]),
    ];
    const prs = [
      pr(1, "merged", "miner-alice"), pr(2, "closed", "miner-alice"),
      pr(10, "merged", "human-bob"), pr(11, "merged", "human-bob"), pr(12, "merged", "human-bob"),
      pr(13, "closed", "human-bob"), pr(14, "closed", "human-bob"), pr(15, "closed", "human-bob"),
    ];
    const report = buildGatePrecisionReport(blocks, prs, { minerLogins });
    expect(report.cohorts?.miner.overall).toMatchObject({ blocked: 2, blockedThenMerged: 1, falsePositiveRate: null });
    expect(report.cohorts?.human.overall).toMatchObject({ blocked: 6, blockedThenMerged: 3, falsePositiveRate: 0.5 });
    expect(report.cohorts?.human.perGateType[0]).toMatchObject({ overridden: 1 });
    // The blended totals are UNCHANGED by the split -- miner + human always reconciles to overall.
    expect(report.overall).toMatchObject({ blocked: 8, blockedThenMerged: 4 });
  });

  it("classifies an unresolvable author (no PR record, or no authorLogin) as human -- never over-classifies as miner", () => {
    const minerLogins = new Set(["miner-alice"]);
    // pr 1: authorLogin present but blank; pr 2: no matching PR record at all (block cites pullNumber 3).
    const blocks = [block(1, ["x"]), block(3, ["x"])];
    const prs = [pr(1, "merged", "")];
    const report = buildGatePrecisionReport(blocks, prs, { minerLogins });
    expect(report.cohorts?.miner.overall.blocked).toBe(0);
    expect(report.cohorts?.human.overall.blocked).toBe(2);
  });

  it("is case-insensitive when matching a PR author against minerLogins", () => {
    const minerLogins = new Set(["miner-alice"]);
    const report = buildGatePrecisionReport([block(1, ["x"])], [pr(1, "merged", "Miner-Alice")], { minerLogins });
    expect(report.cohorts?.miner.overall.blocked).toBe(1);
    expect(report.cohorts?.human.overall.blocked).toBe(0);
  });

  it("carries no actor login in the cohort split either (privacy — only aggregate counts)", () => {
    const report = buildGatePrecisionReport([block(1, ["x"])], [pr(1, "merged", "miner-alice")], { minerLogins: new Set(["miner-alice"]) });
    expect(JSON.stringify(report.cohorts)).not.toMatch(/miner-alice|login|actor/i);
  });
});

describe("buildGatePrecisionSignals", () => {
  const type = (gateType: string, blocked: number, blockedThenMerged: number, falsePositiveRate: number | null, overridden = 0): GatePrecisionPerType => ({
    gateType,
    blocked,
    blockedThenMerged,
    overridden,
    falsePositiveRate,
  });

  it("notes insufficient data below the min blocked sample", () => {
    expect(buildGatePrecisionSignals([], 2, 1).join(" ")).toMatch(/Not enough recorded gate blocks/i);
  });

  it("reports the overall rate and the worst false-positive gate to keep advisory", () => {
    const out = buildGatePrecisionSignals(
      [type("missing_linked_issue", 6, 3, 0.5), type("slop_risk", 5, 0, 0)],
      11,
      3,
    ).join(" ");
    expect(out).toMatch(/false-positive rate/i);
    expect(out).toMatch(/missing_linked_issue/);
    expect(out).toMatch(/Keep it advisory/i);
  });

  it("says no gate is producing false positives when every sampled rate is zero", () => {
    expect(buildGatePrecisionSignals([type("x", 6, 0, 0)], 6, 0).join(" ")).toMatch(/staying blocked/i);
  });
});

describe("loadGatePrecisionReport (env loader)", () => {
  it("loads a repo's gate-block ledger + PRs and assembles the report; upsert/override flow round-trips", async () => {
    const env = createTestEnv();
    // A blocked PR that later merged → false positive. Re-block the SAME PR: upsert keeps ONE row.
    await recordGateBlockOutcome(env, { repoFullName: "owner/repo", pullNumber: 1, headSha: "sha1", blockerCodes: ["slop_risk"] });
    await recordGateBlockOutcome(env, { repoFullName: "owner/repo", pullNumber: 1, headSha: "sha2", blockerCodes: ["missing_linked_issue", "slop_risk"] });
    await markGateOutcomeOverridden(env, "owner/repo", 1);
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 1, title: "merged", state: "closed", user: { login: "alice" }, merged_at: "2026-06-01T00:00:00.000Z" });
    // A blocked PR that stayed closed → not a false positive.
    await recordGateBlockOutcome(env, { repoFullName: "owner/repo", pullNumber: 2, headSha: "sha3", blockerCodes: ["slop_risk"] });
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 2, title: "closed", state: "closed", user: { login: "bob" } });

    const rows = await listGateOutcomes(env, { repoFullName: "owner/repo" });
    expect(rows).toHaveLength(2); // PR 1 upserted to one row, not duplicated
    const pr1 = rows.find((row) => row.pullNumber === 1)!;
    expect(pr1).toMatchObject({ headSha: "sha2", overridden: true });
    expect(pr1.blockerCodes).toEqual(["missing_linked_issue", "slop_risk"]); // latest codes won

    const report = await loadGatePrecisionReport(env, "owner/repo");
    expect(report.repoFullName).toBe("owner/repo");
    const byType = Object.fromEntries(report.perGateType.map((t) => [t.gateType, t]));
    expect(byType.slop_risk).toMatchObject({ blocked: 2, blockedThenMerged: 1, overridden: 1 }); // PR1 (merged+overridden) + PR2 (closed)
    expect(byType.missing_linked_issue).toMatchObject({ blocked: 1, blockedThenMerged: 1, overridden: 1 });
    expect(report.overall).toMatchObject({ blocked: 2, blockedThenMerged: 1 });
    expect(report.signals.length).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toMatch(/reward|payout|trust score|wallet|hotkey|login|actor/i);
  });

  it("preserves overridden across a SAME-head re-block (a re-block on the same commit keeps the override)", async () => {
    const env = createTestEnv();
    await recordGateBlockOutcome(env, { repoFullName: "owner/repo", pullNumber: 5, headSha: "sha-a", blockerCodes: ["x"] });
    await markGateOutcomeOverridden(env, "owner/repo", 5);
    await recordGateBlockOutcome(env, { repoFullName: "owner/repo", pullNumber: 5, headSha: "sha-a", blockerCodes: ["x", "y"] });
    const [row] = await listGateOutcomes(env, { repoFullName: "owner/repo" });
    expect(row).toMatchObject({ overridden: true });
    expect(row!.blockerCodes).toEqual(["x", "y"]);
  });

  it("preserves overridden across a re-block when neither block records a head SHA (null-safe IS)", async () => {
    const env = createTestEnv();
    await recordGateBlockOutcome(env, { repoFullName: "owner/repo", pullNumber: 6, blockerCodes: ["x"] });
    await markGateOutcomeOverridden(env, "owner/repo", 6);
    await recordGateBlockOutcome(env, { repoFullName: "owner/repo", pullNumber: 6, blockerCodes: ["x", "y"] });
    const [row] = await listGateOutcomes(env, { repoFullName: "owner/repo" });
    expect(row).toMatchObject({ overridden: true });
  });

  it("CLEARS overridden when a NEW commit re-blocks (an override binds to the commit it was granted on, #audit-3.14)", async () => {
    const env = createTestEnv();
    await recordGateBlockOutcome(env, { repoFullName: "owner/repo", pullNumber: 7, headSha: "sha-old", blockerCodes: ["x"] });
    await markGateOutcomeOverridden(env, "owner/repo", 7);
    // The contributor pushes a new commit; the gate re-blocks on the new head → the prior override must NOT carry over.
    await recordGateBlockOutcome(env, { repoFullName: "owner/repo", pullNumber: 7, headSha: "sha-new", blockerCodes: ["x"] });
    const [row] = await listGateOutcomes(env, { repoFullName: "owner/repo" });
    expect(row).toMatchObject({ headSha: "sha-new", overridden: false });
  });

  it("markGateOutcomeOverridden is a no-op when no block was recorded", async () => {
    const env = createTestEnv();
    await markGateOutcomeOverridden(env, "owner/repo", 99); // must not throw
    expect(await listGateOutcomes(env, { repoFullName: "owner/repo" })).toHaveLength(0);
  });

  it("listGateOutcomes honors the windowDays/now/limit options and an unscoped (no-repo) listing", async () => {
    const env = createTestEnv();
    await recordGateBlockOutcome(env, { repoFullName: "owner/repo", pullNumber: 7, blockerCodes: ["x"] });
    // windowDays + an explicit `now` (exercises the provided-now branch) + an explicit limit.
    const windowed = await listGateOutcomes(env, { repoFullName: "owner/repo", windowDays: 7, now: "2026-06-17T00:00:00.000Z", limit: 10 });
    expect(windowed).toHaveLength(1);
    // No repoFullName → unscoped listing (exercises the absent-repo branch + the empty-conditions path).
    expect(await listGateOutcomes(env, {})).toHaveLength(1);
  });

  // #4520: includeCohorts fetches the full miner login set ONCE (not omitted) and threads it through.
  it("includeCohorts fetches the miner login set once and produces a miner-vs-human split", async () => {
    const env = createTestEnv();
    await recordGateBlockOutcome(env, { repoFullName: "owner/repo", pullNumber: 1, blockerCodes: ["slop_risk"] });
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 1, title: "merged", state: "closed", user: { login: "miner-alice" }, merged_at: "2026-06-01T00:00:00.000Z" });
    await recordGateBlockOutcome(env, { repoFullName: "owner/repo", pullNumber: 2, blockerCodes: ["slop_risk"] });
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 2, title: "closed", state: "closed", user: { login: "human-bob" } });
    let minersCalls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") {
        minersCalls += 1;
        return Response.json([{ uid: 1, githubUsername: "miner-alice", githubId: "1" }]);
      }
      return new Response("not found", { status: 404 });
    });

    const withoutCohorts = await loadGatePrecisionReport(env, "owner/repo");
    expect(withoutCohorts.cohorts).toBeUndefined();
    expect(minersCalls).toBe(0); // opt-in only -- the default path never spends the extra Gittensor API call

    const withCohorts = await loadGatePrecisionReport(env, "owner/repo", { includeCohorts: true });
    expect(minersCalls).toBe(1);
    expect(withCohorts.cohorts?.miner.overall).toMatchObject({ blocked: 1, blockedThenMerged: 1 });
    expect(withCohorts.cohorts?.human.overall).toMatchObject({ blocked: 1, blockedThenMerged: 0 });
    vi.unstubAllGlobals();
  });

  it("includeCohorts degrades to an EMPTY miner set (every author reads as human) when the Gittensor API call fails", async () => {
    const env = createTestEnv();
    await recordGateBlockOutcome(env, { repoFullName: "owner/repo", pullNumber: 1, blockerCodes: ["x"] });
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 1, title: "merged", state: "closed", user: { login: "miner-alice" }, merged_at: "2026-06-01T00:00:00.000Z" });
    vi.stubGlobal("fetch", async () => new Response("service unavailable", { status: 503 }));

    const report = await loadGatePrecisionReport(env, "owner/repo", { includeCohorts: true });
    expect(report.cohorts?.miner.overall.blocked).toBe(0);
    expect(report.cohorts?.human.overall.blocked).toBe(1);
    vi.unstubAllGlobals();
  });
});
