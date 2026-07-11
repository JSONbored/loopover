import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAiReviewDiff, claimAiReviewLock, runAiReviewForAdvisory, shouldStartAiReviewForAdvisory } from "../../src/queue/processors";
import { BEST_REVIEW_MODELS, INCOHERENT_DIFF_ASSESSMENT } from "../../src/services/ai-review";
import * as sentryModule from "../../src/selfhost/sentry";
import { upsertRepositoryAiKey } from "../../src/db/repositories";
import type { Advisory, PullRequestFileRecord, RepositorySettings } from "../../src/types";
import { createTestEnv } from "../helpers/d1";
import { setLocalManifestReader } from "../../src/signals/focus-manifest-loader";

afterEach(() => {
  vi.unstubAllGlobals();
});

function fileRecord(over: Partial<PullRequestFileRecord> & { path: string }): PullRequestFileRecord {
  return { repoFullName: "acme/widgets", pullNumber: 3, status: "modified", additions: 1, deletions: 0, changes: 1, payload: {}, ...over };
}

describe("buildAiReviewDiff", () => {
  it("includes patches and headers, lists a patch-less file, and truncates oversized diffs (source-first)", () => {
    const diff = buildAiReviewDiff([
      fileRecord({ path: "src/a.ts", status: "modified", payload: { patch: "@@\n+const x = 1;" } }),
      fileRecord({ path: "src/b.ts", status: undefined, payload: {} }),
    ]);
    expect(diff).toContain("### src/a.ts (modified) +1/-0");
    expect(diff).toContain("+const x = 1;");
    expect(diff).toContain("### src/b.ts (modified) +1/-0"); // status defaults to "modified"
    expect(diff).toContain("no inline patch"); // patch-less file still listed, never invisible
    expect(buildAiReviewDiff([])).toBe("");

    // Oversized patch beyond the 80k budget is truncated (per-file hunk-aware or top-level), never silently dropped.
    const huge = buildAiReviewDiff([fileRecord({ path: "src/big.ts", payload: { patch: "x".repeat(90000) } }), fileRecord({ path: "src/next.ts" })]);
    expect(huge).toContain("truncated");
  });
});

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
    generatedAt: "2026-06-13T00:00:00.000Z",
    ...over,
  };
}

const pr = { number: 3, title: "Add helper", body: "Adds a helper." };

function defectJson() {
  return JSON.stringify({ assessment: "Likely crash.", blockers: ["Null dereference of a possibly-null value in src/a.ts."], nits: ["Guard null."], suggestions: ["Guard null."] });
}
function notesOnlyJson() {
  return JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: ["Add a test."], suggestions: ["Add a test."] });
}
function nitsWithoutAssessmentJson() {
  return JSON.stringify({ assessment: "", blockers: [], nits: ["Add a test."], suggestions: ["Add a test."] });
}
// #4744: a model response that ALSO includes the #4743 valueAssessment field, for exercising
// runAiReviewForAdvisory's improvementSignal pass-through end to end.
function notesWithValueAssessmentJson() {
  return JSON.stringify({
    assessment: "Looks fine.",
    blockers: [],
    nits: ["Add a test."],
    suggestions: ["Add a test."],
    valueAssessment: { magnitude: "moderate", rationale: "This meaningfully simplifies the retry logic." },
  });
}

function aiEnv(run: () => Promise<unknown>, flags = true) {
  return createTestEnv({
    AI: { run } as unknown as Ai,
    ...(flags ? { AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true" } : {}),
    AI_DAILY_NEURON_BUDGET: "100000",
  });
}

describe("shouldStartAiReviewForAdvisory", () => {
  const enabledEnv = () => aiEnv(async () => ({ response: notesOnlyJson() }));
  const base = { settings: { aiReviewMode: "advisory", gatePack: "gittensor" } as RepositorySettings, advisory: advisory(), repoFullName: "acme/widgets", author: "alice", confirmedContributor: true };

  it("matches the AI review entry gates before the reviewing placeholder is posted", async () => {
    await expect(shouldStartAiReviewForAdvisory(enabledEnv(), base)).resolves.toBe(true);
    await expect(shouldStartAiReviewForAdvisory(enabledEnv(), { ...base, skipAiReview: true })).resolves.toBe(false);
    await expect(shouldStartAiReviewForAdvisory(enabledEnv(), { ...base, settings: { aiReviewMode: "off" } as RepositorySettings })).resolves.toBe(false);
    await expect(shouldStartAiReviewForAdvisory(enabledEnv(), { ...base, confirmedContributor: false })).resolves.toBe(false);
    await expect(
      shouldStartAiReviewForAdvisory(enabledEnv(), {
        ...base,
        settings: { aiReviewMode: "advisory", gatePack: "gittensor", aiReviewAllAuthors: true } as RepositorySettings,
        confirmedContributor: false,
      }),
    ).resolves.toBe(true);
    await expect(shouldStartAiReviewForAdvisory(enabledEnv(), { ...base, settings: { aiReviewMode: "block", gatePack: "oss-anti-slop" } as RepositorySettings, confirmedContributor: false })).resolves.toBe(true);
    const noSha = advisory();
    delete (noSha as Partial<Advisory>).headSha;
    await expect(shouldStartAiReviewForAdvisory(enabledEnv(), { ...base, advisory: noSha })).resolves.toBe(false);
  });

  it("does not start when AI comments are disabled or the Workers AI binding is unavailable", async () => {
    const commentsDisabled = createTestEnv({ AI: { run: vi.fn() } as unknown as Ai, AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "false" });
    await expect(shouldStartAiReviewForAdvisory(commentsDisabled, base)).resolves.toBe(false);
    const missingBinding = createTestEnv({ AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true" });
    await expect(shouldStartAiReviewForAdvisory(missingBinding, base)).resolves.toBe(false);
  });

  it("does not start when the reputation gate downgrades the PR to deterministic-only", async () => {
    const env = createTestEnv({ AI: { run: vi.fn() } as unknown as Ai, AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true", GITTENSORY_REVIEW_REPUTATION: "true", GITTENSORY_REVIEW_REPOS: "acme/widgets" });
    await env.DB.prepare("INSERT INTO submitter_stats (project, submitter, submissions, merged, closed, manual, last_seen) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)").bind("acme/widgets", "alice", 8, 0, 8, 0).run();
    await expect(shouldStartAiReviewForAdvisory(env, base)).resolves.toBe(false);
  });

  it("honors aiReviewAllAuthors as an explicit self-host review requirement even when reputation would skip", async () => {
    const env = createTestEnv({ AI: { run: vi.fn() } as unknown as Ai, AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true", GITTENSORY_REVIEW_REPUTATION: "true", GITTENSORY_REVIEW_REPOS: "acme/widgets" });
    await env.DB.prepare("INSERT INTO submitter_stats (project, submitter, submissions, merged, closed, manual, last_seen) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)").bind("acme/widgets", "alice", 8, 0, 8, 0).run();
    await expect(
      shouldStartAiReviewForAdvisory(env, {
        ...base,
        settings: { aiReviewMode: "advisory", gatePack: "gittensor", aiReviewAllAuthors: true } as RepositorySettings,
      }),
    ).resolves.toBe(true);
  });
});

describe("runAiReviewForAdvisory", () => {
  it("no-ops when aiReviewMode is off", async () => {
    const adv = advisory();
    const result = await runAiReviewForAdvisory(aiEnv(async () => ({ response: defectJson() })), {
      mode: "live",
      settings: { aiReviewMode: "off" } as RepositorySettings,
      advisory: adv,
      repoFullName: "acme/widgets",
      pr,
      author: "alice",
      confirmedContributor: true,
    });
    expect(result).toBeUndefined();
    expect(adv.findings).toEqual([]);
  });

  it("REGRESSION (#token-bleed-spend-gate): a paused mode never reaches the LLM call, even with aiReviewMode block/advisory and a confirmed contributor", async () => {
    const run = vi.fn(async () => ({ response: defectJson() }));
    const adv = advisory();
    const result = await runAiReviewForAdvisory(aiEnv(run), {
      mode: "paused",
      settings: { aiReviewMode: "block" } as RepositorySettings,
      advisory: adv,
      repoFullName: "acme/widgets",
      pr,
      author: "alice",
      confirmedContributor: true,
    });
    expect(result).toBeUndefined();
    expect(adv.findings).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it("survives a focus-manifest load failure during feature resolution (fail-safe → allowlist default, review still runs)", async () => {
    // loadRepoFocusManifest REJECTS (localManifestReader throws, outside its try/catch) while RAG is flag-enabled,
    // so runAiReviewForAdvisory takes the featureManifest-load arm and its `.catch(() => null)` fires; reputation/rag
    // then fall back to the (empty) allowlist → no RAG build, the review still runs.
    setLocalManifestReader(() => {
      throw new Error("manifest read boom");
    });
    try {
      const env = aiEnv(async () => ({ response: defectJson() }));
      (env as unknown as { GITTENSORY_REVIEW_RAG: string }).GITTENSORY_REVIEW_RAG = "true";
      const result = await runAiReviewForAdvisory(env, {
        mode: "live",
        settings: { aiReviewMode: "block" } as RepositorySettings,
        advisory: advisory(),
        repoFullName: "acme/widgets",
        pr,
        author: "alice",
        confirmedContributor: true,
      });
      expect(result).toBeDefined();
    } finally {
      setLocalManifestReader(null);
    }
  });

  it("degrades when the provider throws and records the CONFIGURED reviewer, not the Workers-AI models (#1566)", async () => {
    // The CLI/provider throwing (e.g. claude-code binary absent → ENOENT) must degrade to no-usable-output, and the
    // usage event must attribute the ACTUAL configured reviewer — not the hardcoded Workers-AI ids that hid the
    // silent outage. Exercises runWorkersOpinion's now-logging catch + reviewerModelLabel's provider arm.
    const env = aiEnv(async () => { throw new Error("claude CLI not found"); });
    (env as unknown as { AI_PROVIDER: string; CLAUDE_AI_MODEL: string }).AI_PROVIDER = "claude-code";
    (env as unknown as { AI_PROVIDER: string; CLAUDE_AI_MODEL: string }).CLAUDE_AI_MODEL = "claude-sonnet-4-6";
    const result = await runAiReviewForAdvisory(env, { mode: "live", settings: { aiReviewMode: "advisory" } as RepositorySettings, advisory: advisory(), repoFullName: "acme/widgets", pr, author: "alice", confirmedContributor: true });
    expect(result).toMatchObject({
      cacheable: false,
      findings: [expect.objectContaining({ code: "ai_review_inconclusive" })],
    }); // provider threw → manual-review hold, degraded not crashed
    const usage = await env.DB.prepare("SELECT model FROM ai_usage_events WHERE feature = 'ai_review_pr' ORDER BY created_at DESC LIMIT 1").first<{ model: string }>();
    expect(usage?.model).toBe("claude-code:claude-sonnet-4-6");
  });

  it("records explicit self-host reviewer labels when models are omitted or providers are unknown", async () => {
    const env = aiEnv(async () => { throw new Error("codex unavailable"); });
    (env as unknown as { AI_PROVIDER: string }).AI_PROVIDER = " CODEX , unknown-provider ";
    const result = await runAiReviewForAdvisory(env, { mode: "live", settings: { aiReviewMode: "advisory" } as RepositorySettings, advisory: advisory(), repoFullName: "acme/widgets", pr, author: "alice", confirmedContributor: true });
    expect(result).toMatchObject({
      cacheable: false,
      findings: [expect.objectContaining({ code: "ai_review_inconclusive" })],
    });
    const usage = await env.DB.prepare("SELECT model FROM ai_usage_events WHERE feature = 'ai_review_pr' ORDER BY created_at DESC LIMIT 1").first<{ model: string }>();
    expect(usage?.model).toBe("codex");
  });

  it("records the resolved self-host reviewer plan instead of raw AI_PROVIDER entries", async () => {
    const env = aiEnv(async () => { throw new Error("ollama unavailable"); });
    Object.assign(env as unknown as Record<string, unknown>, {
      AI_PROVIDER: "anthropic,ollama",
      ANTHROPIC_AI_MODEL: "claude-sonnet-4-6",
      OLLAMA_AI_MODEL: "llama3.1",
      AI_REVIEW_PLAN: { reviewers: [{ model: "anthropic", fallback: "ollama" }], combine: "single" },
    });
    const result = await runAiReviewForAdvisory(env, { mode: "live", settings: { aiReviewMode: "advisory" } as RepositorySettings, advisory: advisory(), repoFullName: "acme/widgets", pr, author: "alice", confirmedContributor: true });
    expect(result).toMatchObject({
      cacheable: false,
      findings: [expect.objectContaining({ code: "ai_review_inconclusive" })],
    });
    const usage = await env.DB.prepare("SELECT model FROM ai_usage_events WHERE feature = 'ai_review_pr' ORDER BY created_at DESC LIMIT 1").first<{ model: string }>();
    expect(usage?.model).toBe("anthropic:claude-sonnet-4-6->ollama:llama3.1");
  });

  it("no-ops for a non-confirmed contributor under the gittensor pack and when there is no head SHA", async () => {
    const env = aiEnv(async () => ({ response: defectJson() }));
    const base = { mode: "live" as const, settings: { aiReviewMode: "block", gatePack: "gittensor" } as RepositorySettings, repoFullName: "acme/widgets", pr, author: "alice" };
    expect(await runAiReviewForAdvisory(env, { ...base, advisory: advisory(), confirmedContributor: false })).toBeUndefined();
    const noSha = advisory();
    delete (noSha as Partial<Advisory>).headSha;
    expect(await runAiReviewForAdvisory(env, { ...base, advisory: noSha, confirmedContributor: true })).toBeUndefined();
  });

  it("runs a blocking AI review for a non-confirmed contributor under oss-anti-slop", async () => {
    const adv = advisory();
    const result = await runAiReviewForAdvisory(aiEnv(async () => ({ response: defectJson() })), {
      mode: "live",
      settings: { aiReviewMode: "block", gatePack: "oss-anti-slop" } as RepositorySettings,
      advisory: adv,
      repoFullName: "acme/widgets",
      pr,
      author: "alice",
      confirmedContributor: false,
    });
    expect(adv.findings.map((f) => f.code)).toEqual(["ai_consensus_defect"]);
    expect(result?.notes).toContain("Likely crash.");
  });

  it("runs the review for a non-confirmed contributor when aiReviewAllAuthors is on (per-repo opt-in)", async () => {
    // The default confirmed-contributor AI-spend gate (line 87 above) returns undefined for an unconfirmed
    // author; aiReviewAllAuthors flips that to run the review for EVERY author (a self-host operator paying for
    // their own AI). gittensor pack + advisory mode, so neither packAllowsAnyAuthorBlockingReview nor confirmation
    // is what lets it through — only the new flag.
    const adv = advisory();
    const result = await runAiReviewForAdvisory(aiEnv(async () => ({ response: notesOnlyJson() })), {
      mode: "live",
      settings: { aiReviewMode: "advisory", gatePack: "gittensor", aiReviewAllAuthors: true , closeOwnerAuthors: false} as RepositorySettings,
      advisory: adv,
      repoFullName: "acme/widgets",
      pr,
      author: "alice",
      confirmedContributor: false,
    });
    expect(result?.notes).toContain("Add a test.");
    expect(adv.findings).toEqual([]); // advisory mode: notes only, no blocker
  });

  it("appends an ai_consensus_defect finding in block mode when the models agree", async () => {
    const adv = advisory();
    const result = await runAiReviewForAdvisory(aiEnv(async () => ({ response: defectJson() })), {
      mode: "live",
      settings: { aiReviewMode: "block" } as RepositorySettings,
      advisory: adv,
      repoFullName: "acme/widgets",
      pr,
      author: "alice",
      confirmedContributor: true,
    });
    expect(adv.findings.map((f) => f.code)).toEqual(["ai_consensus_defect"]);
    expect(adv.findings[0]?.title).toContain("Null deref");
    expect(result?.notes).toContain("Likely crash.");
  });

  it("threads settings.aiReviewCombine/aiReviewOnMerge/aiReviewReviewers (#2567) into the AI review call", async () => {
    // settings.aiReviewCombine/OnMerge/Reviewers are resolved from `.gittensory.yml gate.aiReview.*` upstream by
    // resolveEffectiveSettings; runAiReviewForAdvisory must forward them into runGittensoryAiReview's input so a
    // per-repo override actually reaches the reviewer selection (in place of any env.AI_REVIEW_PLAN default).
    const adv = advisory();
    const seen: string[] = [];
    const run = (async (model: string) => {
      seen.push(model);
      // Only "codex" flags a blocker; under a "single" combine strategy only reviewer[0] ("codex") is addressed.
      return { response: model === "codex" ? defectJson() : notesOnlyJson() };
    }) as unknown as () => Promise<unknown>;
    const result = await runAiReviewForAdvisory(aiEnv(run), {
      mode: "live",
      settings: {
        aiReviewMode: "block",
        aiReviewCombine: "single",
        aiReviewReviewers: [{ model: "codex" }],
      } as unknown as RepositorySettings,
      advisory: adv,
      repoFullName: "acme/widgets",
      pr,
      author: "alice",
      confirmedContributor: true,
    });
    expect(seen).toEqual(["codex"]); // the per-repo reviewer override ran instead of the default Workers-AI pair
    expect(adv.findings.map((f) => f.code)).toEqual(["ai_consensus_defect"]);
    expect(result?.notes).toContain("Likely crash.");
  });

  it("a repo without an aiReviewCombine/OnMerge/Reviewers override sees zero behavior change (default Workers-AI pair + consensus)", async () => {
    const adv = advisory();
    const seen: string[] = [];
    const run = (async (model: string) => {
      seen.push(model);
      return { response: defectJson() };
    }) as unknown as () => Promise<unknown>;
    const result = await runAiReviewForAdvisory(aiEnv(run), {
      mode: "live",
      settings: { aiReviewMode: "block" } as RepositorySettings, // no aiReviewCombine/OnMerge/Reviewers set
      advisory: adv,
      repoFullName: "acme/widgets",
      pr,
      author: "alice",
      confirmedContributor: true,
    });
    expect([...seen].sort()).toEqual([...BEST_REVIEW_MODELS].sort()); // default Workers-AI pair, byte-identical
    expect(adv.findings.map((f) => f.code)).toEqual(["ai_consensus_defect"]);
    expect(result?.notes).toContain("Likely crash.");
  });

  it("threads the calibrated MIN consensus confidence onto the ai_consensus_defect finding (#8)", async () => {
    const adv = advisory();
    // Two reviewers agree on a blocker but with DIFFERENT confidences (0.95 vs 0.6) → the finding carries the min.
    const json = (confidence: number) => JSON.stringify({ assessment: "Likely crash.", blockers: ["Null dereference of a possibly-null value in src/a.ts."], nits: [], suggestions: [], confidence });
    const run = (async (model: string) => ({ response: model === BEST_REVIEW_MODELS[0] ? json(0.95) : json(0.6) })) as unknown as () => Promise<unknown>;
    await runAiReviewForAdvisory(aiEnv(run), {
      mode: "live",
      settings: { aiReviewMode: "block" } as RepositorySettings,
      advisory: adv,
      repoFullName: "acme/widgets",
      pr,
      author: "alice",
      confirmedContributor: true,
    });
    expect(adv.findings[0]?.code).toBe("ai_consensus_defect");
    expect(adv.findings[0]?.confidence).toBe(0.6); // weaker reviewer governs the gate floor
  });

  it("appends an ai_review_inconclusive finding (fail-closed hold) when block-mode AI lacks a second opinion, surfacing it to Sentry as an error", async () => {
    const adv = advisory();
    // The first slot parses; the second slot's primary AND its reliable fallback fail → no consensus possible.
    const run = (async (model: string) => ({ response: model === BEST_REVIEW_MODELS[0] ? notesOnlyJson() : "garbage" })) as unknown as () => Promise<unknown>;
    const env = aiEnv(run);
    const captureSpy = vi.spyOn(sentryModule, "captureReviewFailure");
    const result = await runAiReviewForAdvisory(env, {
      mode: "live",
      settings: { aiReviewMode: "block" } as RepositorySettings,
      advisory: adv,
      repoFullName: "acme/widgets",
      pr,
      author: "alice",
      confirmedContributor: true,
    });
    expect(adv.findings.map((f) => f.code)).toEqual(["ai_review_inconclusive"]);
    expect(result?.notes).toBeDefined(); // the single parseable opinion still produces advisory notes
    // The unproducible review is reported to Sentry with PR context so the maintainer can SEE it (#1468).
    expect(captureSpy).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        kind: "review",
        reason: "ai_review_inconclusive",
        owner: "acme",
        repo: "acme/widgets",
        pr: 3,
        head_sha: "sha3",
        public_notes: true,
        reviewer_count: 1,
        review_diagnostics: expect.arrayContaining([
          expect.objectContaining({ status: "unparseable_output" }),
        ]),
      }),
      "ai_review_inconclusive",
    );
    captureSpy.mockRestore();
  });

  it("surfaces the INCOHERENT_DIFF bail to Sentry as a review failure (stale-head review)", async () => {
    const adv = advisory();
    // Both reviewers return the INCOHERENT_DIFF assessment — the diff is out of sync with the PR head, so each
    // opinion parses to null → the combiner yields `inconclusive`, the same review-failure path as a missing opinion.
    const incoherent = JSON.stringify({ assessment: INCOHERENT_DIFF_ASSESSMENT, blockers: [], nits: [], suggestions: [] });
    const env = aiEnv((async () => ({ response: incoherent })) as unknown as () => Promise<unknown>);
    const captureSpy = vi.spyOn(sentryModule, "captureReviewFailure");
    await runAiReviewForAdvisory(env, {
      mode: "live",
      settings: { aiReviewMode: "block" } as RepositorySettings,
      advisory: adv,
      repoFullName: "acme/widgets",
      pr,
      author: "alice",
      confirmedContributor: true,
    });
    expect(adv.findings.map((f) => f.code)).toEqual(["ai_review_inconclusive"]);
    expect(captureSpy).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ reason: "ai_review_inconclusive", repo: "acme/widgets", head_sha: "sha3" }), "ai_review_inconclusive");
    captureSpy.mockRestore();
  });

  it("appends an ai_review_split finding (lone-blocker HOLD) when the two block-mode reviewers disagree", async () => {
    const adv = advisory();
    // Both opinions parse, but only the FIRST reviewer names a blocker → consensus needs BOTH → no defect → split
    // (reviewbot's quorum: a lone rejection holds the PR). The split finding must be both applied to the advisory
    // AND round-tripped on the returned cache payload so a cache hit can replay this blocker (#ai-review-split).
    const run = (async (model: string) => ({ response: model === BEST_REVIEW_MODELS[0] ? defectJson() : notesOnlyJson() })) as unknown as () => Promise<unknown>;
    const result = await runAiReviewForAdvisory(aiEnv(run), {
      mode: "live",
      settings: { aiReviewMode: "block" } as RepositorySettings,
      advisory: adv,
      repoFullName: "acme/widgets",
      pr,
      author: "alice",
      confirmedContributor: true,
    });
    expect(adv.findings.map((f) => f.code)).toEqual(["ai_review_split"]); // applied to the advisory (gate blocker)
    expect(result?.findings.map((f) => f.code)).toEqual(["ai_review_split"]); // returned for the AI cache to persist
    expect(result?.notes).toBeDefined();
  });

  it("threads the lone flagging reviewer's calibrated confidence onto the ai_review_split finding (#8)", async () => {
    const adv = advisory();
    // Only the FIRST reviewer flags a blocker, at confidence 0.45 → split, and the finding carries 0.45.
    const flagged = JSON.stringify({ assessment: "Likely crash.", blockers: ["Null deref in src/a.ts."], nits: [], suggestions: [], confidence: 0.45 });
    const run = (async (model: string) => ({ response: model === BEST_REVIEW_MODELS[0] ? flagged : notesOnlyJson() })) as unknown as () => Promise<unknown>;
    await runAiReviewForAdvisory(aiEnv(run), {
      mode: "live",
      settings: { aiReviewMode: "block" } as RepositorySettings,
      advisory: adv,
      repoFullName: "acme/widgets",
      pr,
      author: "alice",
      confirmedContributor: true,
    });
    expect(adv.findings[0]?.code).toBe("ai_review_split");
    expect(adv.findings[0]?.confidence).toBe(0.45);
  });

  it("uses the caller's pre-resolved files (FIX B) instead of the stored read, so the model sees the real diff", async () => {
    // FIX B: the processor passes `files` (its resolvePullRequestFilesForReview output). With no rows ever
    // written to the test DB, a stored read would yield an EMPTY diff; passing files proves the model gets the
    // real diff anyway — the diff-less-first-review failure mode.
    const prompts: string[] = [];
    const env = aiEnv(async (...args: unknown[]) => {
      prompts.push(JSON.stringify(args));
      return { response: notesOnlyJson() };
    });
    const result = await runAiReviewForAdvisory(env, {
      mode: "live",
      settings: { aiReviewMode: "advisory" } as RepositorySettings,
      advisory: advisory(),
      repoFullName: "acme/widgets",
      pr,
      author: "alice",
      confirmedContributor: true,
      files: [fileRecord({ path: "src/resolved.ts", status: "modified", payload: { patch: "@@\n+const fixed = true;" } })],
    });
    expect(result?.notes).toContain("Looks fine.");
    // The pre-resolved file's path + patch reached the model prompt (i.e. the diff was non-empty).
    expect(prompts.join("\n")).toContain("src/resolved.ts");
    expect(prompts.join("\n")).toContain("const fixed = true;");
  });

  it("does not apply review.exclude_paths to block-mode gate-relevant AI consensus", async () => {
    const prompts: string[] = [];
    const env = aiEnv(async (...args: unknown[]) => {
      const prompt = JSON.stringify(args);
      prompts.push(prompt);
      return { response: prompt.includes("VALIDATION_VULN_MARKER") ? defectJson() : notesOnlyJson() };
    });
    const adv = advisory();

    await runAiReviewForAdvisory(env, {
      mode: "live",
      settings: { aiReviewMode: "block" } as RepositorySettings,
      advisory: adv,
      repoFullName: "acme/widgets",
      pr,
      author: "alice",
      confirmedContributor: true,
      files: [fileRecord({ path: "src/generated/vulnerable.generated.ts", status: "modified", payload: { patch: "@@\n+const marker = 'VALIDATION_VULN_MARKER';" } })],
      reviewExcludePaths: ["src/generated/**"],
    });

    expect(prompts.join("\n")).toContain("VALIDATION_VULN_MARKER");
    expect(adv.findings.map((f) => f.code)).toEqual(["ai_consensus_defect"]);
  });

  it("still applies review.exclude_paths to advisory-mode prose", async () => {
    const prompts: string[] = [];
    const env = aiEnv(async (...args: unknown[]) => {
      prompts.push(JSON.stringify(args));
      return { response: notesOnlyJson() };
    });

    await runAiReviewForAdvisory(env, {
      mode: "live",
      settings: { aiReviewMode: "advisory" } as RepositorySettings,
      advisory: advisory(),
      repoFullName: "acme/widgets",
      pr,
      author: "alice",
      confirmedContributor: true,
      files: [
        fileRecord({ path: "src/generated/skipped.generated.ts", status: "modified", payload: { patch: "@@\n+const skipped = true;" } }),
        fileRecord({ path: "src/reviewed.ts", status: "modified", payload: { patch: "@@\n+const reviewed = true;" } }),
      ],
      reviewExcludePaths: ["src/generated/**"],
    });

    const prompt = prompts.join("\n");
    expect(prompt).toContain("src/reviewed.ts");
    expect(prompt).toContain("const reviewed = true");
    expect(prompt).not.toContain("src/generated/skipped.generated.ts");
    expect(prompt).not.toContain("const skipped = true");
  });

  it("does not apply review.path_filters to block-mode gate-relevant AI consensus", async () => {
    const prompts: string[] = [];
    const env = aiEnv(async (...args: unknown[]) => {
      const prompt = JSON.stringify(args);
      prompts.push(prompt);
      return { response: prompt.includes("PATH_FILTER_MARKER") ? defectJson() : notesOnlyJson() };
    });

    await runAiReviewForAdvisory(env, {
      mode: "live",
      settings: { aiReviewMode: "block" } as RepositorySettings,
      advisory: advisory(),
      repoFullName: "acme/widgets",
      pr,
      author: "alice",
      confirmedContributor: true,
      files: [fileRecord({ path: "docs/out-of-scope.md", status: "modified", payload: { patch: "@@\n+const marker = 'PATH_FILTER_MARKER';" } })],
      reviewPathFilters: ["src/**"],
    });

    expect(prompts.join("\n")).toContain("PATH_FILTER_MARKER");
  });

  it("still applies review.path_filters to advisory-mode prose after exclude_paths", async () => {
    const prompts: string[] = [];
    const env = aiEnv(async (...args: unknown[]) => {
      prompts.push(JSON.stringify(args));
      return { response: notesOnlyJson() };
    });

    await runAiReviewForAdvisory(env, {
      mode: "live",
      settings: { aiReviewMode: "advisory" } as RepositorySettings,
      advisory: advisory(),
      repoFullName: "acme/widgets",
      pr,
      author: "alice",
      confirmedContributor: true,
      files: [
        fileRecord({ path: "src/generated/skipped.ts", status: "modified", payload: { patch: "@@\n+const generated = true;" } }),
        fileRecord({ path: "src/reviewed.ts", status: "modified", payload: { patch: "@@\n+const reviewed = true;" } }),
        fileRecord({ path: "docs/readme.md", status: "modified", payload: { patch: "@@\n+const docs = true;" } }),
      ],
      reviewExcludePaths: ["src/generated/**"],
      reviewPathFilters: ["src/**"],
    });

    const prompt = prompts.join("\n");
    expect(prompt).toContain("src/reviewed.ts");
    expect(prompt).toContain("const reviewed = true");
    expect(prompt).not.toContain("src/generated/skipped.ts");
    expect(prompt).not.toContain("docs/readme.md");
  });

  it("returns advisory notes without a finding in advisory mode", async () => {
    const adv = advisory();
    const result = await runAiReviewForAdvisory(aiEnv(async () => ({ response: notesOnlyJson() })), {
      mode: "live",
      settings: { aiReviewMode: "advisory" } as RepositorySettings,
      advisory: adv,
      repoFullName: "acme/widgets",
      pr,
      author: "alice",
      confirmedContributor: true,
    });
    expect(adv.findings).toEqual([]);
    expect(result?.notes).toContain("Add a test.");
  });

  it("#4744: threads improvementSignal into the model call and surfaces the composed valueAssessment when requested", async () => {
    const adv = advisory();
    const result = await runAiReviewForAdvisory(aiEnv(async () => ({ response: notesWithValueAssessmentJson() })), {
      mode: "live",
      settings: { aiReviewMode: "advisory" } as RepositorySettings,
      advisory: adv,
      repoFullName: "acme/widgets",
      pr,
      author: "alice",
      confirmedContributor: true,
      improvementSignal: true,
    });
    expect(result?.valueAssessment).toEqual({
      magnitude: "moderate",
      rationale: "This meaningfully simplifies the retry logic.",
    });
  });

  it("#4744: omits valueAssessment when the caller does not resolve improvementSignal on, even if the model returned one", async () => {
    const adv = advisory();
    const result = await runAiReviewForAdvisory(aiEnv(async () => ({ response: notesWithValueAssessmentJson() })), {
      mode: "live",
      settings: { aiReviewMode: "advisory" } as RepositorySettings,
      advisory: adv,
      repoFullName: "acme/widgets",
      pr,
      author: "alice",
      confirmedContributor: true,
      // improvementSignal omitted (the default, and every caller until this PR) -- the prompt never asked for
      // the field, so runGittensoryAiReview never composes it regardless of what the raw model JSON contains.
    });
    expect(result?.valueAssessment).toBeUndefined();
  });

  it("returns undefined (no notes, no finding) when AI is disabled", async () => {
    const adv = advisory();
    const result = await runAiReviewForAdvisory(aiEnv(async () => ({ response: defectJson() }), false), {
      mode: "live",
      settings: { aiReviewMode: "block" } as RepositorySettings,
      advisory: adv,
      repoFullName: "acme/widgets",
      pr,
      author: "alice",
      confirmedContributor: true,
    });
    expect(result).toBeUndefined();
    expect(adv.findings).toEqual([]);
  });

  it("holds for manual review when the AI provider produces no public notes", async () => {
    const adv = advisory();
    const captureSpy = vi.spyOn(sentryModule, "captureReviewFailure");
    const result = await runAiReviewForAdvisory(aiEnv(async () => ({ response: "" })), {
      mode: "live",
      settings: { aiReviewMode: "advisory" } as RepositorySettings,
      advisory: adv,
      repoFullName: "acme/widgets",
      pr,
      author: "alice",
      confirmedContributor: true,
    });
    expect(result).toMatchObject({
      reviewerCount: 0,
      cacheable: false,
      findings: [
        expect.objectContaining({ code: "ai_review_inconclusive" }),
      ],
    });
    expect(result?.notes).toContain("AI review is unavailable");
    expect(adv.findings.map((f) => f.code)).toEqual([
      "ai_review_inconclusive",
    ]);
    expect(captureSpy).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        reason: "ai_review_public_summary_missing",
        repo: "acme/widgets",
        pr: 3,
        head_sha: "sha3",
        reviewer_count: 0,
      }),
      "ai_review_public_summary_missing",
    );
    captureSpy.mockRestore();
  });

  it("uses the non-cacheable block-mode inconclusive note when no reviewer returns public text", async () => {
    const adv = advisory();
    const result = await runAiReviewForAdvisory(aiEnv(async () => ({ response: "" })), {
      mode: "live",
      settings: { aiReviewMode: "block" } as RepositorySettings,
      advisory: adv,
      repoFullName: "acme/widgets",
      pr,
      author: "alice",
      confirmedContributor: true,
    });
    expect(result).toMatchObject({
      reviewerCount: 0,
      inlineFindings: [],
      cacheable: false,
      findings: [expect.objectContaining({ code: "ai_review_inconclusive" })],
    });
    expect(result?.notes).toContain("AI review could not be completed for this PR head");
    expect(adv.findings.map((f) => f.code)).toEqual(["ai_review_inconclusive"]);
  });

  it("#confirmed-bug: defers to an already-held AI review lock and never invokes the AI when another pass is in-flight for this exact head", async () => {
    const adv = advisory();
    let aiCalls = 0;
    const env = aiEnv(async () => {
      aiCalls += 1;
      return { response: notesOnlyJson() };
    });
    // Simulate a webhook pass already in-flight for this exact (repo, PR, head, mode) tuple — the caller under
    // test (a sweep-shaped pass, say) must defer instead of racing it with a second, independently-decided
    // LLM call.
    expect((await claimAiReviewLock(env, "acme/widgets", 3, "sha3", "block")).acquired).toBe(true);

    const result = await runAiReviewForAdvisory(env, {
      mode: "live",
      settings: { aiReviewMode: "block" } as RepositorySettings,
      advisory: adv,
      repoFullName: "acme/widgets",
      pr,
      author: "alice",
      confirmedContributor: true,
    });

    expect(aiCalls).toBe(0); // the AI mock was never invoked — the lock short-circuited before the LLM call
    expect(result).toMatchObject({
      reviewerCount: 0,
      inlineFindings: [],
      cacheable: false,
      findings: [expect.objectContaining({ code: "ai_review_inconclusive" })],
    });
    expect(result?.notes).toContain("AI review is already running for this PR head in another Gittensory pass");
    expect(adv.findings.map((f) => f.code)).toEqual(["ai_review_inconclusive"]);
  });

  it("withholds unstructured AI text while holding the PR for manual review", async () => {
    const adv = advisory();
    const result = await runAiReviewForAdvisory(aiEnv(async () => ({ response: "Looks coherent, but please verify the new cache branch before merging." })), {
      mode: "live",
      settings: { aiReviewMode: "advisory" } as RepositorySettings,
      advisory: adv,
      repoFullName: "acme/widgets",
      pr,
      author: "alice",
      confirmedContributor: true,
    });
    expect(result?.reviewerCount).toBe(0);
    expect(result?.notes).toContain("AI review could not be completed for this PR head");
    expect(result?.notes).not.toContain("Looks coherent");
    expect(adv.findings.map((f) => f.code)).toEqual(["ai_review_inconclusive"]);
  });

  it("preserves model nits when the model omits the assessment summary", async () => {
    const result = await runAiReviewForAdvisory(aiEnv(async () => ({ response: nitsWithoutAssessmentJson() })), {
      mode: "live",
      settings: { aiReviewMode: "advisory" } as RepositorySettings,
      advisory: advisory(),
      repoFullName: "acme/widgets",
      pr,
      author: "alice",
      confirmedContributor: true,
    });
    expect(result?.notes).toContain("did not include a separate narrative summary");
    expect(result?.notes).toContain("Add a test.");
  });

  it("does not use the maintainer's BYOK key for non-confirmed oss-anti-slop blocking reviews", async () => {
    const run = vi.fn(async () => ({ response: defectJson() }));
    const env = createTestEnv({
      AI: { run } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "100000",
      TOKEN_ENCRYPTION_SECRET: "advisory-test-encryption-secret-32bytes",
    });
    await upsertRepositoryAiKey(env, { repoFullName: "acme/widgets", provider: "anthropic", key: "sk-ant-byok-key-9999", model: null });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ content: [{ type: "text", text: notesOnlyJson() }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const adv = advisory();

    const result = await runAiReviewForAdvisory(env, {
      mode: "live",
      settings: { aiReviewMode: "block", gatePack: "oss-anti-slop", aiReviewByok: true } as RepositorySettings,
      advisory: adv,
      repoFullName: "acme/widgets",
      pr,
      author: "alice",
      confirmedContributor: false,
    });

    expect(result?.notes).toContain("Likely crash.");
    expect(adv.findings.map((f) => f.code)).toEqual(["ai_consensus_defect"]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalled();
  });

  it("uses the maintainer's BYOK provider key when aiReviewByok is on and a key is configured", async () => {
    const env = createTestEnv({
      AI: { run: async () => ({ response: notesOnlyJson() }) } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "100000",
      TOKEN_ENCRYPTION_SECRET: "advisory-test-encryption-secret-32bytes",
    });
    await upsertRepositoryAiKey(env, { repoFullName: "acme/widgets", provider: "anthropic", key: "sk-ant-byok-key-9999", model: null });
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ content: [{ type: "text", text: notesOnlyJson() }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await runAiReviewForAdvisory(env, {
      mode: "live",
      settings: { aiReviewMode: "advisory", aiReviewByok: true } as RepositorySettings,
      advisory: advisory(),
      repoFullName: "acme/widgets",
      pr,
      author: "alice",
      confirmedContributor: true,
    });
    expect(result?.notes).toContain("Add a test.");
    // Advisory write-up went to the BYOK provider, not Workers AI.
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.anthropic.com/v1/messages");
  });

  it("applies the config-as-code model override and sends it to the provider", async () => {
    const env = createTestEnv({ AI: { run: async () => ({ response: notesOnlyJson() }) } as unknown as Ai, AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true", AI_DAILY_NEURON_BUDGET: "100000", TOKEN_ENCRYPTION_SECRET: "advisory-test-encryption-secret-32bytes" });
    await upsertRepositoryAiKey(env, { repoFullName: "acme/widgets", provider: "anthropic", key: "sk-ant-byok-key-9999", model: "claude-stored" });
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ content: [{ type: "text", text: notesOnlyJson() }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await runAiReviewForAdvisory(env, {
      mode: "live",
      settings: { aiReviewMode: "advisory", aiReviewByok: true, aiReviewProvider: "anthropic", aiReviewModel: "claude-from-yml" } as RepositorySettings,
      advisory: advisory(),
      repoFullName: "acme/widgets",
      pr,
      author: "alice",
      confirmedContributor: true,
    });
    // The yml model override wins over the stored key's model.
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)).model).toBe("claude-from-yml");
  });

  it("skips BYOK (falls back to Workers AI) when the declared provider doesn't match the stored key", async () => {
    const run = vi.fn(async () => ({ response: notesOnlyJson() }));
    const env = createTestEnv({ AI: { run } as unknown as Ai, AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true", AI_DAILY_NEURON_BUDGET: "100000", TOKEN_ENCRYPTION_SECRET: "advisory-test-encryption-secret-32bytes" });
    await upsertRepositoryAiKey(env, { repoFullName: "acme/widgets", provider: "anthropic", key: "sk-ant-byok-key-9999", model: null });
    const fetchMock = vi.fn(async () => new Response("should not be called", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await runAiReviewForAdvisory(env, {
      mode: "live",
      settings: { aiReviewMode: "advisory", aiReviewByok: true, aiReviewProvider: "openai" } as RepositorySettings, // declared openai, stored anthropic → mismatch
      advisory: advisory(),
      repoFullName: "acme/widgets",
      pr,
      author: "alice",
      confirmedContributor: true,
    });
    expect(result?.notes).toContain("Add a test."); // produced via Workers AI fallback
    expect(fetchMock).not.toHaveBeenCalled(); // no provider call
    expect(run).toHaveBeenCalled(); // Workers AI used instead
  });

  it("is fail-safe: a thrown error (e.g. broken DB) yields no finding and no notes", async () => {
    const adv = advisory();
    const env = aiEnv(async () => ({ response: defectJson() }));
    const result = await runAiReviewForAdvisory({ ...env, DB: undefined } as unknown as Env, {
      mode: "live",
      settings: { aiReviewMode: "block" } as RepositorySettings,
      advisory: adv,
      repoFullName: "acme/widgets",
      pr,
      author: "alice",
      confirmedContributor: true,
    });
    expect(result).toBeUndefined();
    expect(adv.findings).toEqual([]);
  });
});
