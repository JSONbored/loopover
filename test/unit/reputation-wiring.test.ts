import { describe, expect, it, vi } from "vitest";
import { reputationOutcomeFromTerminalState, runAiReviewForAdvisory } from "../../src/queue/processors";
import {
  getEffectiveSubmitterReputation,
  isReputationEnabled,
  recordReputationOutcome,
  shouldDowngradeToDeterministic,
  shouldSkipAiForReputation,
} from "../../src/review/reputation-wire";
import { getSubmitterReputation, recordSubmissionOutcome } from "../../src/review/submitter-reputation";
import { evaluateGateCheck } from "../../src/rules/advisory";
import type { Advisory, RepositorySettings } from "../../src/types";
import { createTestEnv } from "../helpers/d1";
import { upsertRepositoryFromGitHub } from "../../src/db/repositories";

// Seeds one terminal review_targets row -- the raw table getSubmitterReputation(AcrossInstall) reads from
// (not part of the Drizzle schema; migrations/0050 is the source of truth for these columns).
async function seedReviewTarget(
  env: Env,
  args: { project: string; repo: string; number: number; installationId: number; submitter: string; status: string; reasonCode?: string | null },
) {
  await env.DB.prepare(
    `INSERT INTO review_targets (id, project, kind, repo, number, installation_id, submitter, status, decision_json, terminal_at)
     VALUES (?, ?, 'pull_request', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
  )
    .bind(
      `${args.project}:pull_request:${args.repo}#${args.number}`,
      args.project,
      args.repo,
      args.number,
      args.installationId,
      args.submitter,
      args.status,
      args.reasonCode === undefined ? null : JSON.stringify({ reasonCode: args.reasonCode }),
    )
    .run();
}

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
const baseArgs = { mode: "live" as const, settings: { aiReviewMode: "advisory" } as RepositorySettings, repoFullName: "acme/widgets", pr, author: "burster", confirmedContributor: true };

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
  it("does not let all-time close-rate independently skip AI review for established submitters", () => {
    // Regression: all-time submitter_stats are operator/statistics data. A high aggregate close-rate must not
    // override a neutral or trusted windowed signal once the submitter has an established merge record.
    expect(shouldDowngradeToDeterministic({ submissions: 20, merged: 2, closed: 17, manual: 0, closeRate: 17 / 19, signal: "neutral" })).toBe(false);
    expect(shouldDowngradeToDeterministic({ submissions: 34, merged: 5, closed: 29, manual: 0, closeRate: 29 / 34, signal: "trusted" })).toBe(false);
    // Just below the former close-rate floor → not downgraded on the aggregate alone.
    expect(shouldDowngradeToDeterministic({ submissions: 20, merged: 5, closed: 14, manual: 0, closeRate: 14 / 19, signal: "neutral" })).toBe(false);
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

  it("FLAG-ON: false for a null submitter (the ?? undefined coalesce on both the quality and cadence reads)", async () => {
    const env = createTestEnv({ GITTENSORY_REVIEW_REPUTATION: "true" });
    expect(await shouldSkipAiForReputation(env, { project: "acme/widgets", submitter: null })).toBe(false);
  });

  describe("submission-cadence signal (#4514)", () => {
    async function seedReviewTarget(env: Env, args: { number: number; submitter: string; createdAt: string }) {
      await env.DB.prepare(
        `INSERT INTO review_targets (id, project, kind, repo, number, submitter, status, decision_json, terminal_at, created_at)
         VALUES (?, 'acme/widgets', 'pull_request', 'acme/widgets', ?, ?, 'merged', ?, ?, ?)`,
      )
        .bind(`acme/widgets:pull_request:acme/widgets#${args.number}`, args.number, args.submitter, JSON.stringify({ reasonCode: "dual_review_approved" }), args.createdAt, args.createdAt)
        .run();
    }

    it("FLAG-ON: true for a machine-paced submitter even though every submission itself looks fine (quality-neutral)", async () => {
      const env = createTestEnv({ GITTENSORY_REVIEW_REPUTATION: "true" });
      // Anchored to now (minus a couple hours of headroom) -- the cadence query only looks back 24h, so a
      // fixed past date would fall outside the window and vacuously read as "0 samples, not machine-paced".
      const t0 = Date.now() - 2 * 60 * 60_000;
      for (let i = 0; i < 5; i++) {
        // All merged/approved -- the QUALITY signal alone stays neutral/trusted; only cadence should trip this.
        await seedReviewTarget(env, { number: i, submitter: "speedster", createdAt: new Date(t0 + i * 5 * 60_000).toISOString() });
      }
      expect(await shouldSkipAiForReputation(env, { project: "acme/widgets", submitter: "speedster" })).toBe(true);
    });

    it("FLAG-ON: false for the same number of submissions spread naturally over hours (comfortably human pace)", async () => {
      const env = createTestEnv({ GITTENSORY_REVIEW_REPUTATION: "true" });
      const t0 = Date.now() - 20 * 60 * 60_000;
      for (let i = 0; i < 5; i++) {
        await seedReviewTarget(env, { number: i + 100, submitter: "steady", createdAt: new Date(t0 + i * 3 * 60 * 60_000).toISOString() });
      }
      expect(await shouldSkipAiForReputation(env, { project: "acme/widgets", submitter: "steady" })).toBe(false);
    });

    it("FLAG-ON: skips the (extra) cadence read once the quality/burst signal already justifies downgrading", async () => {
      const env = createTestEnv({ GITTENSORY_REVIEW_REPUTATION: "true" });
      await seedSubmitter(env, { project: "acme/widgets", submitter: "burster", submissions: 12, merged: 0, closed: 12, manual: 0 });
      const spy = vi.spyOn(env.DB, "prepare");
      const before = spy.mock.calls.length;
      expect(await shouldSkipAiForReputation(env, { project: "acme/widgets", submitter: "burster" })).toBe(true);
      // Exactly the calls the quality/burst read itself makes (submitter_stats + review_targets window) --
      // no additional prepare() for a cadence query once the burst check alone already returned true.
      const afterQualityOnlyCallCount = spy.mock.calls.length - before;
      spy.mockRestore();
      expect(afterQualityOnlyCallCount).toBe(2);
    });
  });
});

describe("getEffectiveSubmitterReputation (#4513, install-wide for a confirmed miner)", () => {
  function stubMinerFetch(githubUsername: string) {
    return async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return Response.json([{ githubUsername, githubId: "123", totalPrs: 2, totalMergedPrs: 2, isEligible: true, credibility: 1 }]);
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://api.gittensor.io/miners/123") return Response.json({});
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      return Response.json({});
    };
  }

  it("widens to the install-wide signal for a CONFIRMED miner when the per-repo signal alone stays neutral", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo-a", full_name: "org/repo-a", owner: { login: "org" } }, 999);
    // Only 1 sample on repo-a itself -- per-repo signal stays "neutral" (below minSample).
    await seedReviewTarget(env, { project: "org/repo-a", repo: "org/repo-a", number: 1, installationId: 999, submitter: "farmer99", status: "closed", reasonCode: "dual_review_declined" });
    // But spread across OTHER repos in the SAME install, farmer99 has a clear serial-decline pattern.
    for (let i = 0; i < 7; i++) {
      await seedReviewTarget(env, { project: `org/repo-${i}`, repo: `org/repo-${i}`, number: i + 10, installationId: 999, submitter: "farmer99", status: "closed", reasonCode: "dual_review_declined" });
    }
    vi.stubGlobal("fetch", stubMinerFetch("farmer99"));
    try {
      const rep = await getEffectiveSubmitterReputation(env, { repoFullName: "org/repo-a", submitter: "farmer99" });
      expect(rep.signal).toBe("low");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does NOT widen for an UNCONFIRMED submitter with the identical cross-repo pattern -- stays per-repo neutral", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo-a", full_name: "org/repo-a", owner: { login: "org" } }, 999);
    await seedReviewTarget(env, { project: "org/repo-a", repo: "org/repo-a", number: 1, installationId: 999, submitter: "farmer99", status: "closed", reasonCode: "dual_review_declined" });
    for (let i = 0; i < 7; i++) {
      await seedReviewTarget(env, { project: `org/repo-${i}`, repo: `org/repo-${i}`, number: i + 10, installationId: 999, submitter: "farmer99", status: "closed", reasonCode: "dual_review_declined" });
    }
    // /miners returns an empty roster -- farmer99 resolves as "not_found", never "confirmed".
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      return Response.json({});
    });
    try {
      const rep = await getEffectiveSubmitterReputation(env, { repoFullName: "org/repo-a", submitter: "farmer99" });
      expect(rep.signal).toBe("neutral");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("skips the miner-identity lookup entirely when the per-repo signal already justifies downgrading", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo-a", full_name: "org/repo-a", owner: { login: "org" } }, 999);
    // A clear per-repo serial-decline pattern on its own -- already "low" without any cross-repo help.
    for (let i = 0; i < 7; i++) {
      await seedReviewTarget(env, { project: "org/repo-a", repo: "org/repo-a", number: i, installationId: 999, submitter: "farmer99", status: "closed", reasonCode: "dual_review_declined" });
    }
    const fetchMock = vi.fn(stubMinerFetch("farmer99"));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const rep = await getEffectiveSubmitterReputation(env, { repoFullName: "org/repo-a", submitter: "farmer99" });
      expect(rep.signal).toBe("low");
      // The miner-identity lookup (and therefore the cross-repo query) never ran -- unnecessary once the
      // per-repo signal alone already justifies caution.
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a CONFIRMED miner whose cross-repo history is ALSO clean falls back to the (neutral) per-repo result", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo-a", full_name: "org/repo-a", owner: { login: "org" } }, 999);
    // Only 1 sample per-repo AND only 1 sample install-wide -- neither crosses minSample, so both the
    // per-repo AND the cross-repo reads land on "neutral"; the ternary's FALSE branch (acrossInstall doesn't
    // justify downgrading) must return perRepo, not silently substitute the (also-neutral) acrossInstall.
    await seedReviewTarget(env, { project: "org/repo-a", repo: "org/repo-a", number: 1, installationId: 999, submitter: "farmer99", status: "merged", reasonCode: "dual_review_approved" });
    vi.stubGlobal("fetch", stubMinerFetch("farmer99"));
    try {
      const rep = await getEffectiveSubmitterReputation(env, { repoFullName: "org/repo-a", submitter: "farmer99" });
      expect(rep.signal).toBe("neutral");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fails safe to the per-repo result when the repository lookup itself throws", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo-a", full_name: "org/repo-a", owner: { login: "org" } }, 999);
    await seedReviewTarget(env, { project: "org/repo-a", repo: "org/repo-a", number: 1, installationId: 999, submitter: "farmer99", status: "merged", reasonCode: "dual_review_approved" });
    vi.stubGlobal("fetch", stubMinerFetch("farmer99"));
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      if (/FROM\s+["`]?repositories["`]?/i.test(sql)) throw new Error("d1 down");
      return realPrepare(sql);
    }) as typeof env.DB.prepare;
    try {
      const rep = await getEffectiveSubmitterReputation(env, { repoFullName: "org/repo-a", submitter: "farmer99" });
      expect(rep.signal).toBe("neutral"); // per-repo result (also neutral here), never throws
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns the per-repo result unchanged when there is no submitter at all", async () => {
    const env = createTestEnv();
    const rep = await getEffectiveSubmitterReputation(env, { repoFullName: "org/repo-a", submitter: undefined });
    expect(rep.signal).toBe("neutral");
  });

  it("fails safe to the (already-neutral) per-repo result, without throwing, when the repo has no resolvable installationId", async () => {
    const env = createTestEnv();
    // repo-a is never registered -> getRepository resolves to null -> nothing to widen with, even though
    // farmer99 IS a confirmed miner and has a real cross-repo pattern recorded under installation 999.
    await seedReviewTarget(env, { project: "org/repo-a", repo: "org/repo-a", number: 1, installationId: 999, submitter: "farmer99", status: "closed", reasonCode: "dual_review_declined" });
    vi.stubGlobal("fetch", stubMinerFetch("farmer99"));
    try {
      const rep = await getEffectiveSubmitterReputation(env, { repoFullName: "org/repo-a", submitter: "farmer99" });
      // Only 1 sample, below minSample -> the per-repo signal itself is neutral, and with no installationId to
      // widen with the function must return exactly that (not throw, not fabricate a signal).
      expect(rep.signal).toBe("neutral");
    } finally {
      vi.unstubAllGlobals();
    }
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
