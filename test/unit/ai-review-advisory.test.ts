import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAiReviewDiff, runAiReviewForAdvisory } from "../../src/queue/processors";
import { upsertRepositoryAiKey } from "../../src/db/repositories";
import type { Advisory, PullRequestFileRecord, RepositorySettings } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

afterEach(() => {
  vi.unstubAllGlobals();
});

function fileRecord(over: Partial<PullRequestFileRecord> & { path: string }): PullRequestFileRecord {
  return { repoFullName: "acme/widgets", pullNumber: 3, status: "modified", additions: 1, deletions: 0, changes: 1, payload: {}, ...over };
}

describe("buildAiReviewDiff", () => {
  it("includes patches and headers, omits the patch when absent, and truncates oversized diffs", () => {
    const diff = buildAiReviewDiff([
      fileRecord({ path: "src/a.ts", status: "modified", payload: { patch: "@@\n+const x = 1;" } }),
      fileRecord({ path: "src/b.ts", status: undefined, payload: {} }),
    ]);
    expect(diff).toContain("### src/a.ts (modified) +1/-0");
    expect(diff).toContain("+const x = 1;");
    expect(diff).toContain("### src/b.ts +1/-0"); // no status, no patch
    expect(buildAiReviewDiff([])).toBe("");

    const huge = buildAiReviewDiff([fileRecord({ path: "src/big.ts", payload: { patch: "x".repeat(70000) } }), fileRecord({ path: "src/next.ts" })]);
    expect(huge).toContain("diff truncated");
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
  return JSON.stringify({ assessment: "Likely crash.", suggestions: ["Guard null."], risks: ["Null deref."], criticalDefect: { present: true, confidence: 0.97, title: "Null deref", detail: "Dereferences null." } });
}
function notesOnlyJson() {
  return JSON.stringify({ assessment: "Looks fine.", suggestions: ["Add a test."], risks: [], criticalDefect: { present: false, confidence: 0, title: "", detail: "" } });
}

function aiEnv(run: () => Promise<unknown>, flags = true) {
  return createTestEnv({
    AI: { run } as unknown as Ai,
    ...(flags ? { AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true" } : {}),
    AI_DAILY_NEURON_BUDGET: "100000",
  });
}

describe("runAiReviewForAdvisory", () => {
  it("no-ops when aiReviewMode is off", async () => {
    const adv = advisory();
    const result = await runAiReviewForAdvisory(aiEnv(async () => ({ response: defectJson() })), {
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

  it("no-ops for a non-confirmed contributor under the gittensor pack and when there is no head SHA", async () => {
    const env = aiEnv(async () => ({ response: defectJson() }));
    const base = { settings: { aiReviewMode: "block", gatePack: "gittensor" } as RepositorySettings, repoFullName: "acme/widgets", pr, author: "alice" };
    expect(await runAiReviewForAdvisory(env, { ...base, advisory: advisory(), confirmedContributor: false })).toBeUndefined();
    const noSha = advisory();
    delete (noSha as Partial<Advisory>).headSha;
    expect(await runAiReviewForAdvisory(env, { ...base, advisory: noSha, confirmedContributor: true })).toBeUndefined();
  });

  it("runs a blocking AI review for a non-confirmed contributor under oss-anti-slop", async () => {
    const adv = advisory();
    const result = await runAiReviewForAdvisory(aiEnv(async () => ({ response: defectJson() })), {
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

  it("appends an ai_consensus_defect finding in block mode when the models agree", async () => {
    const adv = advisory();
    const result = await runAiReviewForAdvisory(aiEnv(async () => ({ response: defectJson() })), {
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

  it("returns advisory notes without a finding in advisory mode", async () => {
    const adv = advisory();
    const result = await runAiReviewForAdvisory(aiEnv(async () => ({ response: notesOnlyJson() })), {
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

  it("returns undefined (no notes, no finding) when AI is disabled", async () => {
    const adv = advisory();
    const result = await runAiReviewForAdvisory(aiEnv(async () => ({ response: defectJson() }), false), {
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

  it("returns undefined when the model produces no parseable notes", async () => {
    const result = await runAiReviewForAdvisory(aiEnv(async () => ({ response: "not json" })), {
      settings: { aiReviewMode: "advisory" } as RepositorySettings,
      advisory: advisory(),
      repoFullName: "acme/widgets",
      pr,
      author: "alice",
      confirmedContributor: true,
    });
    expect(result).toBeUndefined();
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
