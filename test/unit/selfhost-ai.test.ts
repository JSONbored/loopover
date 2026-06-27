import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProvider, claudeErrorStatus, createAnthropicAi, createChainAi, createClaudeCodeAi, createCodexAi, createOpenAiCompatibleAi, createSelfHostAi, extractCliText, resolveAiReviewerPlan, resolveCliTimeoutMs, resolveEffort, resolveModel, resolveProviderNames, resolveRequiredCliProviders, routeProviders, subscriptionCliEnv } from "../../src/selfhost/ai";

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

describe("resolveEffort (#selfhost-effort — Claude Code intelligence dial, default high)", () => {
  it("passes a valid level through, trimmed + lowercased", () => {
    expect(resolveEffort("low")).toBe("low");
    expect(resolveEffort("  Medium ")).toBe("medium");
    expect(resolveEffort("MAX")).toBe("max");
  });
  it("defaults to high when unset or unrecognized so a typo can't downgrade reviews", () => {
    expect(resolveEffort(undefined)).toBe("high"); // ?? right side
    expect(resolveEffort("")).toBe("high"); // present but not in the valid set
    expect(resolveEffort("ultra")).toBe("high"); // unrecognized → safe default
  });
});

describe("resolveCliTimeoutMs (#selfhost — subprocess timeout scales with effort, AI_TIMEOUT_MS overrides)", () => {
  it("scales the default timeout with the AI_EFFORT dial (max needs far more than the old fixed 120s)", () => {
    expect(resolveCliTimeoutMs({ AI_EFFORT: "low" })).toBe(120_000);
    expect(resolveCliTimeoutMs({ AI_EFFORT: "medium" })).toBe(120_000);
    expect(resolveCliTimeoutMs({ AI_EFFORT: "high" })).toBe(240_000);
    expect(resolveCliTimeoutMs({ AI_EFFORT: "xhigh" })).toBe(360_000);
    expect(resolveCliTimeoutMs({ AI_EFFORT: "max" })).toBe(600_000);
    expect(resolveCliTimeoutMs({})).toBe(240_000); // unset effort → resolveEffort defaults to high
  });
  it("honors an explicit AI_TIMEOUT_MS, clamped to a sane 30s–30min range", () => {
    expect(resolveCliTimeoutMs({ AI_TIMEOUT_MS: "300000", AI_EFFORT: "low" })).toBe(300_000); // in-range value wins over the effort scale
    expect(resolveCliTimeoutMs({ AI_TIMEOUT_MS: "9999999" })).toBe(1_800_000); // clamped down to the 30min ceiling
    expect(resolveCliTimeoutMs({ AI_TIMEOUT_MS: "1000" })).toBe(30_000); // clamped up to the 30s floor
  });
  it("falls back to the effort scale on a non-positive or non-numeric AI_TIMEOUT_MS", () => {
    expect(resolveCliTimeoutMs({ AI_TIMEOUT_MS: "0", AI_EFFORT: "max" })).toBe(600_000); // 0 is not > 0 → effort path
    expect(resolveCliTimeoutMs({ AI_TIMEOUT_MS: "abc", AI_EFFORT: "high" })).toBe(240_000); // NaN → effort path
  });
});

afterEach(() => vi.unstubAllGlobals());

type SpawnResult = { stdout: string; code: number | null };
type StubSpawn = (
  cmd: string,
  args: string[],
  opts: { env: Record<string, string | undefined>; input?: string; timeoutMs: number; cwd?: string },
) => Promise<SpawnResult>;

describe("createOpenAiCompatibleAi (#979)", () => {
  it("POSTs to /chat/completions and returns { response }", async () => {
    const calls: Array<{ url: string; body: { model: string } }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ choices: [{ message: { content: "hi there" } }] }), { status: 200 });
    }));
    const ai = createOpenAiCompatibleAi({ baseUrl: "http://ollama:11434/v1/", apiKey: "k" });
    const out = await ai.run("llama3.1", { messages: [{ role: "user", content: "x" }], max_tokens: 100 });
    expect(out.response).toBe("hi there");
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
    expect(typeof createSelfHostAi({ AI_PROVIDER: "ollama", AI_BASE_URL: "http://o/v1" })?.run).toBe("function");
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
    const ai = createSelfHostAi({ AI_PROVIDER: "anthropic,ollama", ANTHROPIC_API_KEY: "sk-ant", AI_BASE_URL: "http://o/v1" });
    expect(typeof ai?.run).toBe("function");
  });
});

describe("resolveProviderNames + resolveAiReviewerPlan (#dual-ai-combiner)", () => {
  it("resolveProviderNames: credentialed providers only, in order, lowercased/trimmed", () => {
    expect(resolveProviderNames({})).toEqual([]);
    expect(resolveProviderNames({ AI_PROVIDER: "  Claude-Code , CODEX " })).toEqual(["claude-code", "codex"]); // CLI providers always credentialed
    expect(resolveProviderNames({ AI_PROVIDER: "anthropic,ollama" })).toEqual(["ollama"]); // anthropic dropped (no key); ollama needs none
    expect(resolveProviderNames({ AI_PROVIDER: "anthropic,ollama", ANTHROPIC_API_KEY: "sk-ant" })).toEqual(["anthropic", "ollama"]);
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

  it("resolveAiReviewerPlan: undefined with no provider; single ⇒ single; two ⇒ default synthesis", () => {
    expect(resolveAiReviewerPlan({})).toBeUndefined(); // cloud / AI off
    expect(resolveAiReviewerPlan({ AI_PROVIDER: "claude-code" })).toEqual({ reviewers: [{ model: "claude-code" }], combine: "single", onMerge: undefined });
    expect(resolveAiReviewerPlan({ AI_PROVIDER: "claude-code,codex" })).toEqual({ reviewers: [{ model: "claude-code" }, { model: "codex" }], combine: "synthesis", onMerge: undefined });
  });

  it("resolveAiReviewerPlan: honors AI_COMBINE / AI_ON_MERGE, defaults invalid values, caps at two reviewers", () => {
    expect(resolveAiReviewerPlan({ AI_PROVIDER: "claude-code,codex", AI_COMBINE: "consensus", AI_ON_MERGE: "both" })).toMatchObject({ combine: "consensus", onMerge: "both" });
    expect(resolveAiReviewerPlan({ AI_PROVIDER: "claude-code,codex", AI_COMBINE: "garbage", AI_ON_MERGE: "nonsense" })).toMatchObject({ combine: "synthesis", onMerge: undefined }); // invalid → defaults
    expect(resolveAiReviewerPlan({ AI_PROVIDER: "claude-code,codex,ollama" })?.reviewers).toEqual([{ model: "claude-code" }, { model: "codex" }]); // first two
  });
});

describe("branch coverage — defaults + edge inputs", () => {
  afterEach(() => vi.unstubAllGlobals());

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
  it("claudeErrorStatus: subtype + unknown fallbacks", () => {
    expect(claudeErrorStatus(JSON.stringify({ is_error: true, subtype: "sub" }))).toBe("sub");
    expect(claudeErrorStatus(JSON.stringify({ is_error: true }))).toBe("unknown");
  });
  it("claude/codex with a null exit code", async () => {
    const nullExit: StubSpawn = async () => ({ stdout: "", code: null });
    await expect(createClaudeCodeAi({ CLAUDE_CODE_OAUTH_TOKEN: "t" }, nullExit).run("m", { prompt: "x" })).rejects.toThrow(/claude_code_exit_null/);
    await expect(createCodexAi({}, nullExit).run("m", { prompt: "x" })).rejects.toThrow(/codex_exit_null/);
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
  it("buildProvider uses provider-specific default base URLs when AI_BASE_URL is unset", () => {
    expect(typeof buildProvider("openai", {})?.run).toBe("function"); // defaults to https://api.openai.com/v1
    expect(typeof buildProvider("ollama", {})?.run).toBe("function"); // defaults to http://localhost:11434/v1
  });
  it("extractCliText reads content + response fields", () => {
    expect(extractCliText(JSON.stringify({ content: "c" }))).toBe("c");
    expect(extractCliText(JSON.stringify({ response: "r" }))).toBe("r");
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
  });
});

describe("subscriptionCliEnv (allowlist + extra-override arms)", () => {
  it("copies only allowlisted parent vars and drops everything else", () => {
    const child = subscriptionCliEnv({ PATH: "/bin", HOME: "/root", ANTHROPIC_API_KEY: "sk-bill", WORKER_ONLY_VALUE: "internal" });
    expect(child).toEqual({ PATH: "/bin", HOME: "/root" });
  });
  it("merges a defined extra value but skips an undefined one", () => {
    const child = subscriptionCliEnv({ PATH: "/bin" }, { CLAUDE_CODE_OAUTH_TOKEN: "t", UNSET: undefined });
    expect(child).toEqual({ PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "t" }); // UNSET (undefined) skips the extra-loop false arm
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

  it("Claude Code pins the default model (claude-sonnet-4-6) + --effort high; AI_MODEL/AI_EFFORT override; timeout scales with effort", async () => {
    let seen: string[] = [];
    let timeout = 0;
    const cap: StubSpawn = async (_c, a, o) => {
      seen = a;
      timeout = o.timeoutMs;
      return { stdout: JSON.stringify({ type: "result", result: "ok" }), code: 0 };
    };
    // empty model id (the dual-router default) + no AI_MODEL → pinned claude-sonnet-4-6; no AI_EFFORT → high
    await createClaudeCodeAi({ CLAUDE_CODE_OAUTH_TOKEN: "t" }, cap).run("", { prompt: "x" });
    expect(seen[seen.indexOf("--model") + 1]).toBe("claude-sonnet-4-6");
    expect(seen[seen.indexOf("--effort") + 1]).toBe("high");
    expect(timeout).toBe(240_000); // high → 240s (not the old fixed 120s)
    // operator overrides flow through to the argv + the timeout scale
    await createClaudeCodeAi({ CLAUDE_CODE_OAUTH_TOKEN: "t", AI_MODEL: "claude-opus-4-8", AI_EFFORT: "max" }, cap).run("", { prompt: "x" });
    expect(seen[seen.indexOf("--model") + 1]).toBe("claude-opus-4-8");
    expect(seen[seen.indexOf("--effort") + 1]).toBe("max");
    expect(timeout).toBe(600_000); // max → 600s, so a large max-effort review isn't SIGKILLed at 120s
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
    const codexChain = createChainAi([{ name: "codex", ai: createCodexAi({}, codexOk) }, embedder]);
    expect((await codexChain.run("bge-m3", { text: ["a"] })).data?.length).toBe(1);
  });

  it("Codex: 0.142+ exec flags (no --ask-for-approval, has --skip-git-repo-check); --model only when configured", async () => {
    let seen: string[] = [];
    let capturedEnv: Record<string, string | undefined> = {};
    let capturedCwd = "";
    let timeout = 0;
    const ok: StubSpawn = async (_cmd, args, opts) => {
      seen = args;
      capturedEnv = opts.env;
      capturedCwd = opts.cwd ?? "";
      timeout = opts.timeoutMs;
      return { stdout: JSON.stringify({ type: "result", result: "codex review" }), code: 0 };
    };
    // no configured model + the dual-router's empty model id → OMIT --model (codex picks the account default;
    // forcing e.g. gpt-5 fails on a ChatGPT-account login). And the removed --ask-for-approval must never appear.
    expect(
      (await createCodexAi({ PATH: "/bin", CODEX_HOME: "/tmp/codex", WORKER_ONLY_VALUE: "internal", OPENAI_API_KEY: "sk-bill", AI_TIMEOUT_MS: "300000" }, ok).run("", {
        prompt: "x",
      })).response,
    ).toBe("codex review");
    expect(seen).toEqual(["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "--", "x"]);
    expect(seen).not.toContain("--ask-for-approval");
    expect(capturedEnv).toEqual({ CODEX_HOME: "/tmp/codex", PATH: "/bin" });
    expect(capturedCwd).toContain("gittensory-ai-");
    expect(timeout).toBe(300_000); // codex honors the same AI_TIMEOUT_MS override as Claude Code
    // an explicit model (AI_MODEL, or a `codex:<model>` reviewer id) IS passed through but not inherited as env.
    await createCodexAi({ AI_MODEL: "o4-mini" }, ok).run("", { prompt: "x" });
    expect(seen.join(" ")).toContain("--model o4-mini");
    expect(capturedEnv.AI_MODEL).toBeUndefined();
    const bad: StubSpawn = async () => ({ stdout: "", code: 1 });
    await expect(createCodexAi({}, bad).run("", { prompt: "x" })).rejects.toThrow(/codex_exit_1/);
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

  it("Claude Code throws on no-token / non-zero exit / empty output", async () => {
    await expect(createClaudeCodeAi({}).run("m", { prompt: "x" })).rejects.toThrow(/claude_code_no_oauth_token/);
    const exit1: StubSpawn = async () => ({ stdout: "", code: 1 });
    await expect(createClaudeCodeAi({ CLAUDE_CODE_OAUTH_TOKEN: "t" }, exit1).run("m", { prompt: "x" })).rejects.toThrow(/claude_code_exit_1/);
    const empty: StubSpawn = async () => ({ stdout: "", code: 0 });
    await expect(createClaudeCodeAi({ CLAUDE_CODE_OAUTH_TOKEN: "t" }, empty).run("m", { prompt: "x" })).rejects.toThrow(/claude_code_empty_output/);
  });

  it("Codex throws on empty output", async () => {
    const empty: StubSpawn = async () => ({ stdout: "", code: 0 });
    await expect(createCodexAi({}, empty).run("gpt-5", { prompt: "x" })).rejects.toThrow(/codex_empty_output/);
  });

  it("defaultSpawn rejects when the CLI binary is missing (error handler)", async () => {
    const origPath = process.env.PATH;
    process.env.PATH = "/nonexistent-gittensory-empty";
    try {
      await expect(createCodexAi({ ...process.env }).run("gpt-5", { prompt: "x" })).rejects.toThrow();
    } finally {
      process.env.PATH = origPath;
    }
  });

  it("extractCliText falls back to the last JSON line (JSONL) and is empty when none parse", () => {
    expect(extractCliText('not json\n{"result":"x"}')).toBe("x");
    expect(extractCliText("not json\nstill not json")).toBe("");
  });
});
