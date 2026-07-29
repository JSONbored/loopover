import { describe, expect, it } from "vitest";
import {
  EXEMPLAR_WINDOW_SIZE,
  JUDGE_EXEMPLARS,
  planSelfConsistencyRuns,
  resolveSelfConsistencyRuns,
  rotatedExemplarSuffix,
  rotatedExemplarWindow,
} from "../../src/review/self-consistency";
import { scoreJudgmentAgreement } from "../../src/review/judgment-agreement";
import { vi, afterEach, beforeEach } from "vitest";
import {
  upsertInstallation,
  upsertOfficialMinerDetection,
  upsertPullRequestFromGitHub,
  upsertRepositoryFromGitHub,
  upsertRepositorySettings,
} from "../../src/db/repositories";
import { reReviewStoredPullRequest } from "../../src/queue/processors";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import { normalizeRegistryPayload } from "../../src/registry/normalize";
import { persistRegistrySnapshot } from "../../src/registry/sync";
import { asCloudEnv, createTestEnv } from "../helpers/d1";
import { generatePrivateKeyPem } from "../helpers/github-app-key";

// #8834, the paid half. The free half (judgment-agreement.ts) scores whatever stances exist; this half buys
// extra SAME-judge stances with rotated exemplar windows, flag-gated OFF, riding the daily neuron budget and
// degrading to fewer runs -- never a fabricated score -- when the budget cannot fund them.
describe("rotated-exemplar self-consistency (#8834)", () => {
  describe("resolveSelfConsistencyRuns — the OFF-by-default flag", () => {
    it("unset/empty/zero/garbage are all OFF — today's behavior stays byte-identical", () => {
      for (const raw of [undefined, "", "0", "1", "nope", "-3"]) {
        expect(resolveSelfConsistencyRuns(raw)).toBe(0);
      }
    });

    it("clamps into {2,3}: one total run cannot measure agreement, and the benefit saturates by three", () => {
      expect(resolveSelfConsistencyRuns("2")).toBe(2);
      expect(resolveSelfConsistencyRuns("3")).toBe(3);
      expect(resolveSelfConsistencyRuns("7")).toBe(3);
      expect(resolveSelfConsistencyRuns("2.9")).toBe(2); // floor, never round up into extra spend
    });
  });

  describe("rotatedExemplarWindow — deterministic rotation, real rotation", () => {
    it("PROPERTY: the same (seed, runIndex) always yields the same window — replay can reconstruct what a run saw", () => {
      for (let run = 1; run <= 3; run += 1) {
        expect(rotatedExemplarWindow("o/r#7", run)).toEqual(rotatedExemplarWindow("o/r#7", run));
      }
    });

    it("PROPERTY: consecutive run indices yield DIFFERENT windows — otherwise the runs measure sampling noise, not exemplar-rotated consistency", () => {
      const first = rotatedExemplarWindow("o/r#7", 1).map((e) => e.id);
      const second = rotatedExemplarWindow("o/r#7", 2).map((e) => e.id);
      expect(first).not.toEqual(second);
    });

    it("PROPERTY: different targets start at different offsets, so no exemplar dominates the fleet's second opinions", () => {
      const seeds = ["a/a#1", "b/b#2", "c/c#3", "d/d#4", "e/e#5", "f/f#6", "g/g#7"];
      const firstIds = new Set(seeds.map((seed) => rotatedExemplarWindow(seed, 1)[0]?.id));
      expect(firstIds.size).toBeGreaterThan(1);
    });

    it("windows are the declared size, drawn from the declared set, and survive an empty set without crashing", () => {
      const window = rotatedExemplarWindow("o/r#7", 1);
      expect(window).toHaveLength(EXEMPLAR_WINDOW_SIZE);
      for (const exemplar of window) expect(JUDGE_EXEMPLARS.map((e) => e.id)).toContain(exemplar.id);
      expect(rotatedExemplarWindow("o/r#7", 1, [])).toEqual([]);
    });

    it("the shipped exemplar set is balanced — an unbalanced set would bias every second opinion toward one verdict", () => {
      const defects = JUDGE_EXEMPLARS.filter((e) => e.verdict === "defect").length;
      expect(defects).toBe(JUDGE_EXEMPLARS.length - defects);
    });
  });

  describe("rotatedExemplarSuffix", () => {
    it("renders the window with both verdict classes representable, and tells the model never to echo it", () => {
      const suffix = rotatedExemplarSuffix("o/r#7", 1);
      expect(suffix).toContain("Calibration examples");
      expect(suffix).toContain("never mention them in output");
      // Across the full rotation both verdict phrasings appear (balance test above guarantees the set has both).
      const all = [1, 2, 3, 4, 5, 6].map((k) => rotatedExemplarSuffix("o/r#7", k)).join("");
      expect(all).toContain("a blocking defect");
      expect(all).toContain("no blockers");
    });

    it("an empty exemplar set renders an empty suffix — the prompt is unchanged, not decorated with a header", () => {
      expect(rotatedExemplarSuffix("o/r#7", 1, [])).toBe("");
    });
  });

  describe("planSelfConsistencyRuns — budget honesty", () => {
    it("funds the configured extras when the budget allows", () => {
      expect(planSelfConsistencyRuns({ configuredTotalRuns: 3, remainingBudget: 1000, perRunEstimate: 100 })).toEqual({
        extraRuns: 2,
        degradedByBudget: false,
      });
    });

    it("INVARIANT: degrades to FEWER runs when the budget cannot fund them — and says so, never fabricating", () => {
      expect(planSelfConsistencyRuns({ configuredTotalRuns: 3, remainingBudget: 150, perRunEstimate: 100 })).toEqual({
        extraRuns: 1,
        degradedByBudget: true,
      });
      expect(planSelfConsistencyRuns({ configuredTotalRuns: 2, remainingBudget: 0, perRunEstimate: 100 })).toEqual({
        extraRuns: 0,
        degradedByBudget: true,
      });
    });

    it("INVARIANT: a zero/negative per-run estimate degrades toward FEWER paid calls, never unbounded ones", () => {
      const plan = planSelfConsistencyRuns({ configuredTotalRuns: 3, remainingBudget: 5, perRunEstimate: 0 });
      expect(plan.extraRuns).toBeLessThanOrEqual(2);
    });

    it("off (or one total run) plans nothing and reports no degradation", () => {
      expect(planSelfConsistencyRuns({ configuredTotalRuns: 0, remainingBudget: 1000, perRunEstimate: 1 })).toEqual({
        extraRuns: 0,
        degradedByBudget: false,
      });
      expect(planSelfConsistencyRuns({ configuredTotalRuns: 1, remainingBudget: 1000, perRunEstimate: 1 })).toEqual({
        extraRuns: 0,
        degradedByBudget: false,
      });
    });
  });

  describe("the confidence contract with judgment-agreement (the disagreement→hold path)", () => {
    it("a disagreeing extra sample DROPS the folded confidence — which is what routes the decision to hold via the existing floor", () => {
      const unanimous = scoreJudgmentAgreement(
        [
          { votedFail: true },
          { votedFail: true }, // agreeing self-consistency sample
        ],
        0.9,
      );
      const split = scoreJudgmentAgreement(
        [
          { votedFail: true },
          { votedFail: false }, // disagreeing self-consistency sample
        ],
        0.9,
      );
      expect(unanimous.confidence).toBeGreaterThan(split.confidence);
      expect(split.agreement).toBe(0.5);
    });

    it("a fully-degraded plan leaves a single stance, which scores as UNCORROBORATED — the lower recorded confidence the issue requires", () => {
      const degraded = scoreJudgmentAgreement([{ votedFail: true }], 0.9);
      expect(degraded.uncorroborated).toBe(true);
      expect(degraded.confidence).toBeLessThan(0.9);
    });
  });

  // End-to-end: the flag actually buys extra judge calls, accounts every one of them against the daily
  // budget, and the whole pass still completes. Same minimal seed as the sibling review-flow suites (the
  // per-file fixture-duplication convention).
  describe("end-to-end with the flag on", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-07-28T00:00:00.000Z"));
    });
    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    async function seed(env: Env) {
      await persistRegistrySnapshot(
        asCloudEnv(env),
        normalizeRegistryPayload(
          { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
          { kind: "raw-github", url: "https://example.test" },
          "2026-05-23T00:00:00.000Z",
        ),
      );
      await upsertInstallation(env, { action: "created", installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "selected", permissions: {}, events: [] } });
      await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
      await upsertRepositorySettings(env, { repoFullName: "JSONbored/gittensory", autoLabelEnabled: false, gatePack: "oss-anti-slop", autonomy: { label: "auto" } });
      await upsertRepoFocusManifest(env, "JSONbored/gittensory", {
        settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", reviewCheckMode: "required", aiReviewMode: "block" },
      });
      await upsertOfficialMinerDetection(env, "contributor", { status: "confirmed", snapshot: {
        source: "gittensor_api" as const, githubId: "123", githubUsername: "contributor", isEligible: true, credibility: 1,
        eligibleRepoCount: 1, issueDiscoveryScore: 0, issueTokenScore: 0, issueCredibility: 1, isIssueEligible: false,
        issueEligibleRepoCount: 0, alphaPerDay: 0, taoPerDay: 0, usdPerDay: 0,
        totals: { pullRequests: 3, mergedPullRequests: 2, openPullRequests: 1, closedPullRequests: 0, openIssues: 0, closedIssues: 0, solvedIssues: 0, validSolvedIssues: 0 },
        repositories: [], pullRequests: [], issueLabels: [],
      } }, 60_000);
      await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
        number: 900, title: "Self-consistency PR", state: "open", user: { login: "contributor" },
        author_association: "CONTRIBUTOR", head: { sha: "shaSc" }, base: { ref: "main" }, labels: [], body: "Closes #1",
      });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
        if (url.includes("/pulls/900/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
        if (url.endsWith("/pulls/900")) return Response.json({ number: 900, title: "Self-consistency PR", state: "open", user: { login: "contributor" }, head: { sha: "shaSc" }, labels: [], body: "Closes #1", mergeable_state: "clean" });
        if (url.includes("/commits/shaSc/check-runs")) return Response.json({ total_count: 1, check_runs: [{ name: "test", status: "completed", conclusion: "success", app: { slug: "github-actions" } }] });
        if (url.includes("/commits/shaSc/status")) return Response.json({ state: "success", statuses: [] });
        if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
        if (url.includes("/issues/900/comments") && (method === "POST" || method === "PATCH")) return Response.json({ id: 1 }, { status: 201 });
        if (url.includes("/issues/900/comments")) return Response.json([]);
        if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
        return Response.json({});
      });
    }

    it("REGRESSION: flag=3 spends exactly two extra judge calls, each with a DIFFERENT rotated exemplar window, all budget-accounted", async () => {
      const prompts: string[] = [];
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async (_model: string, options: { messages?: Array<{ role: string; content: string }> }) => {
          prompts.push(options.messages?.find((m) => m.role === "system")?.content ?? "");
          return { response: JSON.stringify({ assessment: "Fine.", blockers: [], nits: [], suggestions: [] }) };
        } } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
        AI_REVIEW_SELF_CONSISTENCY_RUNS: "3",
      });
      await seed(env);

      await reReviewStoredPullRequest(env, "sc-900", 123, "JSONbored/gittensory", 900);

      const judgeCalls = prompts.filter((prompt) => prompt.length > 0);
      expect(judgeCalls.length).toBeGreaterThanOrEqual(3); // 1 primary + 2 self-consistency extras
      const exemplarPrompts = judgeCalls.filter((prompt) => prompt.includes("Calibration examples"));
      expect(exemplarPrompts).toHaveLength(2); // the extras carry the rotated windows; the primary never does
      expect(exemplarPrompts[0]).not.toBe(exemplarPrompts[1]); // rotation, not repetition
      const usage = await env.DB.prepare(
        "select count(*) as n from ai_usage_events where status = 'ok' and json_extract(metadata_json, '$.selfConsistency') = 1",
      ).first<{ n: number }>();
      expect(usage?.n).toBe(2); // every extra run rides the SAME budget sum the quota gate reads
    });

    it("REGRESSION (#9821): a guardrail hit ESCALATES runs end-to-end — env off, gate.guardrailEscalation.selfConsistencyRuns=3 delivers 2 extra judged calls", async () => {
      // The review blocker on #9821 was that resolveReviewKnobs was computed and dropped. This drives the
      // whole pipeline: manifest -> settings -> orchestration (isGuardrailHit on src/a.ts) -> reviewKnobs ->
      // runLoopOverAiReview's runs override (the `input.reviewKnobs?.selfConsistencyRuns` branch) -> the
      // planner -> two extra rotated-exemplar calls. AI_REVIEW_SELF_CONSISTENCY_RUNS is deliberately UNSET:
      // every extra call here exists only because the escalation reached the invocation.
      const prompts: string[] = [];
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async (_model: string, options: { messages?: Array<{ role: string; content: string }> }) => {
          prompts.push(options.messages?.find((m) => m.role === "system")?.content ?? "");
          return { response: JSON.stringify({ assessment: "Fine.", blockers: [], nits: [], suggestions: [] }) };
        } } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seed(env);
      await upsertRepoFocusManifest(env, "JSONbored/gittensory", {
        settings: {
          commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", reviewCheckMode: "required", aiReviewMode: "block",
          hardGuardrailGlobs: ["src/**"], // the PR's one changed file is src/a.ts -- a guardrail hit
        },
        gate: { guardrailEscalation: { selfConsistencyRuns: 3 } },
      });

      await reReviewStoredPullRequest(env, "sc-escalated-900", 123, "JSONbored/gittensory", 900);

      const judgeCalls = prompts.filter((prompt) => prompt.length > 0);
      expect(judgeCalls.length).toBeGreaterThanOrEqual(3); // 1 primary + 2 escalated extras
      expect(judgeCalls.filter((prompt) => prompt.includes("Calibration examples"))).toHaveLength(2);
    });

    it("INVARIANT (#9821): the same escalation block is INERT when no changed file hits a guardrail glob", async () => {
      let aiCalls = 0;
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => {
          aiCalls += 1;
          return { response: JSON.stringify({ assessment: "Fine.", blockers: [], nits: [], suggestions: [] }) };
        } } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seed(env);
      await upsertRepoFocusManifest(env, "JSONbored/gittensory", {
        settings: {
          commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", reviewCheckMode: "required", aiReviewMode: "block",
          hardGuardrailGlobs: ["migrations/**"], // src/a.ts does NOT match -- no hit, no escalation
        },
        gate: { guardrailEscalation: { selfConsistencyRuns: 3 } },
      });

      await reReviewStoredPullRequest(env, "sc-inert-900", 123, "JSONbored/gittensory", 900);
      // Counted via the selfConsistency usage marker, not raw AI.run calls: other pipeline consumers (the
      // slop advisory, summaries) legitimately also call AI.run -- the precise claim is that the ESCALATED
      // runs never fired, same discipline as the flag-off baseline above.
      const usage = await env.DB.prepare(
        "select count(*) as n from ai_usage_events where json_extract(metadata_json, '$.selfConsistency') = 1",
      ).first<{ n: number }>();
      expect(usage?.n).toBe(0);
      expect(aiCalls).toBeGreaterThan(0); // the pass itself still reviewed
    });

    it("INVARIANT: flag off (default) spends nothing extra and adds no self-consistency usage rows", async () => {
      let aiCalls = 0;
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => { aiCalls += 1; return { response: JSON.stringify({ assessment: "Fine.", blockers: [], nits: [], suggestions: [] }) }; } } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
      });
      await seed(env);

      await reReviewStoredPullRequest(env, "sc-off-900", 123, "JSONbored/gittensory", 900);

      const usage = await env.DB.prepare(
        "select count(*) as n from ai_usage_events where json_extract(metadata_json, '$.selfConsistency') = 1",
      ).first<{ n: number }>();
      expect(usage?.n).toBe(0);
      expect(aiCalls).toBeGreaterThan(0); // the pass itself still reviewed
    });

    it("INVARIANT: an exhausted budget degrades to zero extras — the pass completes, nothing is fabricated", async () => {
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => ({ response: JSON.stringify({ assessment: "Fine.", blockers: [], nits: [], suggestions: [] }) }) } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        // Enough for the primary evaluation (estimated ~3.5k neurons for this fixture), but the remainder
        // cannot fund a single extra run at the same per-run estimate.
        AI_DAILY_NEURON_BUDGET: "5000",
        AI_REVIEW_SELF_CONSISTENCY_RUNS: "3",
      });
      await seed(env);

      await reReviewStoredPullRequest(env, "sc-budget-900", 123, "JSONbored/gittensory", 900);

      const extras = await env.DB.prepare(
        "select count(*) as n from ai_usage_events where json_extract(metadata_json, '$.selfConsistency') = 1",
      ).first<{ n: number }>();
      expect(extras?.n).toBe(0); // degraded, not fabricated
      const reviewed = await env.DB.prepare("select count(*) as n from ai_usage_events where status = 'ok'").first<{ n: number }>();
      expect(reviewed?.n).toBeGreaterThan(0); // the primary review itself still happened and was recorded
    });

    it("REGRESSION: a dissenting extra sample lands in the persisted decision record's agreement", async () => {
      // Primaries flag a consensus defect; extra run 1 dissents (clean), extra run 2 agrees (blockers).
      // Stances fold as [fail, fail, clean, fail] -> agreement 0.75 on the ai_consensus_defect finding,
      // which persistDecisionRecord carries into decision_records.ai_agreement.
      let exemplarCalls = 0;
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async (_model: string, options: { messages?: Array<{ role: string; content: string }> }) => {
          const systemContent = options.messages?.find((m) => m.role === "system")?.content ?? "";
          if (systemContent.includes("Calibration examples")) {
            exemplarCalls += 1;
            return { response: JSON.stringify(exemplarCalls === 1
              ? { assessment: "Fine.", blockers: [], nits: [], suggestions: [] }
              : { assessment: "Broken.", blockers: ["Null deref: crashes on empty input"], nits: [], suggestions: [] }) };
          }
          return { response: JSON.stringify({ assessment: "Broken.", blockers: ["Null deref: crashes on empty input"], nits: [], suggestions: [] }) };
        } } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
        AI_REVIEW_SELF_CONSISTENCY_RUNS: "3",
      });
      await seed(env);

      await reReviewStoredPullRequest(env, "sc-dissent-900", 123, "JSONbored/gittensory", 900);

      expect(exemplarCalls).toBe(2);
      const row = await env.DB.prepare(
        "select record_json from decision_records order by created_at desc limit 1",
      ).first<{ record_json: string }>();
      const record = JSON.parse(row?.record_json ?? "{}") as { aiAgreement: { agreement: number; sampleCount: number } | null };
      expect(record.aiAgreement?.agreement).toBe(0.75); // 3 of 4 stances failed -- the dissent is measured, not discarded
      expect(record.aiAgreement?.sampleCount).toBe(4); // two primaries + two extra samples
    });

    it("INVARIANT: an extra run that fails outright records its spend but fabricates no stance", async () => {
      // Every exemplar-suffixed call throws (all attempts, both models): the sample yields no review, so no
      // stance folds -- but the usage row is still written, because the calls were genuinely spent.
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async (_model: string, options: { messages?: Array<{ role: string; content: string }> }) => {
          const systemContent = options.messages?.find((m) => m.role === "system")?.content ?? "";
          if (systemContent.includes("Calibration examples")) throw new Error("provider down");
          return { response: JSON.stringify({ assessment: "Broken.", blockers: ["Null deref: crashes on empty input"], nits: [], suggestions: [] }) };
        } } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
        AI_REVIEW_SELF_CONSISTENCY_RUNS: "2",
      });
      await seed(env);

      await reReviewStoredPullRequest(env, "sc-fail-900", 123, "JSONbored/gittensory", 900);

      const usage = await env.DB.prepare(
        "select count(*) as n from ai_usage_events where json_extract(metadata_json, '$.selfConsistency') = 1",
      ).first<{ n: number }>();
      expect(usage?.n).toBe(1); // the spend is accounted
      const row = await env.DB.prepare(
        "select record_json from decision_records order by created_at desc limit 1",
      ).first<{ record_json: string }>();
      const record = JSON.parse(row?.record_json ?? "{}") as { aiAgreement: { agreement: number; sampleCount: number } | null };
      // Both primaries failed the PR unanimously and the broken extra contributed NOTHING -- had a stance
      // been fabricated from the failed run, the sample count would be 3 and agreement below 1.
      expect(record.aiAgreement?.sampleCount).toBe(2);
      expect(record.aiAgreement?.agreement).toBe(1);
    });

    it("INVARIANT: flag on but no usable primary stance spends nothing -- corroborating a non-verdict is pure waste", async () => {
      const env = createTestEnv({
        GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
        AI: { run: async () => ({ response: "I am not JSON at all" }) } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
        AI_REVIEW_SELF_CONSISTENCY_RUNS: "3",
      });
      await seed(env);

      await reReviewStoredPullRequest(env, "sc-novote-900", 123, "JSONbored/gittensory", 900);

      const usage = await env.DB.prepare(
        "select count(*) as n from ai_usage_events where json_extract(metadata_json, '$.selfConsistency') = 1",
      ).first<{ n: number }>();
      expect(usage?.n).toBe(0);
    });
  });
});
