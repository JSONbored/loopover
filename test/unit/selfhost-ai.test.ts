import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeErrorStatus, createAnthropicAi, createChainAi, createClaudeCodeAi, createCodexAi, createOpenAiCompatibleAi, createSelfHostAi, extractCliText, resolveModel } from "../../src/selfhost/ai";

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

afterEach(() => vi.unstubAllGlobals());

type SpawnResult = { stdout: string; code: number | null };
type StubSpawn = (cmd: string, args: string[], opts: { env: Record<string, string | undefined>; input?: string; timeoutMs: number }) => Promise<SpawnResult>;

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
    const out = await createClaudeCodeAi({ CLAUDE_CODE_OAUTH_TOKEN: "t", ANTHROPIC_API_KEY: "sk-bill" }, stub).run("sonnet", { prompt: "x" });
    expect(out.response).toBe("review text");
    expect(capturedEnv.ANTHROPIC_API_KEY).toBeUndefined(); // scrubbed
    expect(capturedEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe("t");
  });

  it("Codex returns text on success and throws on a non-zero exit", async () => {
    const ok: StubSpawn = async () => ({ stdout: JSON.stringify({ type: "result", result: "codex review" }), code: 0 });
    expect((await createCodexAi({}, ok).run("gpt-5", { prompt: "x" })).response).toBe("codex review");
    const bad: StubSpawn = async () => ({ stdout: "", code: 1 });
    await expect(createCodexAi({}, bad).run("gpt-5", { prompt: "x" })).rejects.toThrow(/codex_exit_1/);
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
