import { describe, expect, it, vi } from "vitest";
import { reputationOutcomeFromTerminalState, runAiReviewForAdvisory } from "../../src/queue/processors";
import {
  isReputationEnabled,
  recordReputationOutcome,
  shouldDowngradeToDeterministic,
  shouldSkipAiForReputation,
} from "../../src/review/reputation-wire";
import { getSubmitterReputation, recordSubmissionOutcome } from "../../src/review/submitter-reputation";
import { evaluateGateCheck } from "../../src/rules/advisory";
import type { Advisory, RepositorySettings } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

// A submitter who FLOODED the project with submissions but landed almost none — the burst anti-abuse pattern.
async function seedSubmitter(
  env: Env,
  args: { project: string; submitter: string; submissions: number; merged: number; closed: number; manual: number },
) {
  await env.DB.prepare(
    "INSERT INTO submitter_stats (project, submitter, submissions, merged, closed, manual, last_seen) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
  )
    .bind(args.project, args.submitter, args.submissions, args.merged, args.closed, args.manual)
    .run();
}

function aiEnv(over: Partial<Env> = {}) {
  const run = vi.fn(async () => ({
    response: JSON.stringify({ assessment: "Looks fine.", suggestions: ["Add a test."], risks: [], criticalDefect: { present: false, confidence: 0, title: "", detail: "" } }),
  }));
  const env = createTestEnv({ AI: { run } as unknown as Ai, AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true", AI_DAILY_NEURON_BUDGET: "100000", ...over });
  return { env, run };
}

function advisory(over: Partial<Advisory> = {}): Advisory {
  return {
    id: "adv-1",
    targetType: "pull_request",
    targetKey: "acme/widgets#3",
    repoFullName: "acme/widgets",
    pullNumber: 3,
    headSha: "sha3",
    conclusion: "neutral",
    severity: "info",
    title: "Gittensory advisory available",
    summary: "ok",
    findings: [],
    generatedAt: "2026-06-20T00:00:00.000Z",
    ...over,
  };
}

const pr = { number: 3, title: "Add helper", body: "Adds a helper." };
const baseArgs = { settings: { aiReviewMode: "advisory" } as RepositorySettings, repoFullName: "acme/widgets", pr, author: "burster", confirmedContributor: true };

describe("isReputationEnabled", () => {
  it("is OFF for unset/false and ON for the truthy convention", () => {
    expect(isReputationEnabled({})).toBe(false);
    expect(isReputationEnabled({ GITTENSORY_REVIEW_REPUTATION: "false" })).toBe(false);
    expect(isReputationEnabled({ GITTENSORY_REVIEW_REPUTATION: "true" })).toBe(true);
    expect(isReputationEnabled({ GITTENSORY_REVIEW_REPUTATION: "1" })).toBe(true);
    expect(isReputationEnabled({ GITTENSORY_REVIEW_REPUTATION: "on" })).toBe(true);
  });
});

describe("shouldDowngradeToDeterministic (pure)", () => {
  it("downgrades a 'low' windowed signal, a burst submitter; never a healthy or sparse one", () => {
    // windowed signal is the primary, live-once-review_targets-lands trigger.
    expect(shouldDowngradeToDeterministic({ submissions: 0, merged: 0, closed: 0, manual: 0, closeRate: 0, signal: "low" })).toBe(true);
    // burst: many submissions, ~none merged.
    expect(shouldDowngradeToDeterministic({ submissions: 12, merged: 0, closed: 12, manual: 0, closeRate: 1, signal: "neutral" })).toBe(true);
    // healthy high-volume contributor (lots merged) → never downgraded.
    expect(shouldDowngradeToDeterministic({ submissions: 20, merged: 18, closed: 2, manual: 0, closeRate: 0.1, signal: "neutral" })).toBe(false);
    // sparse newcomer (below the burst floor) → never downgraded on the aggregate alone.
    expect(shouldDowngradeToDeterministic({ submissions: 3, merged: 0, closed: 3, manual: 0, closeRate: 1, signal: "neutral" })).toBe(false);
    // trusted → never downgraded.
    expect(shouldDowngradeToDeterministic({ submissions: 10, merged: 10, closed: 0, manual: 0, closeRate: 0, signal: "trusted" })).toBe(false);
  });
});

describe("AI-spend gate: reputation downgrade", () => {
  it("FLAG-ON: a low-reputation / burst submitter is downgraded to deterministic-only (no AI spend)", async () => {
    const { env, run } = aiEnv({ GITTENSORY_REVIEW_REPUTATION: "true" });
    await seedSubmitter(env, { project: "acme/widgets", submitter: "burster", submissions: 12, merged: 0, closed: 12, manual: 0 });
    const adv = advisory();
    const result = await runAiReviewForAdvisory(env, { ...baseArgs, advisory: adv });
    // Downgraded: no notes, no finding, and the (paid) AI neurons were never called.
    expect(result).toBeUndefined();
    expect(adv.findings).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it("FLAG-ON: aiReviewAllAuthors bypasses the reputation downgrade and still runs the review", async () => {
    const { env, run } = aiEnv({ GITTENSORY_REVIEW_REPUTATION: "true" });
    await seedSubmitter(env, { project: "acme/widgets", submitter: "burster", submissions: 12, merged: 0, closed: 12, manual: 0 });
    const adv = advisory();
    const result = await runAiReviewForAdvisory(env, {
      ...baseArgs,
      advisory: adv,
      settings: { aiReviewMode: "advisory", aiReviewAllAuthors: true } as RepositorySettings,
    });

    expect(result?.notes).toContain("Add a test.");
    expect(run).toHaveBeenCalled();
  });

  it("FLAG-ON: a good-reputation submitter proceeds to the normal AI review", async () => {
    const { env, run } = aiEnv({ GITTENSORY_REVIEW_REPUTATION: "true" });
    await seedSubmitter(env, { project: "acme/widgets", submitter: "burster", submissions: 20, merged: 18, closed: 2, manual: 0 });
    const adv = advisory();
    const result = await runAiReviewForAdvisory(env, { ...baseArgs, advisory: adv });
    expect(result?.notes).toContain("Add a test.");
    expect(run).toHaveBeenCalled();
  });

  it("FLAG-OFF (default): the AI-spend path is UNCHANGED even for a burst submitter — no reputation read", async () => {
    // Same burst seed as the flag-ON downgrade case, but the flag is OFF: the AI review runs exactly as today.
    const off = aiEnv({ GITTENSORY_REVIEW_REPUTATION: "false" });
    await seedSubmitter(off.env, { project: "acme/widgets", submitter: "burster", submissions: 12, merged: 0, closed: 12, manual: 0 });
    const offResult = await runAiReviewForAdvisory(off.env, { ...baseArgs, advisory: advisory() });
    expect(offResult?.notes).toContain("Add a test.");
    expect(off.run).toHaveBeenCalled();

    // unset behaves identically to explicit-false (the flag-OFF branch is unreachable).
    const unset = aiEnv();
    await seedSubmitter(unset.env, { project: "acme/widgets", submitter: "burster", submissions: 12, merged: 0, closed: 12, manual: 0 });
    const unsetResult = await runAiReviewForAdvisory(unset.env, { ...baseArgs, advisory: advisory() });
    expect(unsetResult?.notes).toContain("Add a test.");
    expect(unset.run).toHaveBeenCalled();
  });
});

describe("shouldSkipAiForReputation (helper)", () => {
  it("FLAG-OFF: returns false immediately without reading the DB (broken DB still yields false)", async () => {
    const env = createTestEnv({ GITTENSORY_REVIEW_REPUTATION: "false", DB: undefined as unknown as D1Database });
    expect(await shouldSkipAiForReputation(env, { project: "acme/widgets", submitter: "burster" })).toBe(false);
  });

  it("FLAG-ON: true for a seeded burst submitter, false for an unseen one", async () => {
    const env = createTestEnv({ GITTENSORY_REVIEW_REPUTATION: "true" });
    await seedSubmitter(env, { project: "acme/widgets", submitter: "burster", submissions: 12, merged: 0, closed: 12, manual: 0 });
    expect(await shouldSkipAiForReputation(env, { project: "acme/widgets", submitter: "burster" })).toBe(true);
    expect(await shouldSkipAiForReputation(env, { project: "acme/widgets", submitter: "newcomer" })).toBe(false);
  });
});

describe("processGitHubWebhook records the reputation outcome on a terminal PR (flag-ON call site)", () => {
  it("FLAG-ON: a closed+merged PR webhook records a 'merged' outcome for the submitter", async () => {
    const { processJob } = await import("../../src/queue/processors");
    const { upsertRepositorySettings } = await import("../../src/db/repositories");
    // GITTENSORY_REVIEW_UNIFIED_COMMENT on so the closing-PR comment path takes the unified-renderer branch.
    const env = createTestEnv({ GITTENSORY_REVIEW_REPUTATION: "true", GITTENSORY_REVIEW_UNIFIED_COMMENT: "true" });
    // Gate enabled so the closing-PR public-surface path (skipped-gate + unified closed comment) executes.
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", gateCheckMode: "enabled" });
    // External calls (token/miner/github) are best-effort + caught; stub them so nothing throws.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      return new Response("not found", { status: 404 });
    });
    try {
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "rep-terminal-merged",
        eventName: "pull_request",
        payload: {
          action: "closed",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } },
          pull_request: {
            number: 4242,
            title: "Terminal merged PR",
            state: "closed",
            merged_at: "2026-06-20T00:00:00.000Z",
            user: { login: "repterminal" },
            head: { sha: "deadbeef" },
            labels: [],
            body: "Resolves the thing.",
          },
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
    // The flag-ON call site recorded the merged outcome (a no read in flag-OFF would leave this empty).
    const stats = await getSubmitterReputation(env, "JSONbored/gittensory", "repterminal");
    expect(stats.submissions).toBe(1);
    expect(stats.merged).toBe(1);
  });

  it("FLAG-ON: a closed PR with no author login records against a null submitter (authorLogin ?? null)", async () => {
    const { processJob } = await import("../../src/queue/processors");
    const env = createTestEnv({ GITTENSORY_REVIEW_REPUTATION: "true" });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      return new Response("not found", { status: 404 });
    });
    try {
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "rep-terminal-closed-noauthor",
        eventName: "pull_request",
        payload: {
          action: "closed",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } },
          // no `user` → authorLogin resolves to null at the call site
          pull_request: { number: 4243, title: "Closed, no author", state: "closed", merged_at: null, head: { sha: "cafef00d" }, labels: [], body: "x" },
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
    // The `submitter: pr.authorLogin ?? null` branch ran; recordSubmissionOutcome no-ops on a null submitter,
    // so nothing is written (and nothing throws) — exercising the null side of the coalesce safely.
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM submitter_stats").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("FLAG-OFF (default): a closed+merged PR webhook records NOTHING — the call site takes the `: undefined` branch (no reputation read)", async () => {
    const { processJob } = await import("../../src/queue/processors");
    // Flag unset → `isReputationEnabled(env) ? … : undefined` is undefined → the `if (reputationOutcome)`
    // body never runs → submitter_stats stays empty (byte-identical to today).
    const env = createTestEnv(); // GITTENSORY_REVIEW_REPUTATION unset → OFF
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      return new Response("not found", { status: 404 });
    });
    try {
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "rep-terminal-merged-flagoff",
        eventName: "pull_request",
        payload: {
          action: "closed",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } },
          pull_request: { number: 4244, title: "Terminal merged, flag OFF", state: "closed", merged_at: "2026-06-20T00:00:00.000Z", user: { login: "repterminal" }, head: { sha: "f00dface" }, labels: [], body: "Resolves it." },
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM submitter_stats").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("FLAG-ON, OPEN PR with a PASSING gate: no terminal/manual outcome → `reputationOutcome` is undefined → the `if (reputationOutcome)` body is skipped (no record)", async () => {
    const { processJob } = await import("../../src/queue/processors");
    const { upsertRepositorySettings } = await import("../../src/db/repositories");
    // Reputation ON, but the PR is still OPEN and the gate does not route it to manual → undefined outcome.
    const env = createTestEnv({ GITTENSORY_REVIEW_REPUTATION: "true" });
    // Gate OFF for this repo so the open PR's gate is `undefined` (not failure/action_required) → no "manual".
    await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", gateCheckMode: "off", publicSurface: "off", commentMode: "off" });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      return new Response("not found", { status: 404 });
    });
    try {
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "rep-open-passing",
        eventName: "pull_request",
        payload: {
          action: "opened",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } },
          pull_request: { number: 4245, title: "Open, passing", state: "open", merged_at: null, user: { login: "repopen" }, head: { sha: "0pen5ha0" }, labels: [], body: "Resolves #1." },
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
    // isReputationEnabled was true (the ternary ran), but reputationOutcomeFromTerminalState returned undefined
    // for an open + non-flagged PR → the `if (reputationOutcome)` guard short-circuits → nothing recorded.
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM submitter_stats").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});

describe("recordReputationOutcome + the 0046 submitter_stats migration", () => {
  it("FLAG-OFF (default): records NOTHING — the table stays empty", async () => {
    const env = createTestEnv({ GITTENSORY_REVIEW_REPUTATION: "false" });
    await recordReputationOutcome(env, { project: "acme/widgets", submitter: "alice", outcome: "closed" });
    // The migration applied (the table exists and is queryable) but nothing was written.
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM submitter_stats").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("FLAG-ON: records the outcome and a round-trip read reflects the counts (migration applied)", async () => {
    const env = createTestEnv({ GITTENSORY_REVIEW_REPUTATION: "true" });
    await recordReputationOutcome(env, { project: "acme/widgets", submitter: "alice", outcome: "merged" });
    await recordReputationOutcome(env, { project: "acme/widgets", submitter: "alice", outcome: "closed" });
    const stats = await getSubmitterReputation(env, "acme/widgets", "alice");
    expect(stats.submissions).toBe(2);
    expect(stats.merged).toBe(1);
    expect(stats.closed).toBe(1);
    expect(stats.closeRate).toBeCloseTo(0.5, 5);
  });

  it("REGRESSION: qualifies submitter_stats counters in the upsert update for Postgres", async () => {
    let preparedSql = "";
    const env = {
      DB: {
        prepare: vi.fn((sql: string) => {
          preparedSql = sql;
          return {
            bind: vi.fn(() => ({
              run: vi.fn(async () => ({})),
            })),
          };
        }),
      },
    } as unknown as Env;

    await recordSubmissionOutcome(env, "acme/widgets", "alice", "merged");

    expect(preparedSql).toContain("submissions = submitter_stats.submissions + 1");
    expect(preparedSql).toContain("merged = submitter_stats.merged + 1");
    expect(preparedSql).not.toContain("submissions = submissions + 1");
    expect(preparedSql).not.toContain("merged = merged + 1");
  });
});

describe("reputationOutcomeFromTerminalState (pure)", () => {
  it("maps merged / closed / manual / no-terminal correctly", () => {
    const failingGate = evaluateGateCheck(advisory({ findings: [{ code: "secret_leak", severity: "critical", title: "x", detail: "y" }] }), { confirmedContributor: true });
    expect(failingGate.conclusion).toBe("failure");
    // merged: the webhook payload carries merged_at (closed PR).
    expect(reputationOutcomeFromTerminalState({ state: "closed", mergedAt: null }, { merged_at: "2026-06-20T00:00:00Z" }, undefined)).toBe("merged");
    // closed without a merge.
    expect(reputationOutcomeFromTerminalState({ state: "closed", mergedAt: null }, { merged_at: null }, undefined)).toBe("closed");
    // still open but the gate routed it to manual review.
    expect(reputationOutcomeFromTerminalState({ state: "open", mergedAt: null }, { merged_at: null }, failingGate)).toBe("manual");
    // still open, gate did not flag → nothing to record yet.
    const passingGate = evaluateGateCheck(advisory(), { confirmedContributor: true });
    expect(reputationOutcomeFromTerminalState({ state: "open", mergedAt: null }, { merged_at: null }, passingGate)).toBeUndefined();
  });
});
