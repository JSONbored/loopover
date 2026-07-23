import { afterEach, describe, expect, it, vi } from "vitest";
import { runLoopOverLinkedIssueSatisfaction, type LinkedIssueSatisfactionRunInput } from "../../src/services/linked-issue-satisfaction-run";
import { MAX_BODY_CHARS, MAX_DIFF_CHARS, MAX_MODEL_RESPONSE_CHARS } from "../../src/services/linked-issue-satisfaction";
import { BEST_REVIEW_MODELS, RELIABLE_FALLBACK_MODELS } from "../../src/services/ai-review";
import { buildAiReviewDiff, processJob, runLinkedIssueSatisfactionForAdvisory } from "../../src/queue/processors";
import { evaluateGateCheck } from "../../src/rules/advisory";
import {
  getCachedLinkedIssueSatisfaction,
  putCachedLinkedIssueSatisfaction,
  recordAiUsageEvent,
  upsertRepositoryAiKey,
  upsertRepositoryFromGitHub,
  upsertRepositorySettings,
} from "../../src/db/repositories";
import { linkedIssueSatisfactionCacheInputFingerprint } from "../../src/review/linked-issue-satisfaction-cache-input";
import * as signalTrackingWire from "../../src/review/signal-tracking-wire";
import { createSignalStore } from "../../src/review/signal-tracking-wire";
import { clearInstallationTokenCacheForTest } from "../../src/github/app";
import { normalizeRegistryPayload } from "../../src/registry/normalize";
import { persistRegistrySnapshot } from "../../src/registry/sync";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import type { Advisory, PullRequestFileRecord, RepositorySettings } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

// Split so the literal PEM marker text never appears contiguous in source -- the review-safety secrets
// scanner's private_key_block pattern is a pure text match with no awareness that the bytes between these
// markers are freshly generated per test run, not a real credential (src/review/safety.ts). Mirrors the
// identical helper duplicated across other test files (e.g. test/unit/queue.test.ts).
const PEM_HEADER = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
const PEM_FOOTER = ["-----END", "PRIVATE KEY-----"].join(" ");

async function generatePrivateKeyPem(): Promise<string> {
  const key = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const exported = await crypto.subtle.exportKey("pkcs8", key.privateKey);
  const base64 = Buffer.from(exported as ArrayBuffer)
    .toString("base64")
    .replace(/(.{64})/g, "$1\n");
  return `${PEM_HEADER}\n${base64}\n${PEM_FOOTER}`;
}

function satisfactionJson(over: Partial<{ status: string; rationale: string; confidence: number }> = {}): string {
  return JSON.stringify({
    status: over.status ?? "addressed",
    rationale: over.rationale ?? "The diff adds the requested endpoint and matches the issue's acceptance criteria.",
    confidence: over.confidence ?? 0.9,
  });
}

const baseInput: LinkedIssueSatisfactionRunInput = {
  repoFullName: "acme/widgets",
  prNumber: 7,
  issueText: "Title: Add SSE stream\n\nWe need a live SSE stream surface.",
  prTitle: "Add SSE stream endpoint",
  prBody: "Implements the requested SSE stream.",
  diff: "### src/a.ts (modified) +40/-2\n@@\n+app.get('/stream', sse);",
  actor: "alice",
};

const enabledEnv = (run: unknown) =>
  createTestEnv({
    AI: { run } as unknown as Ai,
    AI_SUMMARIES_ENABLED: "true",
    AI_PUBLIC_COMMENTS_ENABLED: "true",
    AI_DAILY_NEURON_BUDGET: "100000",
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runLoopOverLinkedIssueSatisfaction gating + fail-safe", () => {
  it("is disabled when AI_SUMMARIES_ENABLED itself is unset (the FIRST gate, not just the second)", async () => {
    const run = vi.fn();
    const env = createTestEnv({ AI: { run } as unknown as Ai, AI_PUBLIC_COMMENTS_ENABLED: "true" });
    await expect(runLoopOverLinkedIssueSatisfaction(env, baseInput)).resolves.toMatchObject({ status: "disabled", reason: "AI summaries are disabled." });
    expect(run).not.toHaveBeenCalled();
  });

  it("is disabled until both AI flags are on, and never calls the model", async () => {
    const run = vi.fn();
    const env = createTestEnv({ AI: { run } as unknown as Ai, AI_SUMMARIES_ENABLED: "true" });
    await expect(runLoopOverLinkedIssueSatisfaction(env, baseInput)).resolves.toMatchObject({ status: "disabled" });
    expect(run).not.toHaveBeenCalled();
  });

  it("reports unavailable when the Workers AI binding is missing", async () => {
    const env = createTestEnv({ AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true" });
    await expect(runLoopOverLinkedIssueSatisfaction(env, baseInput)).resolves.toMatchObject({ status: "unavailable" });
  });

  it("short-circuits to ok/null with zero spend when there is no issue text (fail-safe, mirrors the pure module's own contract)", async () => {
    const run = vi.fn();
    const env = enabledEnv(run);
    const result = await runLoopOverLinkedIssueSatisfaction(env, { ...baseInput, issueText: "   " });
    expect(result).toEqual({ status: "ok", result: null, estimatedNeurons: 0 });
    expect(run).not.toHaveBeenCalled();
  });

  it("treats an absent issueText (undefined) the same as blank", async () => {
    const run = vi.fn();
    const env = enabledEnv(run);
    const result = await runLoopOverLinkedIssueSatisfaction(env, { ...baseInput, issueText: undefined });
    expect(result).toEqual({ status: "ok", result: null, estimatedNeurons: 0 });
    expect(run).not.toHaveBeenCalled();
  });

  it("enforces the shared daily neuron budget before calling the model", async () => {
    const run = vi.fn();
    const env = createTestEnv({ AI: { run } as unknown as Ai, AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true", AI_DAILY_NEURON_BUDGET: "1" });
    const result = await runLoopOverLinkedIssueSatisfaction(env, baseInput);
    expect(result).toMatchObject({ status: "quota_exceeded" });
    expect(run).not.toHaveBeenCalled();
  });

  it("draws from the SAME shared daily neuron counter as ai_review/ai_slop (no per-feature budget)", async () => {
    const run = vi.fn(async () => ({ response: satisfactionJson() }));
    const env = createTestEnv({ AI: { run } as unknown as Ai, AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true", AI_DAILY_NEURON_BUDGET: "2000000" });
    await recordAiUsageEvent(env, { feature: "ai_slop_pr", model: "m", status: "ok", estimatedNeurons: 1_999_999 });
    const result = await runLoopOverLinkedIssueSatisfaction(env, baseInput);
    expect(result.status).toBe("quota_exceeded");
    expect(run).not.toHaveBeenCalled();
  });

  it("degrades to no result when env.AI is present but not a valid runner (no .run function)", async () => {
    const env = createTestEnv({ AI: {} as unknown as Ai, AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true", AI_DAILY_NEURON_BUDGET: "100000" });
    const result = await runLoopOverLinkedIssueSatisfaction(env, baseInput);
    expect(result).toMatchObject({ status: "ok", result: null });
  });

  it("returns the parsed, public-safe result when the model responds well", async () => {
    const run = vi.fn(async () => ({ response: satisfactionJson({ status: "addressed" }) }));
    const result = await runLoopOverLinkedIssueSatisfaction(enabledEnv(run), baseInput);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.result).toMatchObject({ status: "addressed" });
    expect(result.estimatedNeurons).toBeGreaterThan(0);
  });

  it("also returns the model's own raw response text alongside the parsed result (#8139)", async () => {
    const modelJson = satisfactionJson({ status: "addressed" });
    const run = vi.fn(async () => ({ response: modelJson }));
    const result = await runLoopOverLinkedIssueSatisfaction(enabledEnv(run), baseInput);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.rawModelText).toBe(modelJson);
  });

  it("omits rawModelText (never a stray empty string) when no attempt produces a usable result (#8139)", async () => {
    const run = vi.fn(async () => ({ response: "not json" }));
    const result = await runLoopOverLinkedIssueSatisfaction(enabledEnv(run), baseInput);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.result).toBeNull();
    expect(result.rawModelText).toBeUndefined();
  });

  it("records the pre-budgeted retry/fallback estimate under the linked_issue_satisfaction feature", async () => {
    const run = vi.fn(async () => ({ response: "not json" }));
    const env = enabledEnv(run);
    const result = await runLoopOverLinkedIssueSatisfaction(env, baseInput);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(run).toHaveBeenCalledTimes(6);
    const row = await env.DB.prepare("select estimated_neurons, feature, route from ai_usage_events where feature = ? order by rowid desc limit 1")
      .bind("linked_issue_satisfaction")
      .first<{ estimated_neurons: number; feature: string; route: string }>();
    expect(row?.estimated_neurons).toBe(result.estimatedNeurons);
    expect(row?.route).toBe("github_app.linked_issue_satisfaction");
  });

  it("CONFIDENCE FLOOR: a below-floor 'unaddressed' on every attempt degrades to no result, never a shaky block signal", async () => {
    const run = vi.fn(async () => ({ response: satisfactionJson({ status: "unaddressed", confidence: 0.2 }) }));
    const result = await runLoopOverLinkedIssueSatisfaction(enabledEnv(run), baseInput);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.result).toBeNull();
    expect(run).toHaveBeenCalledTimes(6); // exhausted every retry/fallback attempt
  });

  it("CONFIDENCE FLOOR: retries past an early below-floor 'unaddressed' and accepts a later above-floor call", async () => {
    let call = 0;
    const run = vi.fn(async () => {
      call += 1;
      return { response: call < 3 ? satisfactionJson({ status: "unaddressed", confidence: 0.1 }) : satisfactionJson({ status: "unaddressed", confidence: 0.9 }) };
    });
    const result = await runLoopOverLinkedIssueSatisfaction(enabledEnv(run), baseInput);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.result).toMatchObject({ status: "unaddressed", confidence: 0.9 });
  });

  it("addressed/partial verdicts are never floor-gated, even at zero confidence", async () => {
    const run = vi.fn(async () => ({ response: satisfactionJson({ status: "partial", confidence: 0 }) }));
    const result = await runLoopOverLinkedIssueSatisfaction(enabledEnv(run), baseInput);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.result).toMatchObject({ status: "partial" });
    expect(run).toHaveBeenCalledTimes(1); // no retry needed — not floor-gated
  });

  it("is fail-safe: a throwing model yields ok with no result (never throws)", async () => {
    const run = vi.fn(async () => {
      throw new Error("model exploded");
    });
    const result = await runLoopOverLinkedIssueSatisfaction(enabledEnv(run), baseInput);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.result).toBeNull();
    expect(run).toHaveBeenCalled();
  });

  it("REGRESSION (#5385-sentry, GITTENSORY-K/8): stops retrying a model after ONE 429 rate-limit error instead of burning its full attempt budget", async () => {
    const run = vi.fn(async () => {
      throw new Error("claude_code_error_429");
    });
    const result = await runLoopOverLinkedIssueSatisfaction(enabledEnv(run), baseInput);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.result).toBeNull();
    expect(run).toHaveBeenCalledTimes(2); // 1 attempt per model (2 models), not the full 6-call budget
  });

  it("falls back to the reliable model when the primary keeps returning garbage", async () => {
    const run = vi.fn(async (model: string) => ({ response: model.includes("gpt-oss") ? "not json" : satisfactionJson({ status: "partial" }) }));
    const result = await runLoopOverLinkedIssueSatisfaction(enabledEnv(run), baseInput);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.result).toMatchObject({ status: "partial" });
  });

  it("enforces the shared BYOK daily repo cap before any provider call", async () => {
    const run = vi.fn();
    const env = createTestEnv({ AI: { run } as unknown as Ai, AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true", AI_DAILY_NEURON_BUDGET: "1", AI_BYOK_DAILY_REPO_LIMIT: "1" });
    await recordAiUsageEvent(env, { feature: "ai_review_pr", actor: null, route: "x", model: "byok:anthropic", status: "ok", estimatedNeurons: 1, detail: "seed", metadata: { repoFullName: baseInput.repoFullName } });
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await runLoopOverLinkedIssueSatisfaction(env, { ...baseInput, providerKey: { provider: "anthropic", key: "sk-ant-x" } });
    expect(result.status).toBe("quota_exceeded");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("records real BYOK usage (tokens + cost) on the durable audit row", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ content: [{ type: "text", text: satisfactionJson({ status: "addressed" }) }], usage: { input_tokens: 400, output_tokens: 40 } }), { status: 200 })),
    );
    const env = enabledEnv(vi.fn());
    const result = await runLoopOverLinkedIssueSatisfaction(env, { ...baseInput, providerKey: { provider: "anthropic", key: "sk-ant-x", model: "claude-sonnet-5" } });
    expect(result.status).toBe("ok");
    const row = await env.DB.prepare(`select provider, input_tokens, output_tokens, total_tokens from ai_usage_events where feature = ? order by rowid desc limit 1`)
      .bind("linked_issue_satisfaction")
      .first<{ provider: string | null; input_tokens: number; output_tokens: number; total_tokens: number }>();
    expect(row).toMatchObject({ provider: "anthropic", input_tokens: 400, output_tokens: 40, total_tokens: 440 });
  });

  it("defaults the budget HIGH (10M) when AI_DAILY_NEURON_BUDGET is unset/invalid — no starvation", async () => {
    const run = vi.fn(async () => ({ response: satisfactionJson({ status: "addressed" }) }));
    const env = createTestEnv({ AI: { run } as unknown as Ai, AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true", AI_DAILY_NEURON_BUDGET: "" });
    // 2M prior spend — over any tiny fallback but well under the 10M default the fix uses.
    await recordAiUsageEvent(env, { feature: "ai_review", model: "m", status: "ok", estimatedNeurons: 2_000_000 });
    const result = await runLoopOverLinkedIssueSatisfaction(env, baseInput);
    expect(result.status).not.toBe("quota_exceeded");
    expect(run).toHaveBeenCalled();
  });

  it("passes the configured AI_GATEWAY_ID through to the Workers AI call", async () => {
    const run = vi.fn(async (_model: string, _options: unknown, extra?: { gateway?: { id: string } }) => {
      expect(extra).toEqual({ gateway: { id: "my-gateway" } });
      return { response: satisfactionJson({ status: "addressed" }) };
    });
    const env = createTestEnv({ AI: { run } as unknown as Ai, AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true", AI_DAILY_NEURON_BUDGET: "100000", AI_GATEWAY_ID: "my-gateway" });
    const result = await runLoopOverLinkedIssueSatisfaction(env, baseInput);
    expect(result.status).toBe("ok");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("degrades to no result when the BYOK provider returns no usable text (empty/falsy)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ content: [{ type: "text", text: "" }] }), { status: 200 })));
    const env = enabledEnv(vi.fn());
    const result = await runLoopOverLinkedIssueSatisfaction(env, { ...baseInput, providerKey: { provider: "anthropic", key: "sk-ant-x" } });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.result).toBeNull();
  });

  it("records the REAL reported model, not the hardcoded fallback label, when the provider reports one (2026-07 fix)", async () => {
    const run = vi.fn(async () => ({ response: satisfactionJson({ status: "addressed" }), usage: { provider: "ollama", model: "qwen3:8b" } }));
    const env = enabledEnv(run);
    const result = await runLoopOverLinkedIssueSatisfaction(env, baseInput);
    expect(result.status).toBe("ok");
    const row = await env.DB.prepare("select model, provider from ai_usage_events where feature = ? order by rowid desc limit 1")
      .bind("linked_issue_satisfaction")
      .first<{ model: string; provider: string | null }>();
    expect(row).toMatchObject({ model: "qwen3:8b", provider: "ollama" });
  });

  it("falls back to the hardcoded model label when the provider reports no usage/model at all", async () => {
    const run = vi.fn(async () => ({ response: satisfactionJson({ status: "addressed" }) }));
    const env = enabledEnv(run);
    const result = await runLoopOverLinkedIssueSatisfaction(env, baseInput);
    expect(result.status).toBe("ok");
    const row = await env.DB.prepare("select model from ai_usage_events where feature = ? order by rowid desc limit 1")
      .bind("linked_issue_satisfaction")
      .first<{ model: string }>();
    expect(row?.model).toBe([BEST_REVIEW_MODELS[0], RELIABLE_FALLBACK_MODELS[0]].join("+"));
  });

  it("records a null actor as null (not undefined) when the caller omits it", async () => {
    const run = vi.fn(async () => ({ response: satisfactionJson({ status: "addressed" }) }));
    const env = enabledEnv(run);
    const { actor: _omit, ...withoutActor } = baseInput;
    await runLoopOverLinkedIssueSatisfaction(env, withoutActor);
    const row = await env.DB.prepare("select actor from ai_usage_events where feature = ? order by rowid desc limit 1")
      .bind("linked_issue_satisfaction")
      .first<{ actor: string | null }>();
    expect(row?.actor).toBeNull();
  });
});

describe("runLinkedIssueSatisfactionForAdvisory (processor wiring, #1961/#3906)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearInstallationTokenCacheForTest();
  });

  function advisory(over: Partial<Advisory> = {}): Advisory {
    return {
      id: "adv-satisfaction",
      targetType: "pull_request",
      targetKey: "acme/widgets#7",
      repoFullName: "acme/widgets",
      pullNumber: 7,
      headSha: "sha7",
      conclusion: "neutral",
      severity: "info",
      title: "LoopOver advisory available",
      summary: "ok",
      findings: [],
      generatedAt: "2026-07-07T00:00:00.000Z",
      ...over,
    };
  }

  const files: PullRequestFileRecord[] = [
    { repoFullName: "acme/widgets", pullNumber: 7, path: "src/a.ts", status: "modified", additions: 40, deletions: 2, changes: 42, payload: { patch: "@@\n+app.get('/stream', sse);" } },
  ];
  const pr = { number: 7, title: "Add SSE stream endpoint", body: "Implements the requested SSE stream.", linkedIssues: [1275] };
  const issueText = "Enrich SN74 Gittensor — add SSE stream\n\nWe need a live SSE stream surface for SN74 Gittensor.";
  const processorFingerprint = () =>
    linkedIssueSatisfactionCacheInputFingerprint({ byok: false, provider: null, model: null, issueText, prTitle: pr.title, prBody: pr.body, diff: buildAiReviewDiff(files) });
  const advisoryMode = { linkedIssueSatisfactionGateMode: "advisory", aiReviewByok: false } as RepositorySettings;
  const blockMode = { linkedIssueSatisfactionGateMode: "block", aiReviewByok: false } as RepositorySettings;

  function stubFetch(handler: (url: string) => Response | Promise<Response>): void {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => handler(input.toString()));
  }

  function stubIssueFetch(issue: { title?: string; body?: string; state?: string } = {}): void {
    stubFetch((url) => {
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/issues/1275")) return Response.json({ number: 1275, state: issue.state ?? "open", title: issue.title ?? "Enrich SN74 Gittensor — add SSE stream", body: issue.body ?? "We need a live SSE stream surface for SN74 Gittensor." });
      return new Response("not found", { status: 404 });
    });
  }

  it("no-ops (returns null) for an unconfirmed contributor — no fetch, no model spend", async () => {
    stubIssueFetch();
    const run = vi.fn();
    const adv = advisory();
    const result = await runLinkedIssueSatisfactionForAdvisory(enabledEnv(run), { mode: "live", settings: advisoryMode, advisory: adv, repoFullName: "acme/widgets", pr, author: "mallory", files, confirmedContributor: false, installationId: 1 });
    expect(result).toBeNull();
    expect(run).not.toHaveBeenCalled();
    expect(adv.findings).toEqual([]);
  });

  it("REGRESSION (#token-bleed-spend-gate): a paused mode never reaches the LLM call, even for a confirmed contributor", async () => {
    stubIssueFetch();
    const run = vi.fn();
    const adv = advisory();
    const result = await runLinkedIssueSatisfactionForAdvisory(enabledEnv(run), { mode: "paused", settings: advisoryMode, advisory: adv, repoFullName: "acme/widgets", pr, author: "alice", files, confirmedContributor: true, installationId: 1 });
    expect(result).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("no-ops when the advisory has no head SHA", async () => {
    stubIssueFetch();
    const noSha = advisory();
    delete (noSha as Partial<Advisory>).headSha;
    const run = vi.fn();
    const result = await runLinkedIssueSatisfactionForAdvisory(enabledEnv(run), { mode: "live", settings: advisoryMode, advisory: noSha, repoFullName: "acme/widgets", pr, author: "alice", files, confirmedContributor: true, installationId: 1 });
    expect(result).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("no-ops when the PR has no linked issues (defense-in-depth; the call site itself also gates on this)", async () => {
    const run = vi.fn();
    const env = enabledEnv(run);
    vi.stubGlobal("fetch", vi.fn());
    const adv = advisory();
    const result = await runLinkedIssueSatisfactionForAdvisory(env, { mode: "live", settings: advisoryMode, advisory: adv, repoFullName: "acme/widgets", pr: { ...pr, linkedIssues: [] }, author: "alice", files, confirmedContributor: true, installationId: 1 });
    expect(result).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("fetches the primary linked issue and returns the resolved status+rationale", async () => {
    stubIssueFetch();
    const run = vi.fn(async () => ({ response: satisfactionJson({ status: "addressed" }) }));
    const adv = advisory();
    const result = await runLinkedIssueSatisfactionForAdvisory(enabledEnv(run), { mode: "live", settings: advisoryMode, advisory: adv, repoFullName: "acme/widgets", pr, author: "alice", files, confirmedContributor: true, installationId: 1 });
    expect(result).toMatchObject({ status: "addressed" });
  });

  it("passes a nullish PR body through as undefined (not null) to the fresh assessment call on a cache miss", async () => {
    stubIssueFetch();
    const run = vi.fn(async () => ({ response: satisfactionJson({ status: "addressed" }) }));
    const adv = advisory();
    const { body: _omit, ...prWithoutBody } = pr;
    const result = await runLinkedIssueSatisfactionForAdvisory(enabledEnv(run), { mode: "live", settings: advisoryMode, advisory: adv, repoFullName: "acme/widgets", pr: prWithoutBody, author: "alice", files, confirmedContributor: true, installationId: 1 });
    expect(result).toMatchObject({ status: "addressed" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("returns null when the linked issue cannot be confirmed found (fetch_error/not_found)", async () => {
    stubFetch((url) => (url.includes("/access_tokens") ? Response.json({ token: "t" }) : new Response("missing", { status: 404 })));
    const run = vi.fn();
    const adv = advisory();
    const result = await runLinkedIssueSatisfactionForAdvisory(enabledEnv(run), { mode: "live", settings: advisoryMode, advisory: adv, repoFullName: "acme/widgets", pr, author: "alice", files, confirmedContributor: true, installationId: 1 });
    expect(result).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("returns null when the fetched issue has no usable title/body text", async () => {
    stubIssueFetch({ title: "", body: "" });
    const run = vi.fn();
    const adv = advisory();
    const result = await runLinkedIssueSatisfactionForAdvisory(enabledEnv(run), { mode: "live", settings: advisoryMode, advisory: adv, repoFullName: "acme/widgets", pr, author: "alice", files, confirmedContributor: true, installationId: 1 });
    expect(result).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("is fail-safe: a thrown error yields null and never throws", async () => {
    stubIssueFetch();
    const env = { ...enabledEnv(async () => ({ response: satisfactionJson() })), DB: undefined } as unknown as Env;
    const adv = advisory();
    await expect(
      runLinkedIssueSatisfactionForAdvisory(env, { mode: "live", settings: advisoryMode, advisory: adv, repoFullName: "acme/widgets", pr, author: "alice", files, confirmedContributor: true, installationId: 1 }),
    ).resolves.toBeNull();
    expect(adv.findings).toEqual([]);
  });

  describe("block mode gate wiring (metagraphed PR #3910 repro shape)", () => {
    it("BLOCK mode: an above-floor 'unaddressed' verdict pushes linked_issue_scope_mismatch AND the gate blocks", async () => {
      stubIssueFetch();
      const run = vi.fn(async () => ({ response: satisfactionJson({ status: "unaddressed", confidence: 0.9, rationale: "The linked issue asks for an SSE stream; this PR adds an unrelated REST endpoint." }) }));
      const adv = advisory();
      const result = await runLinkedIssueSatisfactionForAdvisory(enabledEnv(run), { mode: "live", settings: blockMode, advisory: adv, repoFullName: "acme/widgets", pr, author: "alice", files, confirmedContributor: true, installationId: 1 });

      expect(result).toMatchObject({ status: "unaddressed" });
      expect(adv.findings).toHaveLength(1);
      expect(adv.findings[0]).toMatchObject({ code: "linked_issue_scope_mismatch", severity: "warning" });

      const gate = evaluateGateCheck(adv, { linkedIssueSatisfactionGateMode: "block" });
      expect(gate.conclusion).toBe("failure");
      expect(gate.blockers.map((b) => b.code)).toContain("linked_issue_scope_mismatch");
    });

    it("ADVISORY mode: the SAME above-floor 'unaddressed' verdict renders (via the return value) but pushes NO finding and never blocks", async () => {
      stubIssueFetch();
      const run = vi.fn(async () => ({ response: satisfactionJson({ status: "unaddressed", confidence: 0.9 }) }));
      const adv = advisory();
      const result = await runLinkedIssueSatisfactionForAdvisory(enabledEnv(run), { mode: "live", settings: advisoryMode, advisory: adv, repoFullName: "acme/widgets", pr, author: "alice", files, confirmedContributor: true, installationId: 1 });

      expect(result).toMatchObject({ status: "unaddressed" });
      expect(adv.findings).toEqual([]); // advisory mode never restates the gap as a generic finding/Nit

      const gate = evaluateGateCheck(adv, { linkedIssueSatisfactionGateMode: "advisory" });
      expect(gate.conclusion).not.toBe("failure");
      expect(gate.blockers).toHaveLength(0);
    });

    it("BLOCK mode + 'unaddressed' records a linked_issue_scope_mismatch fired signal in the shared calibration store (#8101)", async () => {
      stubIssueFetch();
      const run = vi.fn(async () => ({ response: satisfactionJson({ status: "unaddressed", confidence: 0.9 }) }));
      const env = enabledEnv(run);
      await runLinkedIssueSatisfactionForAdvisory(env, { mode: "live", settings: blockMode, advisory: advisory(), repoFullName: "acme/widgets", pr, author: "alice", files, confirmedContributor: true, installationId: 1 });

      const history = await createSignalStore(env).queryRuleHistory("linked_issue_scope_mismatch", 0);
      expect(history.fired).toHaveLength(1);
      expect(history.fired[0]).toMatchObject({
        ruleId: "linked_issue_scope_mismatch",
        targetKey: "acme/widgets#7",
        outcome: "unaddressed",
        metadata: { confidence: 0.9 },
      });
      expect(history.overrides).toEqual([]); // firing alone is never an override
    });

    it("captures the bounded raw context (issueText/prTitle/prBody/diff/modelResponseText) on the fired signal, truncating an over-limit body (#8129)", async () => {
      stubIssueFetch();
      const modelJson = satisfactionJson({ status: "unaddressed", confidence: 0.9 });
      const run = vi.fn(async () => ({ response: modelJson }));
      const env = enabledEnv(run);
      const longBody = "x".repeat(MAX_BODY_CHARS + 500);
      const longBodyPr = { ...pr, body: longBody };
      await runLinkedIssueSatisfactionForAdvisory(env, { mode: "live", settings: blockMode, advisory: advisory(), repoFullName: "acme/widgets", pr: longBodyPr, author: "alice", files, confirmedContributor: true, installationId: 1 });

      const history = await createSignalStore(env).queryRuleHistory("linked_issue_scope_mismatch", 0);
      expect(history.fired).toHaveLength(1);
      const metadata = history.fired[0]?.metadata as Record<string, string>;
      // The stored issue text is the same title+body composite the assessment itself consumed.
      expect(metadata.issueText).toContain("Enrich SN74 Gittensor — add SSE stream");
      expect(metadata.issueText).toContain("We need a live SSE stream surface for SN74 Gittensor.");
      expect(metadata.prTitle).toBe("Add SSE stream endpoint");
      // The over-limit body is truncated to the assessment's OWN bound, never stored raw.
      expect(metadata.prBody).toBe(longBody.slice(0, MAX_BODY_CHARS));
      expect(metadata.prBody).toHaveLength(MAX_BODY_CHARS);
      expect(metadata.diff).toBe(buildAiReviewDiff(files).slice(0, MAX_DIFF_CHARS));
      // #8139: the model's own raw response is captured too, byte-identical to what was actually parsed —
      // a future logic backtest replays parseLinkedIssueSatisfactionOpinion against exactly this text.
      expect(metadata.modelResponseText).toBe(modelJson);
    });

    it("truncates an over-limit model response to MAX_MODEL_RESPONSE_CHARS on the fired signal (#8139)", async () => {
      stubIssueFetch();
      // Padding lives inside the rationale string (still valid JSON + still parses to "unaddressed" above the
      // floor) so the raw response text itself grows past the bound without changing the parsed verdict.
      const modelJson = satisfactionJson({ status: "unaddressed", confidence: 0.9, rationale: "x".repeat(MAX_MODEL_RESPONSE_CHARS + 500) });
      const run = vi.fn(async () => ({ response: modelJson }));
      const env = enabledEnv(run);
      await runLinkedIssueSatisfactionForAdvisory(env, { mode: "live", settings: blockMode, advisory: advisory(), repoFullName: "acme/widgets", pr, author: "alice", files, confirmedContributor: true, installationId: 1 });

      const history = await createSignalStore(env).queryRuleHistory("linked_issue_scope_mismatch", 0);
      const metadata = history.fired[0]?.metadata as Record<string, string>;
      expect(metadata.modelResponseText).toBe(modelJson.slice(0, MAX_MODEL_RESPONSE_CHARS));
      expect(metadata.modelResponseText).toHaveLength(MAX_MODEL_RESPONSE_CHARS);
    });

    it("stores an empty prBody (not the string 'null'/'undefined') for a body-less PR (#8129)", async () => {
      stubIssueFetch();
      const run = vi.fn(async () => ({ response: satisfactionJson({ status: "unaddressed", confidence: 0.9 }) }));
      const env = enabledEnv(run);
      const bodylessPr = { ...pr, body: null as unknown as string };
      await runLinkedIssueSatisfactionForAdvisory(env, { mode: "live", settings: blockMode, advisory: advisory(), repoFullName: "acme/widgets", pr: bodylessPr, author: "alice", files, confirmedContributor: true, installationId: 1 });

      const history = await createSignalStore(env).queryRuleHistory("linked_issue_scope_mismatch", 0);
      expect((history.fired[0]?.metadata as Record<string, string>).prBody).toBe("");
    });

    it("ADVISORY mode records NO fired signal for the same 'unaddressed' verdict (#8101 — no finding, no signal)", async () => {
      stubIssueFetch();
      const run = vi.fn(async () => ({ response: satisfactionJson({ status: "unaddressed", confidence: 0.9 }) }));
      const env = enabledEnv(run);
      await runLinkedIssueSatisfactionForAdvisory(env, { mode: "live", settings: advisoryMode, advisory: advisory(), repoFullName: "acme/widgets", pr, author: "alice", files, confirmedContributor: true, installationId: 1 });
      expect((await createSignalStore(env).queryRuleHistory("linked_issue_scope_mismatch", 0)).fired).toEqual([]);
    });

    it("BLOCK mode records NO fired signal for 'addressed' or 'partial' verdicts (#8101)", async () => {
      for (const status of ["addressed", "partial"] as const) {
        stubIssueFetch();
        const run = vi.fn(async () => ({ response: satisfactionJson({ status }) }));
        const env = enabledEnv(run);
        await runLinkedIssueSatisfactionForAdvisory(env, { mode: "live", settings: blockMode, advisory: advisory(), repoFullName: "acme/widgets", pr, author: "alice", files, confirmedContributor: true, installationId: 1 });
        expect((await createSignalStore(env).queryRuleHistory("linked_issue_scope_mismatch", 0)).fired).toEqual([]);
      }
    });

    it("degrades silently when the SignalStore write rejects: the finding still pushes and nothing throws (#8101)", async () => {
      stubIssueFetch();
      vi.spyOn(signalTrackingWire, "createSignalStore").mockReturnValue({
        recordRuleFired: async () => {
          throw new Error("signal store down");
        },
        recordHumanOverride: async () => undefined,
        queryRuleHistory: async () => ({ fired: [], overrides: [] }),
      });
      const run = vi.fn(async () => ({ response: satisfactionJson({ status: "unaddressed", confidence: 0.9 }) }));
      const adv = advisory();
      const result = await runLinkedIssueSatisfactionForAdvisory(enabledEnv(run), { mode: "live", settings: blockMode, advisory: adv, repoFullName: "acme/widgets", pr, author: "alice", files, confirmedContributor: true, installationId: 1 });
      expect(result).toMatchObject({ status: "unaddressed" }); // normal return value unaffected
      expect(adv.findings).toHaveLength(1); // the blocker still lands
    });

    it("BLOCK mode: an 'addressed'/'partial' verdict never pushes a finding (nothing to block)", async () => {
      stubIssueFetch();
      const run = vi.fn(async () => ({ response: satisfactionJson({ status: "partial" }) }));
      const adv = advisory();
      const result = await runLinkedIssueSatisfactionForAdvisory(enabledEnv(run), { mode: "live", settings: blockMode, advisory: adv, repoFullName: "acme/widgets", pr, author: "alice", files, confirmedContributor: true, installationId: 1 });
      expect(result).toMatchObject({ status: "partial" });
      expect(adv.findings).toEqual([]);
      const gate = evaluateGateCheck(adv, { linkedIssueSatisfactionGateMode: "block" });
      expect(gate.conclusion).not.toBe("failure");
    });

    it("BLOCK mode: a below-floor 'unaddressed' degrades to no result and never blocks (confidence-floor fail-safe)", async () => {
      stubIssueFetch();
      const run = vi.fn(async () => ({ response: satisfactionJson({ status: "unaddressed", confidence: 0.1 }) }));
      const adv = advisory();
      const result = await runLinkedIssueSatisfactionForAdvisory(enabledEnv(run), { mode: "live", settings: blockMode, advisory: adv, repoFullName: "acme/widgets", pr, author: "alice", files, confirmedContributor: true, installationId: 1 });
      expect(result).toBeNull();
      expect(adv.findings).toEqual([]);
      const gate = evaluateGateCheck(adv, { linkedIssueSatisfactionGateMode: "block" });
      expect(gate.conclusion).not.toBe("failure");
    });
  });

  describe("BYOK routing", () => {
    it("uses the maintainer's BYOK frontier model (not Workers AI) when aiReviewByok is on and a key is configured", async () => {
      const workersRun = vi.fn(async () => ({ response: satisfactionJson({ status: "partial" }) })); // must NOT be called
      const env = createTestEnv({
        AI: { run: workersRun } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
        TOKEN_ENCRYPTION_SECRET: "linked-issue-satisfaction-byok-test-encryption-secret-32b",
      });
      await upsertRepositoryAiKey(env, { repoFullName: "acme/widgets", provider: "anthropic", key: "sk-ant-byok-satisfaction-9999", model: null });
      stubFetch((url) => {
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.endsWith("/issues/1275")) return Response.json({ number: 1275, state: "open", title: "Add SSE stream", body: "We need a live SSE stream." });
        if (url === "https://api.anthropic.com/v1/messages") return Response.json({ content: [{ type: "text", text: satisfactionJson({ status: "addressed" }) }] });
        return new Response("not found", { status: 404 });
      });
      const adv = advisory();
      const result = await runLinkedIssueSatisfactionForAdvisory(env, { mode: "live", settings: { linkedIssueSatisfactionGateMode: "advisory", aiReviewByok: true } as RepositorySettings, advisory: adv, repoFullName: "acme/widgets", pr, author: "alice", files, confirmedContributor: true, installationId: 1 });
      expect(result).toMatchObject({ status: "addressed" });
      expect(workersRun).not.toHaveBeenCalled();
    });

    it("uses BYOK when aiReviewProvider is explicitly set AND matches the stored key's provider", async () => {
      const workersRun = vi.fn(); // must NOT be called
      const env = createTestEnv({
        AI: { run: workersRun } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
        TOKEN_ENCRYPTION_SECRET: "linked-issue-satisfaction-byok-match-test-encryption-secret-32",
      });
      await upsertRepositoryAiKey(env, { repoFullName: "acme/widgets", provider: "anthropic", key: "sk-ant-byok-match-9999", model: null });
      stubFetch((url) => {
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.endsWith("/issues/1275")) return Response.json({ number: 1275, state: "open", title: "Add SSE stream", body: "We need a live SSE stream." });
        if (url === "https://api.anthropic.com/v1/messages") return Response.json({ content: [{ type: "text", text: satisfactionJson({ status: "addressed" }) }] });
        return new Response("not found", { status: 404 });
      });
      const adv = advisory();
      const result = await runLinkedIssueSatisfactionForAdvisory(env, {
        mode: "live",
        settings: { linkedIssueSatisfactionGateMode: "advisory", aiReviewByok: true, aiReviewProvider: "anthropic" } as RepositorySettings,
        advisory: adv,
        repoFullName: "acme/widgets",
        pr,
        author: "alice",
        files,
        confirmedContributor: true,
        installationId: 1,
      });
      expect(result).toMatchObject({ status: "addressed" });
      expect(workersRun).not.toHaveBeenCalled();
    });

    it("falls back to Workers AI when aiReviewProvider is explicitly set but MISMATCHES the stored key's provider", async () => {
      const workersRun = vi.fn(async () => ({ response: satisfactionJson({ status: "partial" }) }));
      const env = createTestEnv({
        AI: { run: workersRun } as unknown as Ai,
        AI_SUMMARIES_ENABLED: "true",
        AI_PUBLIC_COMMENTS_ENABLED: "true",
        AI_DAILY_NEURON_BUDGET: "100000",
        TOKEN_ENCRYPTION_SECRET: "linked-issue-satisfaction-byok-mismatch-test-encryption-secret-3",
      });
      // Stored key's provider is anthropic, but the repo declared openai — the declared provider must match
      // the stored key's own provider, or BYOK is skipped entirely (falls back to Workers AI).
      await upsertRepositoryAiKey(env, { repoFullName: "acme/widgets", provider: "anthropic", key: "sk-ant-byok-mismatch-9999", model: null });
      const fetchSpy = vi.fn(async () => new Response("must not be called", { status: 500 }));
      stubFetch((url) => {
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.endsWith("/issues/1275")) return Response.json({ number: 1275, state: "open", title: "Add SSE stream", body: "We need a live SSE stream." });
        return fetchSpy();
      });
      const adv = advisory();
      const result = await runLinkedIssueSatisfactionForAdvisory(env, {
        mode: "live",
        settings: { linkedIssueSatisfactionGateMode: "advisory", aiReviewByok: true, aiReviewProvider: "openai" } as RepositorySettings,
        advisory: adv,
        repoFullName: "acme/widgets",
        pr,
        author: "alice",
        files,
        confirmedContributor: true,
        installationId: 1,
      });
      expect(result).toMatchObject({ status: "partial" });
      expect(workersRun).toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled(); // never reached api.anthropic.com
    });
  });

  describe("cache wiring (#linked-issue-satisfaction-cache)", () => {
    it("reuses a stored assessment for an unchanged head+issue instead of calling the model again", async () => {
      stubIssueFetch();
      const run = vi.fn(async () => ({ response: satisfactionJson({ status: "unaddressed", confidence: 0.9 }) }));
      const env = enabledEnv(run);
      const fingerprint = await processorFingerprint();
      await putCachedLinkedIssueSatisfaction(env, "acme/widgets", 7, "sha7", 1275, fingerprint, {
        status: "ok",
        result: { status: "addressed", rationale: "cached: looks done", confidence: 0.8 },
        estimatedNeurons: 12,
      });
      const adv = advisory();
      const result = await runLinkedIssueSatisfactionForAdvisory(env, { mode: "live", settings: advisoryMode, advisory: adv, repoFullName: "acme/widgets", pr, author: "alice", files, confirmedContributor: true, installationId: 1 });
      expect(run).not.toHaveBeenCalled();
      expect(result).toEqual({ status: "addressed", rationale: "cached: looks done" });
    });

    it("swallows a throwing audit-event write on a cache HIT (fail-safe, the result still returns)", async () => {
      stubIssueFetch();
      const run = vi.fn();
      const env = enabledEnv(run);
      const fingerprint = await processorFingerprint();
      await putCachedLinkedIssueSatisfaction(env, "acme/widgets", 7, "sha7", 1275, fingerprint, {
        status: "ok",
        result: { status: "addressed", rationale: "cached: looks done", confidence: 0.8 },
        estimatedNeurons: 12,
      });
      const repositoriesModule = await import("../../src/db/repositories");
      const auditSpy = vi.spyOn(repositoriesModule, "recordAuditEvent").mockRejectedValueOnce(new Error("D1 audit write error"));
      const adv = advisory();
      const result = await runLinkedIssueSatisfactionForAdvisory(env, { mode: "live", settings: advisoryMode, advisory: adv, repoFullName: "acme/widgets", pr, author: "alice", files, confirmedContributor: true, installationId: 1 });
      expect(run).not.toHaveBeenCalled(); // still a cache hit despite the audit-write failure
      expect(result).toEqual({ status: "addressed", rationale: "cached: looks done" });
      auditSpy.mockRestore();
    });

    it("is fail-safe when BOTH the cache WRITE and its own error-audit write throw (doubly-nested fail-safe)", async () => {
      stubIssueFetch();
      const run = vi.fn(async () => ({ response: satisfactionJson({ status: "addressed" }) }));
      const env = enabledEnv(run);
      const repositoriesModule = await import("../../src/db/repositories");
      const writeSpy = vi.spyOn(repositoriesModule, "putCachedLinkedIssueSatisfaction").mockRejectedValueOnce(new Error("D1 write error"));
      const auditSpy = vi.spyOn(repositoriesModule, "recordAuditEvent").mockImplementation(async (_env, event) => {
        if (event.eventType === "github_app.linked_issue_satisfaction_cache_write_error") throw new Error("D1 audit write error");
        return undefined;
      });
      const adv = advisory();
      await expect(
        runLinkedIssueSatisfactionForAdvisory(env, { mode: "live", settings: advisoryMode, advisory: adv, repoFullName: "acme/widgets", pr, author: "alice", files, confirmedContributor: true, installationId: 1 }),
      ).resolves.toMatchObject({ status: "addressed" }); // never throws, even with both the cache write AND its own audit write failing
      writeSpy.mockRestore();
      auditSpy.mockRestore();
    });

    it("misses the cache and writes back a fresh result so the NEXT call at this head+issue is a hit", async () => {
      stubIssueFetch();
      const run = vi.fn(async () => ({ response: satisfactionJson({ status: "addressed" }) }));
      const env = enabledEnv(run);
      const adv = advisory();
      await runLinkedIssueSatisfactionForAdvisory(env, { mode: "live", settings: advisoryMode, advisory: adv, repoFullName: "acme/widgets", pr, author: "alice", files, confirmedContributor: true, installationId: 1 });
      expect(run).toHaveBeenCalledTimes(1);

      const fingerprint = await processorFingerprint();
      const cached = await getCachedLinkedIssueSatisfaction(env, "acme/widgets", 7, "sha7", 1275, fingerprint);
      expect(cached).toMatchObject({ status: "ok", result: { status: "addressed" } });

      const adv2 = advisory();
      await runLinkedIssueSatisfactionForAdvisory(env, { mode: "live", settings: advisoryMode, advisory: adv2, repoFullName: "acme/widgets", pr, author: "alice", files, confirmedContributor: true, installationId: 1 });
      expect(run).toHaveBeenCalledTimes(1); // still 1 — second pass was a cache hit
    });

    it("misses the cache when editable issue or PR text changes at the same head SHA", async () => {
      stubIssueFetch({ body: "We need a live SSE stream surface for SN74 Gittensor." });
      const run = vi.fn(async () => ({ response: satisfactionJson({ status: "addressed", rationale: "The SSE endpoint satisfies the original ask." }) }));
      const env = enabledEnv(run);
      const adv = advisory();
      await expect(
        runLinkedIssueSatisfactionForAdvisory(env, { mode: "live", settings: blockMode, advisory: adv, repoFullName: "acme/widgets", pr, author: "alice", files, confirmedContributor: true, installationId: 1 }),
      ).resolves.toMatchObject({ status: "addressed" });

      stubIssueFetch({ body: "We now need a GraphQL subscription instead of an SSE stream." });
      run.mockResolvedValueOnce({ response: satisfactionJson({ status: "unaddressed", confidence: 0.9, rationale: "The changed issue asks for GraphQL, but the diff still adds SSE." }) });
      const changedAdvisory = advisory();
      const changedPr = { ...pr, title: "Add SSE endpoint for the old issue", body: "Still only implements SSE." };
      await expect(
        runLinkedIssueSatisfactionForAdvisory(env, { mode: "live", settings: blockMode, advisory: changedAdvisory, repoFullName: "acme/widgets", pr: changedPr, author: "alice", files, confirmedContributor: true, installationId: 1 }),
      ).resolves.toMatchObject({ status: "unaddressed" });

      expect(run).toHaveBeenCalledTimes(2);
      expect(changedAdvisory.findings).toContainEqual(expect.objectContaining({ code: "linked_issue_scope_mismatch" }));
    });

    it("misses the cache when the PR's primary linked issue number changes, even at the same head SHA", async () => {
      stubIssueFetch();
      const run = vi.fn(async () => ({ response: satisfactionJson({ status: "addressed" }) }));
      const env = enabledEnv(run);
      const fingerprint = await linkedIssueSatisfactionCacheInputFingerprint({ byok: false, provider: null, model: null });
      await putCachedLinkedIssueSatisfaction(env, "acme/widgets", 7, "sha7", 999, fingerprint, {
        status: "ok",
        result: { status: "unaddressed", rationale: "stale verdict for a different issue", confidence: 0.9 },
        estimatedNeurons: 5,
      });
      const adv = advisory();
      const result = await runLinkedIssueSatisfactionForAdvisory(env, { mode: "live", settings: advisoryMode, advisory: adv, repoFullName: "acme/widgets", pr, author: "alice", files, confirmedContributor: true, installationId: 1 });
      // pr.linkedIssues is [1275] here, not 999 — must be a fresh call, not the stale row for issue #999.
      expect(run).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ status: "addressed" });
    });

    it("does not cache a quota_exceeded short-circuit — a later call still tries the model once quota allows", async () => {
      stubIssueFetch();
      const run = vi.fn(async () => ({ response: satisfactionJson({ status: "addressed" }) }));
      const budgetedEnv = createTestEnv({ AI: { run } as unknown as Ai, AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true", AI_DAILY_NEURON_BUDGET: "1" });
      const adv = advisory();
      await runLinkedIssueSatisfactionForAdvisory(budgetedEnv, { mode: "live", settings: advisoryMode, advisory: adv, repoFullName: "acme/widgets", pr, author: "alice", files, confirmedContributor: true, installationId: 1 });
      expect(run).not.toHaveBeenCalled();

      const richEnv = createTestEnv({ AI: { run } as unknown as Ai, AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true", AI_DAILY_NEURON_BUDGET: "100000" });
      const adv2 = advisory();
      await runLinkedIssueSatisfactionForAdvisory(richEnv, { mode: "live", settings: advisoryMode, advisory: adv2, repoFullName: "acme/widgets", pr, author: "alice", files, confirmedContributor: true, installationId: 1 });
      expect(run).toHaveBeenCalledTimes(1);
    });

    it("is fail-safe when the cache READ throws — falls through to a fresh model call", async () => {
      stubIssueFetch();
      const run = vi.fn(async () => ({ response: satisfactionJson({ status: "addressed" }) }));
      const env = enabledEnv(run);
      const repositoriesModule = await import("../../src/db/repositories");
      const readSpy = vi.spyOn(repositoriesModule, "getCachedLinkedIssueSatisfaction").mockRejectedValueOnce(new Error("D1 read error"));
      const adv = advisory();
      const result = await runLinkedIssueSatisfactionForAdvisory(env, { mode: "live", settings: advisoryMode, advisory: adv, repoFullName: "acme/widgets", pr, author: "alice", files, confirmedContributor: true, installationId: 1 });
      expect(run).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ status: "addressed" });
      readSpy.mockRestore();
    });

    it("is fail-safe when the cache WRITE throws — the fresh result still returns, and the failure is audited", async () => {
      stubIssueFetch();
      const run = vi.fn(async () => ({ response: satisfactionJson({ status: "addressed" }) }));
      const env = enabledEnv(run);
      const repositoriesModule = await import("../../src/db/repositories");
      const writeSpy = vi.spyOn(repositoriesModule, "putCachedLinkedIssueSatisfaction").mockRejectedValueOnce(new Error("D1 write error"));
      const adv = advisory();
      const result = await runLinkedIssueSatisfactionForAdvisory(env, { mode: "live", settings: advisoryMode, advisory: adv, repoFullName: "acme/widgets", pr, author: "alice", files, confirmedContributor: true, installationId: 1 });
      expect(result).toMatchObject({ status: "addressed" });
      writeSpy.mockRestore();

      const audit = await env.DB.prepare("select outcome, detail from audit_events where event_type = ? and target_key = ?")
        .bind("github_app.linked_issue_satisfaction_cache_write_error", "acme/widgets#7")
        .first<{ outcome: string; detail: string }>();
      expect(audit?.outcome).toBe("error");
      expect(audit?.detail).toContain("D1 write error");
    });
  });
});

describe("linked-issue satisfaction wired end-to-end through the real webhook pipeline (metagraphed PR #3910 repro shape)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearInstallationTokenCacheForTest();
  });

  async function stubGittensorMinerFetch(
    pull: { number: number; headSha: string; state?: string },
    handlers: Record<string, () => Response | Promise<Response>>,
  ) {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") {
        return Response.json([
          { uid: 7, githubUsername: "confirmed-dev", githubId: "123", totalPrs: 4, totalMergedPrs: 3, totalOpenPrs: 1, totalClosedPrs: 0, totalOpenIssues: 0, totalClosedIssues: 0, totalSolvedIssues: 0, totalValidSolvedIssues: 0, isEligible: true, credibility: 1, eligibleRepoCount: 1 },
        ]);
      }
      if (url === "https://api.gittensor.io/miners/123") {
        return Response.json({ repositories: [{ repositoryFullName: "JSONbored/metagraphed", totalPrs: "4", totalMergedPrs: "3", totalOpenPrs: "1", totalClosedPrs: "0", totalOpenIssues: "0", totalClosedIssues: "0", isEligible: true, credibility: "1.000000" }] });
      }
      if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
      if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/commits/") && url.includes("/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      // Live PR-state freshness check (fetchLivePullRequestResult, GET /pulls/{n}) -- gates whether a review
      // output publish is stale/superseded. Must resolve to the SAME head SHA the webhook payload carries, or
      // maybePublishPrPublicSurface throws a retryable "unavailable" freshness error before ever reaching this
      // feature's own call site.
      if (url.endsWith(`/pulls/${pull.number}`) && method === "GET") {
        return Response.json({ number: pull.number, state: pull.state ?? "open", draft: false, head: { sha: pull.headSha }, labels: [] });
      }
      for (const [suffix, handler] of Object.entries(handlers)) {
        if (url.endsWith(suffix) || url.includes(suffix)) return handler();
      }
      return new Response("not found", { status: 404 });
    });
  }

  it("BLOCK mode: an SSE-vs-REST scope-mismatch verdict fails the real Gate check run, reproducing metagraphed PR #3910's shape (rendering itself is covered separately in unified-comment-bridge.test.ts)", async () => {
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      AI: { run: async () => ({ response: satisfactionJson({ status: "unaddressed", confidence: 0.9, rationale: "The linked issue asks for an SSE stream; this PR adds an unrelated REST endpoint." }) }) } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "100000",
      // The converged unified-comment renderer (which folds in the "Linked issue satisfaction" section this
      // feature populates) is itself behind BOTH the global kill-switch AND the (back-compat, manifest-absent)
      // LOOPOVER_REVIEW_REPOS allowlist -- see convergedFeatureActive/resolveConvergedFeature
      // (src/review/feature-activation.ts). Both are required for a repo with no `.loopover.yml` manifest.
      LOOPOVER_REVIEW_REPOS: "JSONbored/metagraphed",
    });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/metagraphed": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-07-07T00:00:00.000Z",
      ),
    );
    await upsertRepositoryFromGitHub(env, { name: "metagraphed", full_name: "JSONbored/metagraphed", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/metagraphed",
      autoLabelEnabled: false,
      gatePack: "oss-anti-slop",
      // The gate under test: off by default, opted into "block" here so an above-floor "unaddressed" verdict
      // becomes a real Gate-check failure -- the exact gap #3906 filed against.
      linkedIssueSatisfactionGateMode: "block",
    });
    await upsertRepoFocusManifest(env, "JSONbored/metagraphed", {
      settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", reviewCheckMode: "required", linkedIssueGateMode: "off" },
    });

    let gatePatchBody: { conclusion?: string; output?: { title?: string; text?: string } } = {};
    await stubGittensorMinerFetch({ number: 3910, headSha: "realvenus3910" }, {
      "/issues/1275": () => Response.json({ number: 1275, state: "open", title: "Enrich SN74 Gittensor — add SSE stream", body: "We need a live SSE stream surface for SN74 Gittensor." }),
      "/check-runs/950": () => {
        // PATCH updates the gate check-run with the final conclusion.
        return Response.json({ id: 950 });
      },
    });
    // Layer a PATCH-capturing handler on top (the generic stub above doesn't distinguish POST vs PATCH).
    const baseFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/check-runs/950") && method === "PATCH") {
        gatePatchBody = JSON.parse(String(init?.body ?? "{}")) as typeof gatePatchBody;
        return Response.json({ id: 950 });
      }
      if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 950 }, { status: 201 });
      if (url.includes("/issues/3910/comments") && method === "GET") return Response.json([]); // no existing bot comment -> POST a new one
      if (url.includes("/issues/3910/comments") && method === "POST") return Response.json({ id: 1 }, { status: 201 });
      return baseFetch(input, init);
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "linked-issue-satisfaction-3910-repro",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "metagraphed", full_name: "JSONbored/metagraphed", private: false, owner: { login: "JSONbored" } },
        pull_request: {
          number: 3910,
          title: "feat(registry): add SN74 Gittensor per-repo commits subnet-api surface (#1275)",
          state: "open",
          user: { login: "confirmed-dev" },
          head: { sha: "realvenus3910" },
          labels: [],
          body: "Closes #1275",
        },
      },
    });

    expect(gatePatchBody.conclusion).toBe("failure");
    expect(gatePatchBody.output?.title).toContain("Linked issue does not appear to be satisfied");

    // The assessment was cached under the PR's primary linked issue number. The fingerprint itself includes
    // prompt text, which this end-to-end test does not need to reconstruct from the webhook pipeline.
    const cached = await env.DB.prepare(
      "SELECT status, result_json AS resultJson FROM linked_issue_satisfaction_cache WHERE repo_full_name = ? AND pull_number = ? AND head_sha = ? AND linked_issue_number = ?",
    )
      .bind("JSONbored/metagraphed", 3910, "realvenus3910", 1275)
      .first<{ status: string; resultJson: string }>();
    expect(cached?.status).toBe("ok");
    expect(JSON.parse(cached?.resultJson ?? "{}")?.status).toBe("unaddressed");
  });

  it("OFF mode (default): no fetch, no model spend, no cache row, and the comment never mentions linked-issue satisfaction at all — byte-identical to before this feature existed", async () => {
    const run = vi.fn();
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      AI: { run } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "100000",
      LOOPOVER_REVIEW_REPOS: "JSONbored/metagraphed",
    });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/metagraphed": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-07-07T00:00:00.000Z",
      ),
    );
    await upsertRepositoryFromGitHub(env, { name: "metagraphed", full_name: "JSONbored/metagraphed", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/metagraphed",
      autoLabelEnabled: false,
      gatePack: "oss-anti-slop",
      // No override -- linkedIssueSatisfactionGateMode is omitted, so upsertRepositorySettings persists its
      // default "off".
    });
    await upsertRepoFocusManifest(env, "JSONbored/metagraphed", {
      settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", reviewCheckMode: "required", linkedIssueGateMode: "off" },
    });

    let postedCommentBody = "";
    const issuesFetchSpy = vi.fn(() => Response.json({ number: 1275, state: "open", title: "x", body: "y" }));
    await stubGittensorMinerFetch({ number: 3912, headSha: "offmode3912" }, { "/issues/1275": issuesFetchSpy });
    const baseFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 951 }, { status: 201 });
      if (url.includes("/check-runs/") && method === "PATCH") return Response.json({ id: 951 });
      if (url.endsWith("/issues/3912/comments") && method === "GET") return Response.json([]);
      if (url.endsWith("/issues/3912/comments") && method === "POST") {
        postedCommentBody = JSON.parse(String(init?.body ?? "{}"))?.body ?? "";
        return Response.json({ id: 2 }, { status: 201 });
      }
      return baseFetch(input, init);
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "linked-issue-satisfaction-off-mode",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "metagraphed", full_name: "JSONbored/metagraphed", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 3912, title: "Unrelated change", state: "open", user: { login: "confirmed-dev" }, head: { sha: "offmode3912" }, labels: [], body: "Closes #1275" },
      },
    });

    expect(run).not.toHaveBeenCalled();
    expect(issuesFetchSpy).not.toHaveBeenCalled();
    expect(postedCommentBody).not.toContain("Linked issue satisfaction");
    const fingerprint = await linkedIssueSatisfactionCacheInputFingerprint({ byok: false, provider: null, model: null });
    expect(await getCachedLinkedIssueSatisfaction(env, "JSONbored/metagraphed", 3912, "offmode3912", 1275, fingerprint)).toBeNull();
  });

  it("ADVISORY mode (not block): the SAME scope-mismatch verdict never fails the Gate check run", async () => {
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      AI: { run: async () => ({ response: satisfactionJson({ status: "unaddressed", confidence: 0.9 }) }) } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "100000",
    });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/metagraphed": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-07-07T00:00:00.000Z",
      ),
    );
    await upsertRepositoryFromGitHub(env, { name: "metagraphed", full_name: "JSONbored/metagraphed", private: false, owner: { login: "JSONbored" } }, 123);
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/metagraphed",
      autoLabelEnabled: false,
      linkedIssueSatisfactionGateMode: "advisory",
    });
    await upsertRepoFocusManifest(env, "JSONbored/metagraphed", {
      settings: { commentMode: "off", publicSurface: "off", checkRunMode: "off", reviewCheckMode: "required", linkedIssueGateMode: "off" },
    });

    let gatePatchBody: { conclusion?: string } = {};
    await stubGittensorMinerFetch({ number: 3911, headSha: "advisorymode3911" }, { "/issues/1275": () => Response.json({ number: 1275, state: "open", title: "Add SSE stream", body: "We need a live SSE stream." }) });
    const baseFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/check-runs/950") && method === "PATCH") {
        gatePatchBody = JSON.parse(String(init?.body ?? "{}")) as typeof gatePatchBody;
        return Response.json({ id: 950 });
      }
      if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 950 }, { status: 201 });
      return baseFetch(input, init);
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "linked-issue-satisfaction-advisory-mode",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "metagraphed", full_name: "JSONbored/metagraphed", private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 3911, title: "Add REST endpoint", state: "open", user: { login: "confirmed-dev" }, head: { sha: "advisorymode3911" }, labels: [], body: "Closes #1275" },
      },
    });

    expect(gatePatchBody.conclusion).not.toBe("failure");
  });
});
