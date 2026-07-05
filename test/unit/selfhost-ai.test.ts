import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertNoLegacySharedAiEnv, buildProvider, claudeErrorStatus, codexErrorFromStdout, createAnthropicAi, createChainAi, createClaudeCodeAi, createCodexAi, createOpenAiCompatibleAi, createSelfHostAi, extractCliText, extractCliUsage, isAiProviderHealthy, markAiProviderUnhealthyAtBoot, resetAiProviderCircuitBreakerForTest, resetAiProviderHealthForTest, resolveAiReviewerPlan, resolveClaudeCliTimeoutMs, resolveCodexAuthPath, resolveCodexCliTimeoutMs, resolveCodexEffort, resolveCodexFirstOutputTimeoutMs, resolveEffort, resolveModel, resolveProviderNames, resolveRequiredCliProviders, resolveSubscriptionCliPath, redactSecrets, routeProviders, shouldMarkAiProviderUnhealthyAtBoot, subscriptionCliEnv } from "../../src/selfhost/ai";
import { labelSelfHostReviewerModel, labelSelfHostReviewerModels } from "../../src/selfhost/ai-config";
import { renderMetrics, resetMetrics } from "../../src/selfhost/metrics";

describe("resolveModel (#979 — never leak the Workers-AI default to a self-host backend)", () => {
  const WORKERS_DEFAULT = "@cf/meta/llama-3.1-8b-instruct-fp8-fast";
  it("operator-configured model wins over the core's Workers-AI id", () => {
    expect(resolveModel("llama3.1", WORKERS_DEFAULT, "x")).toBe("llama3.1");
  });
  it("strips the Workers-AI id and falls back to the provider default", () => {
    expect(resolveModel(undefined, WORKERS_DEFAULT, "sonnet")).toBe("sonnet");
  });
  it("passes through a real model the core supplied", () => {
    expect(resolveModel(undefined, "gpt-4o", "sonnet")).toBe("gpt-4o");
  });
});

describe("resolveEffort (#selfhost-effort — Claude Code intelligence dial, default medium)", () => {
  it("passes a valid level through, trimmed + lowercased", () => {
    expect(resolveEffort("low")).toBe("low");
    expect(resolveEffort("  Medium ")).toBe("medium");
    expect(resolveEffort("MAX")).toBe("max");
  });
  it("defaults to medium when unset or unrecognized to conserve fallback tokens", () => {
    expect(resolveEffort(undefined)).toBe("medium"); // ?? right side
    expect(resolveEffort("")).toBe("medium"); // present but not in the valid set
    expect(resolveEffort("ultra")).toBe("medium"); // unrecognized → conservative default
  });
});

describe("resolveCodexEffort (#selfhost-effort — Codex reasoning effort, explicit provider var)", () => {
  it("uses Codex-supported levels and maps max to xhigh", () => {
    expect(resolveCodexEffort("low")).toBe("low");
    expect(resolveCodexEffort("  Medium ")).toBe("medium");
    expect(resolveCodexEffort("xhigh")).toBe("xhigh");
    expect(resolveCodexEffort("max")).toBe("xhigh");
    expect(resolveCodexEffort("ultra")).toBe("medium");
  });
});

describe("provider-specific CLI timeouts (#selfhost — no shared timeout ambiguity)", () => {
  it("scales Claude timeout from CLAUDE_AI_EFFORT and honors CLAUDE_AI_TIMEOUT_MS", () => {
    expect(resolveClaudeCliTimeoutMs({ CLAUDE_AI_EFFORT: "low" })).toBe(120_000);
    expect(resolveClaudeCliTimeoutMs({ CLAUDE_AI_EFFORT: "medium" })).toBe(120_000);
    expect(resolveClaudeCliTimeoutMs({ CLAUDE_AI_EFFORT: "high" })).toBe(240_000);
    expect(resolveClaudeCliTimeoutMs({ CLAUDE_AI_EFFORT: "xhigh" })).toBe(360_000);
    expect(resolveClaudeCliTimeoutMs({ CLAUDE_AI_EFFORT: "max" })).toBe(600_000);
    expect(resolveClaudeCliTimeoutMs({})).toBe(120_000);
    expect(resolveClaudeCliTimeoutMs({ CLAUDE_AI_TIMEOUT_MS: "300000", CLAUDE_AI_EFFORT: "low" })).toBe(300_000);
  });
  it("scales Codex timeout from CODEX_AI_EFFORT and honors CODEX_AI_TIMEOUT_MS", () => {
    expect(resolveCodexCliTimeoutMs({ CODEX_AI_EFFORT: "low" })).toBe(120_000);
    expect(resolveCodexCliTimeoutMs({ CODEX_AI_EFFORT: "medium" })).toBe(120_000);
    expect(resolveCodexCliTimeoutMs({ CODEX_AI_EFFORT: "high" })).toBe(240_000);
    expect(resolveCodexCliTimeoutMs({ CODEX_AI_EFFORT: "xhigh" })).toBe(360_000);
    expect(resolveCodexCliTimeoutMs({ CODEX_AI_EFFORT: "max" })).toBe(360_000);
    expect(resolveCodexCliTimeoutMs({})).toBe(120_000);
    expect(resolveCodexCliTimeoutMs({ CODEX_AI_TIMEOUT_MS: "1000" })).toBe(30_000);
    expect(resolveCodexCliTimeoutMs({ CODEX_AI_TIMEOUT_MS: "9999999" })).toBe(1_800_000);
  });
  it("resolveCodexFirstOutputTimeoutMs defaults to 30s, is independent of effort, and honors + clamps CODEX_AI_FIRST_OUTPUT_TIMEOUT_MS", () => {
    // absent → the 30s default (?? right side)
    expect(resolveCodexFirstOutputTimeoutMs({})).toBe(30_000);
    // effort must NOT scale this deadline — a slow COMPLETION is not a slow first byte.
    expect(resolveCodexFirstOutputTimeoutMs({ CODEX_AI_EFFORT: "max" })).toBe(30_000);
    // present + valid → honored verbatim (?? left side, within bounds)
    expect(resolveCodexFirstOutputTimeoutMs({ CODEX_AI_FIRST_OUTPUT_TIMEOUT_MS: "15000" })).toBe(15_000);
    // clamped to the 1s floor
    expect(resolveCodexFirstOutputTimeoutMs({ CODEX_AI_FIRST_OUTPUT_TIMEOUT_MS: "1" })).toBe(1_000);
    // clamped to the 120s ceiling (well under the shortest full timeout, 120_000ms)
    expect(resolveCodexFirstOutputTimeoutMs({ CODEX_AI_FIRST_OUTPUT_TIMEOUT_MS: "999999" })).toBe(120_000);
    // non-finite/garbage falls back to the default (Number.isFinite false branch)
    expect(resolveCodexFirstOutputTimeoutMs({ CODEX_AI_FIRST_OUTPUT_TIMEOUT_MS: "not-a-number" })).toBe(30_000);
    // zero/negative also falls back (raw > 0 false branch)
    expect(resolveCodexFirstOutputTimeoutMs({ CODEX_AI_FIRST_OUTPUT_TIMEOUT_MS: "0" })).toBe(30_000);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetMetrics();
  resetAiProviderHealthForTest();
  resetAiProviderCircuitBreakerForTest();
});

type SpawnResult = { stdout: string; code: number | null; stderr?: string; timedOut?: boolean; stalledNoOutput?: boolean };
type StubSpawn = (
  cmd: string,
  args: string[],
  opts: { env: Record<string, string | undefined>; input?: string; timeoutMs: number; cwd?: string; firstOutputTimeoutMs?: number },
) => Promise<SpawnResult>;
// Bypasses the real ~/.codex/auth.json preflight so tests can focus on the spawn/exit behavior they target;
// the preflight itself (resolveCodexAuthPath / assertCodexAuthConfigured) is covered separately below.
const noAuthCheck = async () => undefined;

function countOccurrences(haystack: string | undefined, needle: string): number {
  return haystack?.split(needle).length ? haystack.split(needle).length - 1 : 0;
}

describe("createOpenAiCompatibleAi (#979)", () => {
  it("POSTs to /chat/completions and returns { response }", async () => {
    const calls: Array<{ url: string; body: { model: string } }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ choices: [{ message: { content: "hi there" } }], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } }), { status: 200 });
    }));
    const ai = createOpenAiCompatibleAi({ baseUrl: "http://ollama:11434/v1/", apiKey: "k" });
    const out = await ai.run("llama3.1", { messages: [{ role: "user", content: "x" }], max_tokens: 100 });
    expect(out.response).toBe("hi there");
    expect(out.usage).toMatchObject({ model: "llama3.1", inputTokens: 12, outputTokens: 4, totalTokens: 16 });
    const first = calls[0];
    expect(first?.url).toBe("http://ollama:11434/v1/chat/completions"); // trailing slash trimmed
    expect(first?.body.model).toBe("llama3.1");
  });

  it("throws on a non-OK response so the caller degrades", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("err", { status: 500 })));
    await expect(createOpenAiCompatibleAi({ baseUrl: "http://x/v1" }).run("m", { prompt: "p" })).rejects.toThrow(/ai_http_500/);
  });

  it("routes an embedding request ({ text }) to /embeddings and returns { data }", async () => {
    let url = "";
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      url = u;
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }] }), { status: 200 });
    }));
    const out = await createOpenAiCompatibleAi({ baseUrl: "http://o/v1", embedModel: "bge-m3" }).run("@cf/baai/bge-m3", { text: ["a", "b"] });
    expect(url).toBe("http://o/v1/embeddings");
    expect(out).toEqual({ data: [[0.1, 0.2], [0.3, 0.4]] });
  });

  it("throws on a non-OK embeddings response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("e", { status: 502 })));
    await expect(createOpenAiCompatibleAi({ baseUrl: "http://x/v1" }).run("m", { text: ["a"] })).rejects.toThrow(/ai_embed_http_502/);
  });

  it("empty text array returns { data: [] } without a fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await createOpenAiCompatibleAi({ baseUrl: "http://o/v1" }).run("m", { text: [] });
    expect(result).toEqual({ data: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("undefined prompt falls back to empty string (toMessages ?? guard)", async () => {
    let body: { messages: Array<{ role: string; content: string }> } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: { body: string }) => {
      body = JSON.parse(init.body) as { messages: Array<{ role: string; content: string }> };
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    }));
    await createOpenAiCompatibleAi({ baseUrl: "http://o/v1" }).run("m", {});
    expect(body?.messages).toEqual([{ role: "user", content: "" }]);
  });
});

describe("createSelfHostAi — provider selection", () => {
  it("is undefined when AI_PROVIDER is unset", () => {
    expect(createSelfHostAi({})).toBeUndefined();
  });
  it("maps ollama/openai-compatible/claude-code/codex to adapters", () => {
    expect(typeof createSelfHostAi({ AI_PROVIDER: "ollama", OLLAMA_AI_BASE_URL: "http://o/v1" })?.run).toBe("function");
    expect(typeof createSelfHostAi({ AI_PROVIDER: "claude-code" })?.run).toBe("function");
    expect(typeof createSelfHostAi({ AI_PROVIDER: "codex" })?.run).toBe("function");
    expect(createSelfHostAi({ AI_PROVIDER: "nonsense" })).toBeUndefined();
  });
  it("anthropic requires a key; a comma-list builds a fallback chain", () => {
    expect(createSelfHostAi({ AI_PROVIDER: "anthropic" })).toBeUndefined(); // no key → dropped
    expect(typeof createSelfHostAi({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant" })?.run).toBe("function");
    // "anthropic,ollama" with a key → both build → a chain (a runnable adapter)
    expect(typeof createSelfHostAi({ AI_PROVIDER: "anthropic,ollama", ANTHROPIC_API_KEY: "sk-ant" })?.run).toBe("function");
  });
  it("fails loudly when deprecated shared AI env knobs are present", () => {
    expect(() => assertNoLegacySharedAiEnv({ AI_PROVIDER: "ollama", AI_BASE_URL: "http://ollama:11434/v1", AI_MODEL: "llama3.1" })).toThrow(/legacy_shared_ai_config_unsupported: AI_BASE_URL, AI_MODEL/);
    expect(() => createSelfHostAi({ AI_PROVIDER: "ollama", AI_EFFORT: "high" })).toThrow(/CLAUDE_AI_EFFORT\/CLAUDE_AI_TIMEOUT_MS/);
  });
});

describe("createAnthropicAi (#979 native BYOK)", () => {
  it("splits the system message and returns the joined text content", async () => {
    let sent: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
      sent = { url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> };
      return new Response(JSON.stringify({ content: [{ type: "text", text: "hi" }, { type: "thinking", text: "ignored" }] }), { status: 200 });
    }));
    const out = await createAnthropicAi({ apiKey: "sk-ant", model: "claude-sonnet-4-6" }).run("@cf/ignored", {
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "go" },
      ],
      max_tokens: 256,
    });
    expect(out.response).toBe("hi"); // only text blocks
    expect(sent?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sent?.headers["x-api-key"]).toBe("sk-ant");
    expect(sent?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(sent?.body.system).toBe("be terse");
    expect(sent?.body.model).toBe("claude-sonnet-4-6"); // configured wins over the @cf id
    expect(sent?.body.messages).toEqual([{ role: "user", content: "go" }]);
  });

  it("throws on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("e", { status: 429 })));
    await expect(createAnthropicAi({ apiKey: "k" }).run("m", { prompt: "x" })).rejects.toThrow(/anthropic_http_429/);
  });
});

describe("createChainAi (fallback)", () => {
  it("falls through to the next provider on failure, returns the first success", async () => {
    const failing = { name: "a", ai: { run: async () => { throw new Error("down"); } } };
    const working = { name: "b", ai: { run: async () => ({ response: "from b" }) } };
    expect((await createChainAi([failing, working]).run("m", { prompt: "x" })).response).toBe("from b");
  });
  it("throws the last error when every provider fails", async () => {
    const a = { name: "a", ai: { run: async () => { throw new Error("err-a"); } } };
    const b = { name: "b", ai: { run: async () => { throw new Error("err-b"); } } };
    await expect(createChainAi([a, b]).run("m", { prompt: "x" })).rejects.toThrow(/err-b/);
  });

  it("REGRESSION (#codex-timeout-fields): a Codex timeout falls through to Claude Code, and the failure log carries job/PR/attempt context with no secret leaked", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const token = "oauth-tok-abcdef123456";
    const timedOut: StubSpawn = async () => ({ stdout: "", code: null, stderr: "connection reset", timedOut: true });
    const claudeOk: StubSpawn = async () => ({ stdout: JSON.stringify({ type: "result", result: "claude review" }), code: 0 });
    const codex = createCodexAi({ GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1" }, timedOut, noAuthCheck);
    const claudeCode = createClaudeCodeAi({ CLAUDE_CODE_OAUTH_TOKEN: token }, claudeOk);
    const chain = createChainAi([
      { name: "codex", ai: codex },
      { name: "claude-code", ai: claudeCode },
    ]);

    const result = await chain.run("m", {
      prompt: "review this diff",
      jobId: "delivery-123",
      repoFullName: "JSONbored/gittensory",
      pullNumber: 42,
      attempt: 0,
    });

    // (a) the review still completes successfully via the fallback provider.
    expect(result.response).toBe("claude review");

    const logged = errorSpy.mock.calls.map((call) => JSON.parse(String(call[0])));
    const codexFailure = logged.find((entry) => entry.event === "selfhost_ai_provider_failed" && entry.provider === "codex");
    const chainFailure = logged.find((entry) => entry.event === "selfhost_ai_provider_failed_in_chain" && entry.provider === "codex");

    // (b) both the provider-level and chain-level failure logs carry the new correlation fields.
    expect(codexFailure).toMatchObject({ jobId: "delivery-123", repoFullName: "JSONbored/gittensory", pullNumber: 42, attempt: 0 });
    expect(chainFailure).toMatchObject({ jobId: "delivery-123", repoFullName: "JSONbored/gittensory", pullNumber: 42, attempt: 0 });

    // (c) the Codex timeout detail is present but no secret value ever appears in the logged error text.
    expect(codexFailure.error).toContain("codex_timeout");
    expect(JSON.stringify(logged)).not.toContain(token);

    errorSpy.mockRestore();
  });

  it("omits the correlation fields (byte-identical log shape) when the caller supplies none", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = { name: "a", ai: { run: async () => { throw new Error("down"); } } };
    const working = { name: "b", ai: { run: async () => ({ response: "from b" }) } };
    await createChainAi([failing, working]).run("m", { prompt: "x" });
    const logged = JSON.parse(String(errorSpy.mock.calls[0]?.[0]));
    expect(logged.jobId).toBeUndefined();
    expect(logged.repoFullName).toBeUndefined();
    expect(logged.pullNumber).toBeUndefined();
    expect(logged.attempt).toBeUndefined();
    errorSpy.mockRestore();
  });
});

describe("per-provider circuit breaker (#2540 — skip fast during a sustained outage)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens the circuit after 3 consecutive failures; a call within the cooldown skips the real provider entirely", async () => {
    const calls = vi.fn(async () => {
      throw new Error("down");
    });
    const flaky = { name: "flaky-provider", ai: { run: calls } };
    // 3 consecutive failures via createChainAi (the shared chokepoint) opens the circuit.
    for (let i = 0; i < 3; i += 1) {
      await expect(createChainAi([flaky]).run("m", { prompt: "x" })).rejects.toThrow();
    }
    expect(calls).toHaveBeenCalledTimes(3);
    // A subsequent call within the cooldown window throws circuit_open WITHOUT invoking provider.ai.run again.
    await expect(createChainAi([flaky]).run("m", { prompt: "x" })).rejects.toThrow(/circuit_open: provider "flaky-provider"/);
    expect(calls).toHaveBeenCalledTimes(3); // unchanged — the real provider was never reached
    const metrics = await renderMetrics();
    expect(metrics).toContain('gittensory_ai_provider_circuit_open_total{provider="flaky-provider"} 1');
    expect(metrics).toContain('gittensory_ai_provider_failures_total{provider="flaky-provider"} 3');
  });

  it("REGRESSION (gate finding): concurrent same-provider failures accumulate correctly (no lost-update race)", async () => {
    // Each call previously captured the circuit's failure count BEFORE its own `await` on the real provider
    // call, then wrote `(that stale count) + 1` back on failure. Firing several failing calls for the SAME
    // provider concurrently (not sequentially) means every call reads the map before any of them have written —
    // each one computes failures=1 from the same stale pre-await snapshot, and the last writer clobbers the
    // rest, so the count never reaches the threshold no matter how many concurrent failures occur. Fixed by
    // re-reading the map fresh inside the (synchronous, no-await) catch block right before the write.
    const calls = vi.fn(async () => {
      throw new Error("down");
    });
    const flaky = { name: "concurrent-flaky-provider", ai: { run: calls } };
    const results = await Promise.allSettled([
      createChainAi([flaky]).run("m", { prompt: "x" }),
      createChainAi([flaky]).run("m", { prompt: "x" }),
      createChainAi([flaky]).run("m", { prompt: "x" }),
    ]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(calls).toHaveBeenCalledTimes(3); // all 3 concurrent calls reached the real (failing) provider
    // The circuit must now be OPEN (3 accumulated failures met the threshold) — a 4th call is skipped fast.
    await expect(createChainAi([flaky]).run("m", { prompt: "x" })).rejects.toThrow(/circuit_open: provider "concurrent-flaky-provider"/);
    expect(calls).toHaveBeenCalledTimes(3); // unchanged — the 4th call never reached the real provider
  });

  it("lets a call through to the real provider again after the cooldown elapses", async () => {
    vi.useFakeTimers();
    const calls = vi.fn(async () => {
      throw new Error("down");
    });
    const flaky = { name: "flaky-provider-2", ai: { run: calls } };
    for (let i = 0; i < 3; i += 1) {
      await expect(createChainAi([flaky]).run("m", { prompt: "x" })).rejects.toThrow();
    }
    expect(calls).toHaveBeenCalledTimes(3);
    // Still within cooldown: skipped.
    await expect(createChainAi([flaky]).run("m", { prompt: "x" })).rejects.toThrow(/circuit_open/);
    expect(calls).toHaveBeenCalledTimes(3);
    // Advance past the 60s cooldown — the next call reaches the real provider again.
    await vi.advanceTimersByTimeAsync(60_001);
    await expect(createChainAi([flaky]).run("m", { prompt: "x" })).rejects.toThrow(/down/);
    expect(calls).toHaveBeenCalledTimes(4); // the real provider WAS invoked this time
  });

  it("a success resets the failure count so one subsequent isolated failure does not reopen the circuit", async () => {
    let shouldFail = true;
    const calls = vi.fn(async () => {
      if (shouldFail) throw new Error("down");
      return { response: "ok" };
    });
    const provider = { name: "recovering-provider", ai: { run: calls } };
    // Two failures (below the threshold of 3).
    await expect(createChainAi([provider]).run("m", { prompt: "x" })).rejects.toThrow();
    await expect(createChainAi([provider]).run("m", { prompt: "x" })).rejects.toThrow();
    // A success resets the failure count to 0.
    shouldFail = false;
    await expect(createChainAi([provider]).run("m", { prompt: "x" })).resolves.toEqual({ response: "ok" });
    // One more isolated failure afterward must NOT immediately reopen the circuit (count was reset, not just decremented).
    shouldFail = true;
    await expect(createChainAi([provider]).run("m", { prompt: "x" })).rejects.toThrow(/down/); // real failure, not circuit_open
    // A second call right after must still reach the real provider (only 1 failure since the reset, below threshold 3).
    await expect(createChainAi([provider]).run("m", { prompt: "x" })).rejects.toThrow(/down/);
    expect(calls).toHaveBeenCalledTimes(5); // every call above reached the real provider.ai.run
  });

  it("routeProviders' direct-address path (dual-review) shares the same circuit breaker as the fallback chain", async () => {
    const calls = vi.fn(async () => {
      throw new Error("down");
    });
    const cc = { name: "claude-code", ai: { run: calls } };
    const cx = { name: "codex", ai: { run: vi.fn(async () => ({ response: "ok" })) } };
    const route = routeProviders([cc, cx]);
    for (let i = 0; i < 3; i += 1) {
      await expect(route.run("claude-code", { prompt: "x" })).rejects.toThrow();
    }
    expect(calls).toHaveBeenCalledTimes(3);
    await expect(route.run("claude-code", { prompt: "x" })).rejects.toThrow(/circuit_open: provider "claude-code"/);
    expect(calls).toHaveBeenCalledTimes(3); // unaffected by the circuit-open skip
    // The OTHER provider (codex) is completely unaffected — no cross-provider bleed.
    await expect(route.run("codex", { prompt: "x" })).resolves.toEqual({ response: "ok" });
  });

  it("REGRESSION: expected chat-only embedding fallbacks do not open a healthy review provider's circuit", async () => {
    const chatOnlyCalls = vi.fn(async (_model: string, options: { text?: string[]; prompt?: string }) => {
      if (options.text) throw new Error("claude_code_no_embed");
      return { response: "review ok" };
    });
    const embedCalls = vi.fn(async () => ({ data: [[0.1, 0.2]] }));
    const route = routeProviders([
      { name: "claude-code", ai: { run: chatOnlyCalls } },
      { name: "ollama", ai: { run: embedCalls } },
    ]);

    for (let i = 0; i < 3; i += 1) {
      await expect(route.run("@cf/baai/bge-m3", { text: ["rag query"] })).resolves.toEqual({ data: [[0.1, 0.2]] });
    }

    expect(chatOnlyCalls).toHaveBeenCalledTimes(3);
    expect(embedCalls).toHaveBeenCalledTimes(3);
    await expect(route.run("claude-code", { prompt: "review this" })).resolves.toEqual({ response: "review ok" });
    expect(chatOnlyCalls).toHaveBeenCalledTimes(4);
    const metrics = await renderMetrics();
    expect(metrics).not.toContain('gittensory_ai_provider_failures_total{provider="claude-code"}');
    expect(metrics).not.toContain('gittensory_ai_provider_circuit_open_total{provider="claude-code"}');
  });

  it("does not affect isAiProviderHealthy / aiConsecutiveFailures — independent whole-chain streak", async () => {
    const flaky = { name: "flaky-provider-3", ai: { run: async () => { throw new Error("down"); } } };
    for (let i = 0; i < 3; i += 1) {
      await expect(createChainAi([flaky]).run("m", { prompt: "x" })).rejects.toThrow();
    }
    // The whole-chain exhaustion streak (a SEPARATE counter) also reaches its own threshold here since every
    // call exhausted the (single-provider) chain — a circuit-open throw still counts as a chain exhaustion.
    expect(isAiProviderHealthy()).toBe(false);
  });
});

describe("isAiProviderHealthy (readiness streak, #2497)", () => {
  const failing = { name: "a", ai: { run: async () => { throw new Error("down"); } } };
  const working = { name: "a", ai: { run: async () => ({ response: "ok" }) } };

  it("reports healthy before any AI call has happened", () => {
    expect(isAiProviderHealthy()).toBe(true);
  });

  it("absorbs fewer than 3 consecutive full-chain exhaustions without going unhealthy", async () => {
    await expect(createChainAi([failing]).run("m", { prompt: "x" })).rejects.toThrow();
    await expect(createChainAi([failing]).run("m", { prompt: "x" })).rejects.toThrow();
    expect(isAiProviderHealthy()).toBe(true);
  });

  it("goes unhealthy after 3 consecutive full-chain exhaustions", async () => {
    for (let i = 0; i < 3; i += 1) {
      await expect(createChainAi([failing]).run("m", { prompt: "x" })).rejects.toThrow();
    }
    expect(isAiProviderHealthy()).toBe(false);
  });

  it("a success resets the streak back to healthy", async () => {
    vi.useFakeTimers();
    for (let i = 0; i < 3; i += 1) {
      await expect(createChainAi([failing]).run("m", { prompt: "x" })).rejects.toThrow();
    }
    expect(isAiProviderHealthy()).toBe(false);

    // Provider "a" tripped its own circuit breaker (#2540) after those 3 failures; advance past its cooldown so
    // the success below reaches the real (working) provider instead of a fast circuit_open rejection.
    await vi.advanceTimersByTimeAsync(60_001);
    await expect(createChainAi([working]).run("m", { prompt: "x" })).resolves.toEqual({ response: "ok" });
    expect(isAiProviderHealthy()).toBe(true);
    vi.useRealTimers();
  });

  it("regression: markAiProviderUnhealthyAtBoot reports unhealthy immediately, before any AI call (#2497 follow-up)", () => {
    // The original gap: a missing required CLI binary is a real, immediately-known misconfiguration, but the
    // pure call-streak design only reported it after 3 real (webhook-triggered) AI-call failures -- a fresh
    // process with a broken CLI provider and no traffic yet stayed "healthy" indefinitely.
    expect(isAiProviderHealthy()).toBe(true);
    markAiProviderUnhealthyAtBoot();
    expect(isAiProviderHealthy()).toBe(false);
  });

  it("a success after markAiProviderUnhealthyAtBoot still recovers the streak normally", async () => {
    markAiProviderUnhealthyAtBoot();
    expect(isAiProviderHealthy()).toBe(false);

    await expect(createChainAi([working]).run("m", { prompt: "x" })).resolves.toEqual({ response: "ok" });
    expect(isAiProviderHealthy()).toBe(true);
  });

  it("regression: direct provider-name review failures update readiness", async () => {
    const directFailing = { name: "openai", ai: { run: vi.fn(async () => { throw new Error("ai_http_401"); }) } };
    const route = routeProviders([directFailing]);

    await expect(route.run("openai", { prompt: "x" })).rejects.toThrow(/ai_http_401/);
    await expect(route.run("openai", { prompt: "x" })).rejects.toThrow(/ai_http_401/);
    expect(isAiProviderHealthy()).toBe(true);

    await expect(route.run("openai", { prompt: "x" })).rejects.toThrow(/ai_http_401|circuit_open/);
    expect(isAiProviderHealthy()).toBe(false);
  });

  it("direct provider-name review success resets readiness after direct failures", async () => {
    let shouldFail = true;
    const direct = { name: "openai", ai: { run: vi.fn(async () => {
      if (shouldFail) throw new Error("ai_http_401");
      return { response: "ok" };
    }) } };
    const route = routeProviders([direct]);

    for (let i = 0; i < 3; i += 1) {
      await expect(route.run("openai", { prompt: "x" })).rejects.toThrow();
    }
    expect(isAiProviderHealthy()).toBe(false);

    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(60_001);
      shouldFail = false;
      await expect(route.run("openai", { prompt: "x" })).resolves.toEqual({ response: "ok" });
      expect(isAiProviderHealthy()).toBe(true);
    } finally {
      // Guarantee real timers are restored even if an assertion above throws, so a failure here can't leak
      // fake-timer state into later tests in this file/worker.
      vi.useRealTimers();
    }
  });
});

describe("shouldMarkAiProviderUnhealthyAtBoot (#2497 follow-up)", () => {
  it("returns false when nothing is missing", () => {
    expect(shouldMarkAiProviderUnhealthyAtBoot(["claude-code"], [])).toBe(false);
  });

  it("returns false when no provider is configured at all", () => {
    expect(shouldMarkAiProviderUnhealthyAtBoot([], [])).toBe(false);
  });

  it("returns false when missingCliProviders is nonempty but nothing is actually configured (defensive branch)", () => {
    // Shouldn't happen by construction (resolveRequiredCliProviders is derived from resolveProviderNames), but
    // the function must not treat "some missing set exists" as "the configured chain is broken" when there is
    // no configured chain at all -- covers the configured.size === 0 branch independently of the earlier
    // missingCliProviders.length === 0 short-circuit.
    expect(shouldMarkAiProviderUnhealthyAtBoot([], ["claude-code"])).toBe(false);
  });

  it("returns true for a single configured CLI provider whose CLI is missing", () => {
    expect(shouldMarkAiProviderUnhealthyAtBoot(["claude-code"], ["claude-code"])).toBe(true);
  });

  it("regression: returns false for a mixed chain where only ONE provider's CLI is missing and a fallback exists", () => {
    // The bug the gate's review caught: an earlier version force-marked the whole ai_provider probe
    // unhealthy for ANY missing CLI, even when AI_PROVIDER listed a working non-CLI (or another
    // present-CLI) fallback that routeProviders would actually fall through to.
    expect(shouldMarkAiProviderUnhealthyAtBoot(["claude-code", "anthropic"], ["claude-code"])).toBe(false);
  });

  it("returns false for a mixed chain of two CLI providers when only one is missing", () => {
    expect(shouldMarkAiProviderUnhealthyAtBoot(["claude-code", "codex"], ["codex"])).toBe(false);
  });

  it("returns true when EVERY configured provider is a missing CLI (the whole chain has zero chance of working)", () => {
    expect(shouldMarkAiProviderUnhealthyAtBoot(["claude-code", "codex"], ["claude-code", "codex"])).toBe(true);
  });

  it("returns false for an HTTP-only chain, since resolveRequiredCliProviders never reports one as missing", () => {
    expect(shouldMarkAiProviderUnhealthyAtBoot(["anthropic"], [])).toBe(false);
  });
});

describe("routeProviders (#dual-ai-combiner — address one provider by name for dual review)", () => {
  // The mock echoes back the MODEL it received, so we can assert the router never passes the provider NAME
  // through as a model id (`claude --model claude-code` would fail — the bug this guards).
  const mk = (name: string) => ({ name, ai: { run: vi.fn(async (model: string) => ({ response: `${name}|${model}` })) } });

  it("routes .run(<providerName>) to THAT provider with an EMPTY model (→ provider default), never the name", async () => {
    const cc = mk("claude-code");
    const cx = mk("codex");
    const route = routeProviders([cc, cx]);
    expect((await route.run("codex", { prompt: "x" })).response).toBe("codex|"); // direct; model is "" (default), NOT "codex"
    expect(cx.ai.run).toHaveBeenCalledTimes(1);
    expect(cc.ai.run).not.toHaveBeenCalled();
    expect((await route.run("  CODEX ", { prompt: "x" })).response).toBe("codex|"); // case-insensitive + trimmed
    expect((await route.run("@cf/some/model", { prompt: "x" })).response).toBe("claude-code|@cf/some/model"); // non-name → chain → first, model passed through
  });

  it("a `<provider>:<model>` id hands that provider the explicit model", async () => {
    const cc = mk("claude-code");
    const cx = mk("codex");
    expect((await routeProviders([cc, cx]).run("claude-code:opus", { prompt: "x" })).response).toBe("claude-code|opus");
  });

  it("the chain fallback still skips a failed provider for a non-name model id", async () => {
    const fail = { name: "claude-code", ai: { run: vi.fn(async () => { throw new Error("down"); }) } };
    const ok = mk("codex");
    expect((await routeProviders([fail, ok]).run("sonnet", { prompt: "x" })).response).toBe("codex|sonnet"); // chain passes the real model through
  });

  it("createSelfHostAi wires routing for a 2+ provider AI_PROVIDER (addressable by name)", async () => {
    const ai = createSelfHostAi({ AI_PROVIDER: "anthropic,ollama", ANTHROPIC_API_KEY: "sk-ant", OLLAMA_AI_BASE_URL: "http://o/v1" });
    expect(typeof ai?.run).toBe("function");
  });

  it("provider routing labels usage with the selected provider when the adapter omits it", async () => {
    const ai = createChainAi([
      {
        name: "codex",
        ai: {
          run: async () => ({ response: "ok", usage: { inputTokens: 3, outputTokens: 2 } }),
        },
      },
    ]);
    await expect(ai.run("gpt-5.5", { prompt: "x" })).resolves.toMatchObject({
      response: "ok",
      usage: {
        provider: "codex",
        model: "gpt-5.5",
        inputTokens: 3,
        outputTokens: 2,
      },
    });
  });

  it("provider routing falls back to \"default\" when both the adapter's usage AND the requested model are empty", async () => {
    const ai = createChainAi([
      {
        name: "codex",
        ai: {
          run: async () => ({ response: "ok", usage: { inputTokens: 3 } }),
        },
      },
    ]);
    await expect(ai.run("", { prompt: "x" })).resolves.toMatchObject({
      response: "ok",
      usage: { provider: "codex", model: "default", inputTokens: 3 },
    });
  });

  it("createSelfHostAi routes a SINGLE provider through the router too — a name address yields the provider default, never `--model <provider>` (#1610)", async () => {
    // Regression (#1610): a single-provider self-host returned env.AI as the BARE provider, so the reviewer plan's
    // name address ({ model: "openai-compatible" } — or "claude-code") reached it as a model id. `claude --model
    // claude-code` 404'd and broke EVERY review. The router must strip the name to the provider's own default.
    let sentModel = "";
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: { body: string }) => {
      sentModel = (JSON.parse(init.body) as { model: string }).model;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    }));
    const ai = createSelfHostAi({ AI_PROVIDER: "openai-compatible", OPENAI_COMPATIBLE_AI_BASE_URL: "http://o/v1" });
    await ai?.run("openai-compatible", { prompt: "x" }); // the single-provider reviewer-plan address IS the provider name
    expect(sentModel).toBe("llama3.1"); // resolveModel(undefined, "", "llama3.1") — NOT the literal "openai-compatible"
  });

  it("AI_PROVIDER=openai defaults to an OpenAI model when OPENAI_AI_MODEL is unset", async () => {
    let sentModel = "";
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: { body: string }) => {
      sentModel = (JSON.parse(init.body) as { model: string }).model;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    }));
    const ai = createSelfHostAi({ AI_PROVIDER: "openai", OPENAI_API_KEY: "sk-test" });
    await ai?.run("openai", { prompt: "x" });
    expect(sentModel).toBe("gpt-5.5");
  });
});

describe("resolveProviderNames + resolveAiReviewerPlan (#dual-ai-combiner)", () => {
  it("resolveProviderNames: credentialed providers only, in order, lowercased/trimmed", () => {
    expect(resolveProviderNames({})).toEqual([]);
    expect(resolveProviderNames({ AI_PROVIDER: "  Claude-Code , CODEX " })).toEqual(["claude-code", "codex"]); // CLI providers always credentialed
    expect(resolveProviderNames({ AI_PROVIDER: "anthropic,ollama" })).toEqual(["ollama"]); // anthropic dropped (no key); ollama needs none
    expect(resolveProviderNames({ AI_PROVIDER: "anthropic,ollama", ANTHROPIC_API_KEY: "sk-ant" })).toEqual(["anthropic", "ollama"]);
    expect(resolveProviderNames({ AI_PROVIDER: "openai,ollama" })).toEqual(["ollama"]); // openai requires OPENAI_API_KEY
  });

  it("resolveRequiredCliProviders mirrors comma-list AI_PROVIDER parsing for boot preflight", () => {
    expect(resolveRequiredCliProviders({})).toEqual([]);
    expect(resolveRequiredCliProviders({ AI_PROVIDER: "ollama,anthropic" })).toEqual([]);
    expect(resolveRequiredCliProviders({ AI_PROVIDER: "  Claude-Code , CODEX , ollama " })).toEqual([
      { provider: "claude-code", cli: "claude" },
      { provider: "codex", cli: "codex" },
    ]);
    expect(resolveRequiredCliProviders({ AI_PROVIDER: "claude-code,codex,claude-code" })).toEqual([
      { provider: "claude-code", cli: "claude" },
      { provider: "codex", cli: "codex" },
    ]);
  });

  it("resolveAiReviewerPlan: undefined with no provider; single provider stays single", () => {
    expect(resolveAiReviewerPlan({})).toBeUndefined(); // cloud / AI off
    expect(resolveAiReviewerPlan({ AI_PROVIDER: "claude-code" })).toEqual({ reviewers: [{ model: "claude-code" }], combine: "single", onMerge: undefined });
  });

  it("resolveAiReviewerPlan: comma-list is a single-reviewer fallback chain by default", () => {
    expect(resolveAiReviewerPlan({ AI_PROVIDER: "codex,claude-code" })).toEqual({
      reviewers: [{ model: "codex", fallback: "claude-code" }],
      combine: "single",
      onMerge: undefined,
    });
    expect(resolveAiReviewerPlan({ AI_PROVIDER: "codex,codex,claude-code" })).toEqual({
      reviewers: [{ model: "codex", fallback: "claude-code" }],
      combine: "single",
      onMerge: undefined,
    });
    expect(resolveAiReviewerPlan({ AI_PROVIDER: "codex,claude-code,ollama", AI_COMBINE: "consensus", AI_ON_MERGE: "both" })).toEqual({
      reviewers: [{ model: "codex", fallback: "claude-code" }],
      combine: "single",
      onMerge: undefined,
    });
  });

  it("resolveAiReviewerPlan: AI_DUAL_REVIEW=1 restores two independent reviewers and combine controls", () => {
    expect(resolveAiReviewerPlan({ AI_PROVIDER: "claude-code,codex", AI_DUAL_REVIEW: "1" })).toEqual({
      reviewers: [{ model: "claude-code" }, { model: "codex" }],
      combine: "synthesis",
      onMerge: undefined,
    });
    expect(resolveAiReviewerPlan({ AI_PROVIDER: "claude-code,codex", AI_DUAL_REVIEW: "true", AI_COMBINE: "consensus", AI_ON_MERGE: "both" })).toMatchObject({ combine: "consensus", onMerge: "both" });
    expect(resolveAiReviewerPlan({ AI_PROVIDER: "claude-code,codex", AI_DUAL_REVIEW: "yes", AI_COMBINE: "garbage", AI_ON_MERGE: "nonsense" })).toMatchObject({ combine: "synthesis", onMerge: undefined }); // invalid → defaults
    expect(resolveAiReviewerPlan({ AI_PROVIDER: "claude-code,codex,ollama", AI_DUAL_REVIEW: "on" })?.reviewers).toEqual([{ model: "claude-code" }, { model: "codex" }]); // first two
  });

  it("resolveAiReviewerPlan: throws when the two dual-review slots resolve to the SAME provider (#2540)", () => {
    // "codex,codex" → both dual-review slots are the literal same provider. routeProviders' byName map
    // collapses duplicate names to one runtime instance, so this would silently degrade "dual review" into
    // "one provider called twice" with no independent second opinion. Fail loud at plan-resolution time
    // instead of degrading silently.
    expect(() => resolveAiReviewerPlan({ AI_PROVIDER: "codex,codex", AI_DUAL_REVIEW: "1" })).toThrow(/ai_reviewer_providers_not_distinct/);
    expect(() => resolveAiReviewerPlan({ AI_PROVIDER: "codex,codex", AI_DUAL_REVIEW: "1" })).toThrow(/"codex"/);
  });

  it("resolveAiReviewerPlan: a THIRD-slot duplicate does not throw (only the first two slots are actually used)", () => {
    // "codex,ollama,codex" — the first two names (codex, ollama) are distinct, so the plan resolves normally;
    // the trailing repeat of codex is never addressed because reviewers are capped at the first two.
    expect(resolveAiReviewerPlan({ AI_PROVIDER: "codex,ollama,codex", AI_DUAL_REVIEW: "1" })).toMatchObject({
      reviewers: [{ model: "codex" }, { model: "ollama" }],
      combine: "synthesis",
    });
  });

  it("labels explicit provider:model reviewer ids without consulting env defaults", () => {
    expect(labelSelfHostReviewerModel(" CODEX:gpt-5.5 ", { CODEX_AI_MODEL: "ignored" })).toBe("codex:gpt-5.5");
  });

  it("labels primary→fallback reviewer chains with provider-specific configured models", () => {
    expect(labelSelfHostReviewerModels([{ model: "codex", fallback: "claude-code" }], { CODEX_AI_MODEL: "gpt-5.5", CLAUDE_AI_MODEL: "claude-sonnet-4-6" })).toBe("codex:gpt-5.5->claude-code:claude-sonnet-4-6");
  });
});

describe("branch coverage — defaults + edge inputs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetMetrics();
  });

  it("chat with no apiKey + empty choices → empty response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })));
    expect((await createOpenAiCompatibleAi({ baseUrl: "http://o/v1" }).run("m", { prompt: "x" })).response).toBe("");
  });
  it("embed with no data field → empty data", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));
    expect((await createOpenAiCompatibleAi({ baseUrl: "http://o/v1" }).run("m", { text: ["a"] })).data).toEqual([]);
  });
  it("anthropic with no system + missing/empty content → empty response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ content: [{ type: "text" }] }), { status: 200 })));
    expect((await createAnthropicAi({ apiKey: "k" }).run("m", { messages: [{ role: "user", content: "x" }] })).response).toBe("");
  });
  it("extractCliText: non-string result falls through to text", () => {
    expect(extractCliText(JSON.stringify({ result: 5 }))).toBe("");
    expect(extractCliText(JSON.stringify({ text: "t" }))).toBe("t");
  });
  it("extractCliUsage reads common JSON and JSONL token/cost fields", () => {
    expect(extractCliUsage("")).toEqual({});
    expect(extractCliUsage("not json")).toEqual({});
    expect(
      extractCliUsage(
        [
          JSON.stringify({ usage: { input_tokens: 10, outputTokens: "5", total_tokens: 15 }, model: "gpt-5" }),
          "",
          JSON.stringify({ tokenUsage: { prompt_tokens: 12, completion_tokens: 6, totalTokens: 18 }, total_cost_usd: "0.07" }),
          JSON.stringify({ usage_metadata: { costUsd: 0.09 } }),
        ].join("\n"),
      ),
    ).toEqual({ inputTokens: 12, outputTokens: 6, totalTokens: 18, costUsd: 0.09, model: "gpt-5" });
  });
  it("claudeErrorStatus: subtype + unknown fallbacks", () => {
    expect(claudeErrorStatus(JSON.stringify({ is_error: true, subtype: "sub" }))).toBe("sub");
    expect(claudeErrorStatus(JSON.stringify({ is_error: true }))).toBe("unknown");
  });
  it("claude/codex with a null exit code", async () => {
    const nullExit: StubSpawn = async () => ({ stdout: "", code: null });
    await expect(createClaudeCodeAi({ CLAUDE_CODE_OAUTH_TOKEN: "t" }, nullExit).run("m", { prompt: "x" })).rejects.toThrow(/claude_code_exit_null/);
    await expect(createCodexAi({ GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1" }, nullExit, noAuthCheck).run("m", { prompt: "x" })).rejects.toThrow(/codex_exit_null/);
  });
  it("embed uses the bge-m3 default when no embedModel is set", async () => {
    let sentModel = "";
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: { body: string }) => {
      sentModel = JSON.parse(init.body).model;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }));
    await createOpenAiCompatibleAi({ baseUrl: "http://o/v1" }).run("m", { text: ["a"] });
    expect(sentModel).toBe("bge-m3");
  });
  it("anthropic with no content field → empty response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));
    expect((await createAnthropicAi({ apiKey: "k" }).run("m", { prompt: "x" })).response).toBe("");
  });
  it("anthropic maps assistant-role messages to the 'assistant' role", async () => {
    let sentMessages: Array<{ role: string; content: string }> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: { body: string }) => {
      sentMessages = (JSON.parse(init.body) as { messages: Array<{ role: string; content: string }> }).messages;
      return new Response(JSON.stringify({ content: [{ type: "text", text: "hi" }] }), { status: 200 });
    }));
    await createAnthropicAi({ apiKey: "k" }).run("m", {
      messages: [
        { role: "assistant", content: "prior reply" },
        { role: "user", content: "follow-up" },
      ],
    });
    expect(sentMessages).toEqual([
      { role: "assistant", content: "prior reply" },
      { role: "user", content: "follow-up" },
    ]);
  });
  it("buildProvider uses provider-specific default base URLs when provider base URLs are unset", () => {
    expect(buildProvider("openai", {})).toBeUndefined(); // openai is credentialed and requires OPENAI_API_KEY
    expect(typeof buildProvider("openai", { OPENAI_API_KEY: "sk-test" })?.run).toBe("function"); // defaults to https://api.openai.com/v1
    expect(typeof buildProvider("ollama", {})?.run).toBe("function"); // defaults to http://localhost:11434/v1
    expect(typeof buildProvider("openai-compatible", {})?.run).toBe("function"); // defaults to http://localhost:11434/v1
    expect(buildProvider("anthropic", {})).toBeUndefined(); // anthropic is credentialed and requires ANTHROPIC_API_KEY
    expect(typeof buildProvider("anthropic", { ANTHROPIC_API_KEY: "sk-ant" })?.run).toBe("function");
  });
  it("extractCliText reads content + response fields", () => {
    expect(extractCliText(JSON.stringify({ content: "c" }))).toBe("c");
    expect(extractCliText(JSON.stringify({ response: "r" }))).toBe("r");
    expect(extractCliText(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "codex ok" } }))).toBe("codex ok");
    expect(extractCliText(JSON.stringify({ type: "item.completed", item: { content: [{ type: "output_text", text: "codex " }, { type: "output_text", text: "ok" }] } }))).toBe("codex ok");
  });
  it("chain wraps a non-Error throw", async () => {
    const p = {
      name: "p",
      ai: {
        run: async () => {
          throw "stringerr";
        },
      },
    };
    await expect(createChainAi([p]).run("m", { prompt: "x" })).rejects.toThrow(/all_ai_providers_failed/);
    await expect(createChainAi([p]).run("", { prompt: "x" })).rejects.toThrow(/all_ai_providers_failed/);
  });
});

describe("subscriptionCliEnv (allowlist + extra-override arms)", () => {
  it("copies only allowlisted parent vars and drops everything else", () => {
    const child = subscriptionCliEnv({ PATH: "/bin", HOME: "/root", ANTHROPIC_API_KEY: "sk-bill", WORKER_ONLY_VALUE: "internal" });
    expect(child).toEqual({ PATH: resolveSubscriptionCliPath({ PATH: "/bin" }), HOME: "/root" });
  });
  it("repairs PATH with the image subscription CLI bin and optional npm prefix", () => {
    expect(resolveSubscriptionCliPath({ PATH: "/bin" }).split(delimiter).slice(0, 2)).toEqual(["/home/node/.npm-global/bin", "/bin"]);
    expect(resolveSubscriptionCliPath({ PATH: "/bin", NPM_CONFIG_PREFIX: "/custom/npm/" }).split(delimiter).slice(0, 3)).toEqual([
      "/custom/npm/bin",
      "/home/node/.npm-global/bin",
      "/bin",
    ]);
  });
  it("merges a defined extra value but skips an undefined one", () => {
    const child = subscriptionCliEnv({ PATH: "/bin" }, { CLAUDE_CODE_OAUTH_TOKEN: "t", UNSET: undefined });
    expect(child).toEqual({ PATH: resolveSubscriptionCliPath({ PATH: "/bin" }), CLAUDE_CODE_OAUTH_TOKEN: "t" }); // UNSET (undefined) skips the extra-loop false arm
  });
});

describe("subscription CLI helpers + fail-safe", () => {
  it("extractCliText pulls the result/text field", () => {
    expect(extractCliText(JSON.stringify({ type: "result", result: "ok" }))).toBe("ok");
    expect(extractCliText("")).toBe("");
  });
  it("claudeErrorStatus catches the is_error envelope", () => {
    expect(claudeErrorStatus(JSON.stringify({ is_error: true, api_error_status: 401 }))).toBe("401");
    expect(claudeErrorStatus(JSON.stringify({ is_error: false, result: "ok" }))).toBeNull();
  });
  it("Claude Code fails SAFE on an is_error envelope (exits 0) instead of surfacing the error text", async () => {
    const stub: StubSpawn = async () => ({ stdout: JSON.stringify({ is_error: true, api_error_status: 401, result: "Failed to authenticate" }), code: 0 });
    await expect(createClaudeCodeAi({ CLAUDE_CODE_OAUTH_TOKEN: "t" }, stub).run("m", { prompt: "x" })).rejects.toThrow(/claude_code_error_401/);
  });
  it("surfaces the structured stdout error on a NON-ZERO exit (precise status, not opaque exit code) (#1610)", async () => {
    // Regression: an unknown model exits 1 with the error envelope in STDOUT ({is_error,api_error_status:404}) and
    // EMPTY stderr. The exit-code throw used to win → `claude_code_exit_1: ` (blank, undiagnosable). Now the
    // structured status is checked first → `claude_code_error_404`, the signal that surfaces in logs + Sentry.
    const stub: StubSpawn = async () => ({ stdout: JSON.stringify({ is_error: true, api_error_status: 404, result: "There's an issue with the selected model (claude-code)." }), code: 1, stderr: "" });
    await expect(createClaudeCodeAi({ CLAUDE_CODE_OAUTH_TOKEN: "t" }, stub).run("m", { prompt: "x" })).rejects.toThrow(/claude_code_error_404/);
  });
  it("Claude Code returns the model text on success and scrubs billable keys", async () => {
    let capturedEnv: Record<string, string | undefined> = {};
    const stub: StubSpawn = async (_c, _a, o) => {
      capturedEnv = o.env;
      return { stdout: JSON.stringify({ type: "result", result: "review text" }), code: 0 };
    };
    const out = await createClaudeCodeAi({ CLAUDE_CODE_OAUTH_TOKEN: "t", ANTHROPIC_API_KEY: "sk-bill", WORKER_ONLY_VALUE: "internal" }, stub).run("sonnet", {
      prompt: "x",
    });
    expect(out.response).toBe("review text");
    expect(capturedEnv.ANTHROPIC_API_KEY).toBeUndefined(); // allowlisted subprocess env does not inherit metered API keys
    expect(capturedEnv.WORKER_ONLY_VALUE).toBeUndefined();
    expect(capturedEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe("t");
  });

  it("Claude Code pins the default model (claude-sonnet-5) + --effort medium; CLAUDE_AI_* overrides explicitly", async () => {
    let seen: string[] = [];
    let timeout = 0;
    const cap: StubSpawn = async (_c, a, o) => {
      seen = a;
      timeout = o.timeoutMs;
      return { stdout: JSON.stringify({ type: "result", result: "ok" }), code: 0 };
    };
    // Empty model id (the router default) + no CLAUDE_AI_MODEL → pinned claude-sonnet-5; unset effort → medium.
    await createClaudeCodeAi({ CLAUDE_CODE_OAUTH_TOKEN: "t" }, cap).run("", { prompt: "x" });
    expect(seen[seen.indexOf("--model") + 1]).toBe("claude-sonnet-5");
    expect(seen[seen.indexOf("--effort") + 1]).toBe("medium");
    expect(seen).not.toContain("--append-system-prompt");
    expect(timeout).toBe(120_000); // medium → 120s by default to conserve fallback subscription tokens
    // Provider-specific overrides flow through to the argv + timeout scale.
    await createClaudeCodeAi({ CLAUDE_CODE_OAUTH_TOKEN: "t", CLAUDE_AI_MODEL: "claude-opus-4-8", CLAUDE_AI_EFFORT: "max" }, cap).run("", { prompt: "x" });
    expect(seen[seen.indexOf("--model") + 1]).toBe("claude-opus-4-8");
    expect(seen[seen.indexOf("--effort") + 1]).toBe("max");
    expect(timeout).toBe(600_000); // max → 600s, so a large max-effort review isn't SIGKILLed at 120s
  });

  it("Claude Code's per-repo review.ai_model override (#selfhost-ai-model-override) outranks CLAUDE_AI_MODEL/CLAUDE_AI_EFFORT, which outrank the hardcoded default", async () => {
    let seen: string[] = [];
    const cap: StubSpawn = async (_c, a) => {
      seen = a;
      return { stdout: JSON.stringify({ type: "result", result: "ok" }), code: 0 };
    };
    // Global env set, but this call's per-repo override wins for both model and effort.
    await createClaudeCodeAi({ CLAUDE_CODE_OAUTH_TOKEN: "t", CLAUDE_AI_MODEL: "claude-opus-4-8", CLAUDE_AI_EFFORT: "max" }, cap).run("", {
      prompt: "x",
      claudeModel: "claude-haiku-4-5",
      claudeEffort: "low",
    });
    expect(seen[seen.indexOf("--model") + 1]).toBe("claude-haiku-4-5");
    expect(seen[seen.indexOf("--effort") + 1]).toBe("low");
    // No override on this call → falls through to the global env var, unaffected by the PRIOR call's override.
    await createClaudeCodeAi({ CLAUDE_CODE_OAUTH_TOKEN: "t", CLAUDE_AI_MODEL: "claude-opus-4-8", CLAUDE_AI_EFFORT: "max" }, cap).run("", { prompt: "x" });
    expect(seen[seen.indexOf("--model") + 1]).toBe("claude-opus-4-8");
    expect(seen[seen.indexOf("--effort") + 1]).toBe("max");
    // No override AND no global env → falls all the way through to the hardcoded default.
    await createClaudeCodeAi({ CLAUDE_CODE_OAUTH_TOKEN: "t" }, cap).run("", { prompt: "x" });
    expect(seen[seen.indexOf("--model") + 1]).toBe("claude-sonnet-5");
    expect(seen[seen.indexOf("--effort") + 1]).toBe("medium");
  });

  it("Claude Code passes systemAppend through --append-system-prompt and strips the duplicate stdin copy (#1471)", async () => {
    const systemAppend = "REPOSITORY REVIEW INSTRUCTIONS: Follow async-error conventions.";
    let seen: string[] = [];
    let capturedInput = "";
    const cap: StubSpawn = async (_c, a, o) => {
      seen = a;
      capturedInput = o.input ?? "";
      return { stdout: JSON.stringify({ type: "result", result: "ok" }), code: 0 };
    };
    await createClaudeCodeAi({ CLAUDE_CODE_OAUTH_TOKEN: "t" }, cap).run("", {
      messages: [
        { role: "system", content: `Base system. ${systemAppend}` },
        { role: "user", content: "Review this diff." },
      ],
      systemAppend,
    });
    expect(seen[seen.indexOf("--append-system-prompt") + 1]).toBe(systemAppend);
    expect(capturedInput).toContain("Base system.");
    expect(capturedInput).toContain("Review this diff.");
    expect(capturedInput).not.toContain(systemAppend);

    await createClaudeCodeAi({ CLAUDE_CODE_OAUTH_TOKEN: "t" }, cap).run("", {
      prompt: "Review this diff.",
      systemAppend: "   ",
    });
    expect(seen).not.toContain("--append-system-prompt");
    expect(capturedInput).toBe("Review this diff.");
  });

  it("chat-only CLIs reject embeds so the chain routes embeddings to an embed-capable provider (Claude review + ollama embed)", async () => {
    const reviewOk: StubSpawn = async () => ({ stdout: JSON.stringify({ type: "result", result: "the review" }), code: 0 });
    // A stand-in embed-capable provider (e.g. ollama): returns `data` for an embed request, `response` for chat.
    const embedder = { name: "ollama", ai: { run: async (_m: string, o: { text?: string[] }) => (o.text ? { data: o.text.map(() => [0.1, 0.2]) } : { response: "ollama chat" }) } };
    const claudeChain = createChainAi([{ name: "claude-code", ai: createClaudeCodeAi({ CLAUDE_CODE_OAUTH_TOKEN: "t" }, reviewOk) }, embedder]);
    // A CHAT/review request is served by claude-code (the frontier reviewer), never the embedder.
    expect((await claudeChain.run("m", { prompt: "review this" })).response).toBe("the review");
    // An EMBED request makes claude-code throw → the chain falls through to ollama, which returns vectors.
    expect((await claudeChain.run("bge-m3", { text: ["a", "b"] })).data?.length).toBe(2);
    // Same for codex as the frontier reviewer.
    const codexOk: StubSpawn = async () => ({ stdout: JSON.stringify({ type: "result", result: "codex review" }), code: 0 });
    const codexChain = createChainAi([{ name: "codex", ai: createCodexAi({ GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1" }, codexOk) }, embedder]);
    expect((await codexChain.run("bge-m3", { text: ["a"] })).data?.length).toBe(1);
  });

  it("Codex: 0.142+ exec flags, stdin prompt, explicit CODEX_AI_* config", async () => {
    let seen: string[] = [];
    let capturedEnv: Record<string, string | undefined> = {};
    let capturedCwd = "";
    let capturedInput: string | undefined;
    let timeout = 0;
    const ok: StubSpawn = async (_cmd, args, opts) => {
      seen = args;
      capturedEnv = opts.env;
      capturedCwd = opts.cwd ?? "";
      capturedInput = opts.input;
      timeout = opts.timeoutMs;
      return { stdout: JSON.stringify({ type: "result", result: "codex review" }), code: 0 };
    };
    // No configured model + the dual-router's empty model id → omit --model (Codex picks the account default).
    expect(
      (await createCodexAi({ PATH: "/bin", WORKER_ONLY_VALUE: "internal", OPENAI_API_KEY: "sk-bill", CODEX_AI_TIMEOUT_MS: "300000", GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1" }, ok, noAuthCheck).run("", {
        prompt: "x",
      })).response,
    ).toBe("codex review");
    expect(seen).toEqual(["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "-c", 'model_reasoning_effort="medium"']);
    expect(seen).not.toContain("--ask-for-approval");
    expect(seen).not.toContain("x");
    expect(capturedInput).toBe("x");
    expect(capturedEnv).toEqual({ PATH: resolveSubscriptionCliPath({ PATH: "/bin" }) });
    expect(capturedCwd).toContain("gittensory-ai-");
    expect(timeout).toBe(300_000);
    // Provider-specific model/effort are passed through.
    await createCodexAi({ CODEX_AI_MODEL: "gpt-5.5", CODEX_AI_EFFORT: "high", GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1" }, ok, noAuthCheck).run("", { prompt: "x" });
    expect(seen.join(" ")).toContain("--model gpt-5.5");
    expect(seen.join(" ")).toContain('model_reasoning_effort="high"');
    expect(capturedEnv.CODEX_AI_MODEL).toBeUndefined();
    const bad: StubSpawn = async () => ({ stdout: "", code: 1 });
    await expect(createCodexAi({ GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1" }, bad, noAuthCheck).run("", { prompt: "x" })).rejects.toThrow(/codex_exit_1/);
  });

  it("Codex's per-repo review.ai_model override (#selfhost-ai-model-override) outranks CODEX_AI_MODEL/CODEX_AI_EFFORT, which outrank the account default", async () => {
    let seen: string[] = [];
    const ok: StubSpawn = async (_c, a) => {
      seen = a;
      return { stdout: JSON.stringify({ type: "result", result: "codex review" }), code: 0 };
    };
    // Global env set, but this call's per-repo override wins for both model and effort.
    await createCodexAi({ CODEX_AI_MODEL: "gpt-5.5", CODEX_AI_EFFORT: "high", GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1" }, ok, noAuthCheck).run("", {
      prompt: "x",
      codexModel: "gpt-5.4-mini",
      codexEffort: "low",
    });
    expect(seen.join(" ")).toContain("--model gpt-5.4-mini");
    expect(seen.join(" ")).toContain('model_reasoning_effort="low"');
    // No override on this call → falls through to the global env var.
    await createCodexAi({ CODEX_AI_MODEL: "gpt-5.5", CODEX_AI_EFFORT: "high", GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1" }, ok, noAuthCheck).run("", { prompt: "x" });
    expect(seen.join(" ")).toContain("--model gpt-5.5");
    expect(seen.join(" ")).toContain('model_reasoning_effort="high"');
    // No override AND no global env → no --model flag at all (Codex picks the account default), effort medium.
    await createCodexAi({ GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1" }, ok, noAuthCheck).run("", { prompt: "x" });
    expect(seen).not.toContain("--model");
    expect(seen.join(" ")).toContain('model_reasoning_effort="medium"');
  });

  it("Codex prepends systemAppend to stdin once and strips an existing system copy (#1471)", async () => {
    const systemAppend = "REPOSITORY REVIEW INSTRUCTIONS: Follow async-error conventions.";
    let capturedInput = "";
    const ok: StubSpawn = async (_cmd, _args, opts) => {
      capturedInput = opts.input ?? "";
      return { stdout: JSON.stringify({ type: "result", result: "codex review" }), code: 0 };
    };
    await createCodexAi({ GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1" }, ok, noAuthCheck).run("", {
      messages: [
        { role: "system", content: `Base system. ${systemAppend}` },
        { role: "user", content: "Review this diff." },
      ],
      systemAppend,
    });
    expect(capturedInput.startsWith("ADDITIONAL SYSTEM INSTRUCTIONS:\n")).toBe(true);
    expect(countOccurrences(capturedInput, systemAppend)).toBe(1);
    expect(capturedInput).toContain("Base system.");
    expect(capturedInput).toContain("Review this diff.");

    await createCodexAi({ GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1" }, ok, noAuthCheck).run("", {
      messages: [
        { role: "system", content: "Base system without the append block." },
        { role: "user", content: "Review this diff." },
      ],
      systemAppend,
    });
    expect(countOccurrences(capturedInput, systemAppend)).toBe(1);
    expect(capturedInput).toContain("Base system without the append block.");
  });

  it("drives the REAL subprocess (defaultSpawn) against a fake `claude` on PATH", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fakecli-"));
    const fake = join(dir, "claude");
    // a minimal stand-in: read the prompt on stdin, emit a Claude-Code-shaped JSON result
    writeFileSync(fake, "#!/usr/bin/env node\nlet i='';process.stdin.on('data',d=>i+=d);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({type:'result',result:'OK:'+i.trim()})));\n");
    chmodSync(fake, 0o755);
    const origPath = process.env.PATH;
    process.env.PATH = `${dir}:${origPath ?? ""}`;
    try {
      const out = await createClaudeCodeAi({ ...process.env, CLAUDE_CODE_OAUTH_TOKEN: "t" }).run("sonnet", { prompt: "hello" });
      expect(out.response).toBe("OK:hello");
    } finally {
      process.env.PATH = origPath;
    }
  });

  it("drives the REAL subprocess (defaultSpawn) against a fake `codex` on PATH", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fakecli-"));
    const fake = join(dir, "codex");
    writeFileSync(fake, "#!/usr/bin/env node\nlet i='';process.stdin.on('data',d=>i+=d);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({type:'result',result:'OK:'+i.trim()})));\n");
    chmodSync(fake, 0o755);
    const origPath = process.env.PATH;
    try {
      const out = await createCodexAi({ PATH: `${dir}:${origPath ?? ""}`, HOME: dir, GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1" }, undefined, noAuthCheck).run("", { prompt: "hello" });
      expect(out.response).toBe("OK:hello");
    } finally {
      process.env.PATH = origPath;
    }
  });

  // REGRESSION (GITTENSORY-K/GITTENSORY-M): the real defaultSpawn fast-fail path against a genuinely-hung fake
  // `codex` that writes ABSOLUTELY NOTHING to either stream (the worst case of the prod hang — even the startup
  // banner never lands, e.g. the binary itself is stuck loading) and never exits. CODEX_AI_FIRST_OUTPUT_TIMEOUT_MS
  // is set to a tiny value (not the 30s default) so this test resolves in milliseconds instead of actually
  // waiting the production deadline out — same "inject a fast/controllable timer" approach the existing
  // full-timeout tests use (a stub spawn) but here exercising the REAL setTimeout/kill wiring in defaultSpawn
  // itself, since the fast path lives entirely inside that function rather than in createCodexAi's own logic.
  it("REAL subprocess: a fake codex that never writes to either stream is killed at the fast-fail deadline, not the full timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fakecli-"));
    const fake = join(dir, "codex");
    // Consumes stdin, writes NOTHING to stdout or stderr, then hangs forever (no exit) — the "neither stream
    // ever produced a byte" case the fast-fail deadline exists to catch quickly.
    writeFileSync(fake, "#!/usr/bin/env node\nprocess.stdin.on('data',()=>{});\nsetInterval(()=>{},1000);\n");
    chmodSync(fake, 0o755);
    const origPath = process.env.PATH;
    try {
      const start = Date.now();
      await expect(
        createCodexAi(
          {
            PATH: `${dir}:${origPath ?? ""}`,
            HOME: dir,
            GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1",
            // Full timeout stays large (60s) so a false-pass (hitting the FULL timeout instead of the fast one)
            // would make this test hang for a minute rather than silently succeed for the wrong reason.
            CODEX_AI_TIMEOUT_MS: "60000",
            CODEX_AI_FIRST_OUTPUT_TIMEOUT_MS: "200",
          },
          undefined,
          noAuthCheck,
        ).run("", { prompt: "hello" }),
      ).rejects.toThrow(/codex_stalled_no_output/);
      // Killed at ~200ms (the fast-fail deadline), nowhere near the 60_000ms full timeout.
      expect(Date.now() - start).toBeLessThan(5_000);
    } finally {
      process.env.PATH = origPath;
    }
  }, 10_000);

  // (b) unaffected path: output flows immediately and the process completes normally — byte-identical to today.
  it("REAL subprocess: a fake codex that emits output quickly and completes normally is unaffected by the fast-fail deadline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fakecli-"));
    const fake = join(dir, "codex");
    writeFileSync(
      fake,
      "#!/usr/bin/env node\nlet i='';process.stdin.on('data',d=>i+=d);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({type:'result',result:'OK:'+i.trim()})));\n",
    );
    chmodSync(fake, 0o755);
    const origPath = process.env.PATH;
    try {
      const out = await createCodexAi(
        {
          PATH: `${dir}:${origPath ?? ""}`,
          HOME: dir,
          GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1",
          CODEX_AI_FIRST_OUTPUT_TIMEOUT_MS: "200",
        },
        undefined,
        noAuthCheck,
      ).run("", { prompt: "hello" });
      expect(out.response).toBe("OK:hello");
    } finally {
      process.env.PATH = origPath;
    }
  });

  // REGRESSION (caught in review of the first version of this fix): a fake codex that writes ONLY the real
  // "Reading prompt from stdin..." banner to STDERR — exactly what prod codex does on every invocation — and
  // then produces NOTHING on stdout and never exits. The first version of this fix cleared the fast-fail timer
  // on EITHER stream, so a stderr-only banner would have satisfied it forever and this exact hang (the one
  // GITTENSORY-K/M is actually about) would never have been caught until the full timeout. Must still fast-fail.
  it("REAL subprocess: a fake codex that writes ONLY the stderr startup banner and nothing on stdout is still killed at the fast-fail deadline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fakecli-"));
    const fake = join(dir, "codex");
    writeFileSync(
      fake,
      [
        "#!/usr/bin/env node",
        "process.stderr.write('Reading prompt from stdin...');",
        "process.stdin.on('data',()=>{});",
        "setInterval(()=>{},1000);",
      ].join("\n"),
    );
    chmodSync(fake, 0o755);
    const origPath = process.env.PATH;
    try {
      const start = Date.now();
      await expect(
        createCodexAi(
          {
            PATH: `${dir}:${origPath ?? ""}`,
            HOME: dir,
            GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1",
            CODEX_AI_TIMEOUT_MS: "60000",
            CODEX_AI_FIRST_OUTPUT_TIMEOUT_MS: "200",
          },
          undefined,
          noAuthCheck,
        ).run("", { prompt: "hello" }),
      ).rejects.toThrow(/codex_stalled_no_output/);
      expect(Date.now() - start).toBeLessThan(5_000);
    } finally {
      process.env.PATH = origPath;
    }
  }, 10_000);

  // (c) output arrives on STDOUT within the fast-fail window but full completion takes longer than that window
  // — must NOT be prematurely killed by the fast-fail path; only the (much larger) full timeoutMs still governs
  // it. Also writes the real stderr banner first (matching a genuinely-working codex invocation) to prove stderr
  // output alone is correctly ignored and it's the STDOUT byte that clears the deadline.
  it("REAL subprocess: stdout output within the fast-fail window but a slow completion is governed only by the full timeoutMs, not fast-failed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fakecli-"));
    const fake = join(dir, "codex");
    // Writes the stderr banner immediately (must NOT clear the fast-fail timer), then a stdout byte shortly after
    // (which DOES clear it), then waits LONGER than the fast-fail deadline (but well inside the full timeout)
    // before completing — proving the stdout timer's clearance is permanent and the process is not killed once
    // real output has already flowed.
    writeFileSync(
      fake,
      [
        "#!/usr/bin/env node",
        "process.stderr.write('Reading prompt from stdin...');",
        "setTimeout(()=>process.stdout.write(' '), 50);",
        "let i='';process.stdin.on('data',d=>i+=d);",
        "process.stdin.on('end',()=>{ setTimeout(()=>process.stdout.write(JSON.stringify({type:'result',result:'OK:'+i.trim()})), 400); });",
      ].join("\n"),
    );
    chmodSync(fake, 0o755);
    const origPath = process.env.PATH;
    try {
      const out = await createCodexAi(
        {
          PATH: `${dir}:${origPath ?? ""}`,
          HOME: dir,
          GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1",
          CODEX_AI_TIMEOUT_MS: "30000",
          // Shorter than the 400ms completion delay above, but the process must survive because a stdout byte
          // already arrived (at ~50ms) before this deadline — proving the fast-fail timer is truly cleared by
          // stdout, not merely deferred, and that the earlier stderr banner did not itself clear anything.
          CODEX_AI_FIRST_OUTPUT_TIMEOUT_MS: "150",
        },
        undefined,
        noAuthCheck,
      ).run("", { prompt: "hello" });
      // extractCliText trims the whole stdout string first, so the leading space byte (written purely to clear
      // the fast-fail timer at ~50ms) disappears before JSON parsing — the parsed result is exactly "OK:hello".
      expect(out.response).toBe("OK:hello");
    } finally {
      process.env.PATH = origPath;
    }
  }, 10_000);

  it("Claude Code throws on no-token / non-zero exit / empty output", async () => {
    await expect(createClaudeCodeAi({}).run("m", { prompt: "x" })).rejects.toThrow(/claude_code_no_oauth_token/);
    const exit1: StubSpawn = async () => ({ stdout: "", code: 1 });
    await expect(createClaudeCodeAi({ CLAUDE_CODE_OAUTH_TOKEN: "t" }, exit1).run("m", { prompt: "x" })).rejects.toThrow(/claude_code_exit_1/);
    const empty: StubSpawn = async () => ({ stdout: "", code: 0 });
    await expect(createClaudeCodeAi({ CLAUDE_CODE_OAUTH_TOKEN: "t" }, empty).run("m", { prompt: "x" })).rejects.toThrow(/claude_code_empty_output/);
    const metrics = await renderMetrics();
    expect(metrics).toContain('gittensory_ai_requests_total{effort="medium",model="m",provider="claude-code"} 2');
  });

  it("Codex throws on empty output", async () => {
    const empty: StubSpawn = async () => ({ stdout: "", code: 0 });
    await expect(
      createCodexAi({ GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1" }, empty, noAuthCheck).run("gpt-5", { prompt: "x" }),
    ).rejects.toThrow(/codex_empty_output/);
    const metrics = await renderMetrics();
    expect(metrics).toContain('gittensory_ai_requests_total{effort="medium",model="gpt-5",provider="codex"} 1');
  });

  it("Claude Code throws subscription_cli_timeout when the CLI is killed for exceeding its deadline", async () => {
    const timedOut: StubSpawn = async () => ({ stdout: "", code: null, timedOut: true });
    await expect(createClaudeCodeAi({ CLAUDE_CODE_OAUTH_TOKEN: "t" }, timedOut).run("m", { prompt: "x" })).rejects.toThrow(
      /subscription_cli_timeout/,
    );
  });

  it("REGRESSION (GITTENSORY-K/GITTENSORY-M): a stalled-no-output timeout is thrown as codex_stalled_no_output, distinct from codex_timeout, and passes firstOutputTimeoutMs through to spawn", async () => {
    let capturedOpts: { timeoutMs: number; firstOutputTimeoutMs?: number } | undefined;
    const stalled: StubSpawn = async (_cmd, _args, o) => {
      capturedOpts = o;
      return { stdout: "", code: null, stderr: "Reading prompt from stdin...", timedOut: true, stalledNoOutput: true };
    };
    await expect(
      createCodexAi({ GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1" }, stalled, noAuthCheck).run("m", { prompt: "x" }),
    ).rejects.toThrow(/codex_stalled_no_output/);
    // Never the generic message — the whole point is that these two failure modes are separately observable.
    await expect(
      createCodexAi({ GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1" }, stalled, noAuthCheck).run("m", { prompt: "x" }),
    ).rejects.not.toThrow(/^codex_timeout/);
    // The fast-fail deadline defaults to 30s and is strictly less than the (120s-default) full timeout.
    expect(capturedOpts?.firstOutputTimeoutMs).toBe(30_000);
    expect(capturedOpts?.timeoutMs).toBe(120_000);
    expect(capturedOpts?.firstOutputTimeoutMs).toBeLessThan(capturedOpts!.timeoutMs);
  });

  it("clamps firstOutputTimeoutMs below timeoutMs even when CODEX_AI_FIRST_OUTPUT_TIMEOUT_MS is configured >= the full timeout", async () => {
    let capturedOpts: { timeoutMs: number; firstOutputTimeoutMs?: number } | undefined;
    const ok: StubSpawn = async (_cmd, _args, o) => {
      capturedOpts = o;
      return { stdout: JSON.stringify({ type: "result", result: "hi" }), code: 0 };
    };
    await createCodexAi(
      { GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1", CODEX_AI_TIMEOUT_MS: "30000", CODEX_AI_FIRST_OUTPUT_TIMEOUT_MS: "30000" },
      ok,
      noAuthCheck,
    ).run("m", { prompt: "x" });
    expect(capturedOpts?.timeoutMs).toBe(30_000);
    // Would otherwise equal timeoutMs and make the outer safety net unreachable — clamped to timeoutMs - 1.
    expect(capturedOpts?.firstOutputTimeoutMs).toBe(29_999);
  });

  it("Codex on timeout prefers the JSONL error, then falls back to stderr, then a literal when both are empty", async () => {
    const withJsonlError: StubSpawn = async () => ({
      stdout: `${JSON.stringify({ type: "other" })}\n${JSON.stringify({ error: "model unavailable" })}`,
      code: null,
      stderr: "Reading prompt from stdin...",
      timedOut: true,
    });
    await expect(
      createCodexAi({ GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1" }, withJsonlError, noAuthCheck).run("m", { prompt: "x" }),
    ).rejects.toThrow(/codex_timeout: model unavailable/);

    const stderrOnly: StubSpawn = async () => ({ stdout: "", code: null, stderr: "connection reset", timedOut: true });
    await expect(
      createCodexAi({ GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1" }, stderrOnly, noAuthCheck).run("m", { prompt: "x" }),
    ).rejects.toThrow(/codex_timeout: connection reset/);

    const neitherOutput: StubSpawn = async () => ({ stdout: "", code: null, timedOut: true });
    await expect(
      createCodexAi({ GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1" }, neitherOutput, noAuthCheck).run("m", { prompt: "x" }),
    ).rejects.toThrow(/codex_timeout: no output/);
  });

  it("codexErrorFromStdout: scans JSONL lines in reverse for the first human-readable detail, across all shapes", () => {
    // top-level `error` string
    expect(codexErrorFromStdout(JSON.stringify({ error: "top-level error" }))).toBe("top-level error");
    // top-level `message` string
    expect(codexErrorFromStdout(JSON.stringify({ message: "top-level message" }))).toBe("top-level message");
    // top-level `msg` string
    expect(codexErrorFromStdout(JSON.stringify({ msg: "top-level msg" }))).toBe("top-level msg");
    // nested error.message string
    expect(codexErrorFromStdout(JSON.stringify({ error: { message: "nested error message" } }))).toBe("nested error message");
    // reverse scan: starting from the last line, non-JSON / blank / no-detail lines are skipped until an
    // earlier line yields a detail (also covers the `errorObj.message` non-string false path).
    const multiline = [
      JSON.stringify({ msg: "earliest usable detail" }),
      "",
      "not json at all {",
      JSON.stringify({ error: { code: 500 } }), // error present but not a string and no nested string message either
      JSON.stringify({ type: "other" }),
    ].join("\n");
    expect(codexErrorFromStdout(multiline)).toBe("earliest usable detail");
    // no line yields a usable detail anywhere → null
    expect(codexErrorFromStdout(JSON.stringify({ type: "other" }))).toBeNull();
    expect(codexErrorFromStdout("")).toBeNull();
  });

  it("codexErrorFromStdout redacts token-shaped stdout details before they reach provider errors", () => {
    const leaky = JSON.stringify({ message: "model echoed private token ghp_ABCDEFGHIJ0123456789KLMNOPQRSTUV" });
    expect(codexErrorFromStdout(leaky)).toBe("model echoed private token [redacted]");
  });

  it("Codex fails closed when a mounted OAuth home would be exposed to the review sandbox", async () => {
    const shouldNotSpawn: StubSpawn = async () => {
      throw new Error("spawned");
    };
    await expect(
      createCodexAi(
        { CODEX_HOME: "/home/node/.codex", GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1" },
        shouldNotSpawn,
      ).run("gpt-5", {
        prompt: "read $CODEX_HOME/auth.json",
      }),
    ).rejects.toThrow(/codex_credential_isolation_required/);
    await expect(createCodexAi({}, shouldNotSpawn).run("gpt-5", { prompt: "x" })).rejects.toThrow(
      /codex_credential_isolation_required/,
    );
    const metrics = await renderMetrics();
    expect(metrics).not.toContain("gittensory_ai_requests_total");
  });

  it("resolveCodexAuthPath: CODEX_HOME wins, else HOME/.codex, else ~/.codex", () => {
    expect(resolveCodexAuthPath({ CODEX_HOME: "/data/codex", HOME: "/home/node" })).toBe(
      "/data/codex/auth.json",
    );
    expect(resolveCodexAuthPath({ HOME: "/home/node" })).toBe("/home/node/.codex/auth.json");
    expect(resolveCodexAuthPath({})).toBe("~/.codex/auth.json");
  });

  it("Codex auth preflight: rejects with codex_auth_not_configured when auth.json is absent, and proceeds when present", async () => {
    // CODEX_HOME itself is fail-closed (see the credential-isolation test above), so drive the
    // preflight via HOME/.codex/auth.json instead — the same path resolveCodexAuthPath falls back to.
    const dir = mkdtempSync(join(tmpdir(), "codex-auth-"));
    const codexDir = join(dir, ".codex");
    const spawnedPrompt: StubSpawn = async () => ({
      stdout: JSON.stringify({ type: "result", result: "ok" }),
      code: 0,
    });
    // No auth.json yet — the preflight must reject before ever spawning codex.
    await expect(
      createCodexAi(
        { HOME: dir, GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1" },
        spawnedPrompt,
      ).run("gpt-5", { prompt: "x" }),
    ).rejects.toThrow(new RegExp(`codex_auth_not_configured: ${codexDir}/auth.json not found`));

    // Once auth.json exists, the preflight passes and the real spawn path runs.
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, "auth.json"), JSON.stringify({ token: "t" }));
    const out = await createCodexAi(
      { HOME: dir, GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1" },
      spawnedPrompt,
    ).run("gpt-5", { prompt: "x" });
    expect(out.response).toBe("ok");
  });

  // Root bypasses POSIX read-permission bits, so an unreadable-file assertion is meaningless under root
  // (common on CI runners) — this only verifies anything as a non-root user, but must not false-fail as root.
  it.skipIf(process.getuid?.() === 0)(
    "Codex auth preflight checks READABILITY (fs.constants.R_OK), not just existence",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "codex-auth-rok-"));
      const codexDir = join(dir, ".codex");
      mkdirSync(codexDir, { recursive: true });
      const authPath = join(codexDir, "auth.json");
      writeFileSync(authPath, JSON.stringify({ token: "t" }));
      chmodSync(authPath, 0o000);
      try {
        const stub: StubSpawn = async () => ({ stdout: JSON.stringify({ type: "result", result: "ok" }), code: 0 });
        await expect(
          createCodexAi({ HOME: dir, GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1" }, stub).run("gpt-5", { prompt: "x" }),
        ).rejects.toThrow(new RegExp(`codex_auth_not_configured: ${authPath} not found or unreadable`));
      } finally {
        chmodSync(authPath, 0o600);
      }
    },
  );

  it("codex: a bare 'Reading prompt from stdin...' stderr on a non-zero exit is surfaced as codex_no_auth (expired/deleted creds)", async () => {
    const bannerOnly: StubSpawn = async () => ({ stdout: "", code: 1, stderr: "Reading prompt from stdin..." });
    await expect(
      createCodexAi({ GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1" }, bannerOnly, noAuthCheck).run("m", { prompt: "x" }),
    ).rejects.toThrow(/codex_no_auth: auth\.json missing or expired/);
  });

  it("surfaces the CLI's stderr in the non-zero-exit error (diagnosable failures, #26)", async () => {
    // Without stderr in the message, a `claude_code_exit_1` / `codex_exit_1` is an opaque dead-end; with it the real
    // cause (auth, rate limit, model-not-supported) reaches the logs + Sentry. (stderr-present branch of `?? ""`.)
    const claudeErr: StubSpawn = async () => ({ stdout: "", code: 1, stderr: "Invalid API key · auth_error" });
    await expect(
      createClaudeCodeAi({ CLAUDE_CODE_OAUTH_TOKEN: "t" }, claudeErr).run("m", { prompt: "x" }),
    ).rejects.toThrow(/claude_code_exit_1: Invalid API key/);
    const codexErr: StubSpawn = async () => ({ stdout: "", code: 1, stderr: "stream error: rate limit reached" });
    await expect(createCodexAi({ GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1" }, codexErr, noAuthCheck).run("m", { prompt: "x" })).rejects.toThrow(
      /codex_exit_1: stream error: rate limit reached/,
    );
    const metrics = await renderMetrics();
    expect(metrics).toContain('gittensory_ai_requests_total{effort="medium",model="m",provider="codex"} 1');
  });

  it("redacts the OAuth token and key-shaped tokens from claude stderr before they reach the error (#1605 sec)", async () => {
    // The CLI can echo the token we hand it via env; it must never land in an error string forwarded to Sentry.
    const token = "oauth-tok-abcdef123456";
    const leaky: StubSpawn = async () => ({ stdout: "", code: 1, stderr: `fatal: rejected token ${token} (key sk-ant-api03-ABCDEFGHIJKLMNOPqrstuvwx)` });
    const err = await createClaudeCodeAi({ CLAUDE_CODE_OAUTH_TOKEN: token }, leaky).run("m", { prompt: "x" }).catch((e: Error) => e.message);
    expect(err).toContain("claude_code_exit_1:");
    expect(err).not.toContain(token);
    expect(err).not.toContain("sk-ant-api03");
    expect(err).toContain("[redacted]");
  });

  it("redacts key-shaped tokens from codex stderr (no env token to key off) (#1605 sec)", async () => {
    const leaky: StubSpawn = async () => ({ stdout: "", code: 1, stderr: "auth failed: ghp_ABCDEFGHIJ0123456789KLMNOPQRSTUV" });
    await expect(createCodexAi({ GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1" }, leaky, noAuthCheck).run("m", { prompt: "x" })).rejects.toThrow(/codex_exit_1: auth failed: \[redacted\]/);
  });

  it("defaultSpawn captures a failing CLI's stderr and surfaces it on the exit error (#26)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fakecli-"));
    const fake = join(dir, "claude");
    // a fake `claude` that reads stdin (so the parent's write never EPIPEs), then writes to STDERR and exits non-zero
    // — the real failure shape we previously couldn't diagnose.
    writeFileSync(fake, "#!/usr/bin/env node\nlet i='';process.stdin.on('data',d=>i+=d);process.stdin.on('end',()=>{process.stderr.write('BOOM: auth failed');process.exit(1);});\n");
    chmodSync(fake, 0o755);
    const origPath = process.env.PATH;
    process.env.PATH = `${dir}:${origPath ?? ""}`;
    try {
      await expect(
        createClaudeCodeAi({ ...process.env, CLAUDE_CODE_OAUTH_TOKEN: "t" }).run("sonnet", { prompt: "x" }),
      ).rejects.toThrow(/claude_code_exit_1: BOOM: auth failed/);
    } finally {
      process.env.PATH = origPath;
    }
  });

  it("defaultSpawn rejects when the CLI binary is missing (error handler)", async () => {
    const origPath = process.env.PATH;
    process.env.PATH = "/nonexistent-gittensory-empty";
    try {
      await expect(createCodexAi({ ...process.env, GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1" }).run("gpt-5", { prompt: "x" })).rejects.toThrow();
    } finally {
      process.env.PATH = origPath;
    }
  });

  it("defaultSpawn's spawn-error handler clears whichever timers were actually armed — firstOutputTimer present (codex) vs absent (claude-code)", async () => {
    // Explicit env (no ambient CODEX_HOME / GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER inherited from the operator's
    // shell) so this reaches the REAL ENOENT spawn error deterministically, rather than short-circuiting on the
    // credential-isolation guard the way an ambient CODEX_HOME would.
    await expect(
      createCodexAi({ PATH: "/nonexistent-gittensory-empty", GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1" }, undefined, noAuthCheck).run(
        "gpt-5",
        { prompt: "x" },
      ),
    ).rejects.toThrow(/ENOENT/);
    // Claude Code never sets firstOutputTimeoutMs (no comparable prod hang), so this exercises the SAME spawn()
    // error path's firstOutputTimer-ABSENT branch — the option is simply never passed for this provider.
    await expect(
      createClaudeCodeAi({ PATH: "/nonexistent-gittensory-empty", CLAUDE_CODE_OAUTH_TOKEN: "t" }).run("sonnet", { prompt: "x" }),
    ).rejects.toThrow(/ENOENT/);
  });

  it("extractCliText falls back to the last JSON line (JSONL) and is empty when none parse", () => {
    expect(extractCliText('not json\n{"result":"x"}')).toBe("x");
    expect(extractCliText("not json\nstill not json")).toBe("");
  });

  it("records Codex CLI usage metrics from successful JSONL output", async () => {
    const stdout = [
      JSON.stringify({ type: "token_count", usage: { input_tokens: 20, output_tokens: 7, total_tokens: 27 }, model: "gpt-5-codex" }),
      JSON.stringify({ type: "result", result: "review" }),
    ].join("\n");
    const ok: StubSpawn = async () => ({ stdout, code: 0 });
    const result = await createCodexAi({ GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1", CODEX_AI_EFFORT: "medium" }, ok, noAuthCheck).run("", { prompt: "x" });
    expect(result.usage).toMatchObject({ provider: "codex", model: "gpt-5-codex", effort: "medium", inputTokens: 20, outputTokens: 7, totalTokens: 27 });
    const metrics = await renderMetrics();
    expect(metrics).toContain('gittensory_ai_requests_total{effort="medium",model="gpt-5-codex",provider="codex"} 1');
    expect(metrics).toContain('gittensory_ai_input_tokens_total{effort="medium",kind="review",model="gpt-5-codex",provider="codex"} 20');
    expect(metrics).toContain('gittensory_ai_output_tokens_total{effort="medium",kind="review",model="gpt-5-codex",provider="codex"} 7');
    expect(metrics).toContain('gittensory_ai_total_tokens_total{effort="medium",model="gpt-5-codex",provider="codex"} 27');
  });
});

describe("redactSecrets — strip credentials from untrusted CLI stderr before it reaches logs/Sentry (#1605 sec)", () => {
  it("redacts caller-known secret values (>= 8 chars) and leaves short ones untouched", () => {
    expect(redactSecrets("token=supersecretvalue used", ["supersecretvalue"])).toBe("token=[redacted] used");
    // a short known value must NOT blank out unrelated text (length-guard false branch)
    expect(redactSecrets("the cat sat", ["cat"])).toBe("the cat sat");
  });

  it("redacts well-known token shapes with no known-value list (default arg)", () => {
    expect(redactSecrets("key sk-ant-api03-ABCDEFGHIJKLMNOPqrstuvwx12")).toBe("key [redacted]");
    expect(redactSecrets("pat ghp_ABCDEFGHIJ0123456789KLMNOPQRSTUV")).toBe("pat [redacted]");
    expect(redactSecrets("fine github_pat_ABCDEFGHIJ0123456789KLMNO")).toBe("fine [redacted]");
    expect(redactSecrets("jwt eyJhbGciOi.eyJzdWIiOi.S1gnaTuRe99")).toBe("jwt [redacted]");
    expect(redactSecrets("aws AKIAIOSFODNN7EXAMPLE here")).toBe("aws [redacted] here");
  });

  it("leaves benign diagnostics intact, including words that merely contain a token prefix", () => {
    expect(redactSecrets("Invalid API key · auth_error")).toBe("Invalid API key · auth_error");
    // "disk-usage-report-2024-summary" must survive — the \b anchor prevents an in-word `sk-` false positive
    expect(redactSecrets("disk-usage-report-2024-summary failed")).toBe("disk-usage-report-2024-summary failed");
  });
});
