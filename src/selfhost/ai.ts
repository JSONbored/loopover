// Self-host AI provider (#979). gittensory calls `env.AI.run(model, { messages, max_tokens, temperature })`
// and reads `{ response }`. On self-host we provide an Ai-shaped adapter selected by AI_PROVIDER:
//   • ollama / openai-compatible / openai  — any OpenAI-compatible /chat/completions endpoint (BYO key)
//   • claude-code / codex                  — a locally-authenticated CLI SUBSCRIPTION, run as a subprocess
// Absent (no AI_PROVIDER) → env.AI is undefined → gittensory's AI summary degrades to "unavailable" and the
// review proceeds deterministically. Every path returns `{ response: string }` (or throws → the caller
// records an error and degrades — never a silent wrong answer).

interface AiRunOptions {
  messages?: Array<{ role: string; content: string }>;
  prompt?: string;
  text?: string[]; // embedding input — the core's embedTexts passes { text: string[] }
  max_tokens?: number;
  temperature?: number;
}
/** A chat completion (`response`) or an embedding result (`data`). Both optional: the core reads whichever it
 *  asked for (extractAiText → `response`, embedTexts → `data`), each defensive about the other being absent. */
export type AiResult = { response?: string; data?: number[][] };
export interface SelfHostAi {
  run(model: string, options: AiRunOptions): Promise<AiResult>;
}

function toMessages(options: AiRunOptions): Array<{ role: string; content: string }> {
  if (Array.isArray(options.messages)) return options.messages;
  return [{ role: "user", content: String(options.prompt ?? "") }];
}

/** The core passes a Workers-AI model id (e.g. "@cf/meta/llama-3.1-8b-instruct-fp8-fast") that is meaningless
 *  off-Workers — handing it to Ollama or `claude --model` fails. Prefer the operator-configured model
 *  (AI_MODEL / WORKERS_AI_SUMMARY_MODEL), then any non-Workers model the core passed, then a provider default. */
export function resolveModel(configured: string | undefined, passed: string, providerDefault: string): string {
  if (configured && configured.trim()) return configured.trim();
  if (passed && !passed.startsWith("@cf/")) return passed;
  return providerDefault;
}

function configuredModel(env: Record<string, string | undefined>): string | undefined {
  return env.AI_MODEL ?? env.WORKERS_AI_SUMMARY_MODEL;
}

/** OpenAI-compatible endpoint (Ollama's /v1, OpenAI, vLLM, LM Studio, …) — chat + embeddings. */
export function createOpenAiCompatibleAi(opts: { baseUrl: string; apiKey?: string | undefined; model?: string | undefined; embedModel?: string | undefined }): SelfHostAi {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const headers = (): Record<string, string> => ({ "content-type": "application/json", ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}) });
  return {
    async run(model, options) {
      // Embedding request — the core's embedTexts passes { text: string[] }; route to /embeddings (for RAG).
      if (Array.isArray(options.text)) {
        if (options.text.length === 0) return { data: [] };
        const res = await fetch(`${base}/embeddings`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ model: opts.embedModel ?? "bge-m3", input: options.text }),
          signal: AbortSignal.timeout(120_000),
        });
        if (!res.ok) throw new Error(`ai_embed_http_${res.status}`);
        const json = (await res.json()) as { data?: Array<{ embedding: number[] }> };
        return { data: (json.data ?? []).map((d) => d.embedding) };
      }
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ model: resolveModel(opts.model, model, "llama3.1"), messages: toMessages(options), max_tokens: options.max_tokens, temperature: options.temperature }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`ai_http_${res.status}`);
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return { response: data.choices?.[0]?.message?.content ?? "" };
    },
  };
}

/** Native Anthropic Messages API (BYOK — bills your Anthropic API key; distinct from the claude-code
 *  subscription path). The system message becomes the top-level `system` param; the rest map to user/assistant. */
export function createAnthropicAi(opts: { apiKey: string; model?: string | undefined; baseUrl?: string | undefined }): SelfHostAi {
  const base = (opts.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  return {
    async run(model, options) {
      const msgs = toMessages(options);
      const system =
        msgs
          .filter((m) => m.role === "system")
          .map((m) => m.content)
          .join("\n\n") || undefined;
      const messages = msgs.filter((m) => m.role !== "system").map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));
      const res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: resolveModel(opts.model, model, "claude-sonnet-4-6"), max_tokens: options.max_tokens ?? 1024, ...(system ? { system } : {}), messages }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`anthropic_http_${res.status}`);
      const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
      return {
        response: (data.content ?? [])
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join(""),
      };
    },
  };
}

// ── Subscription CLI providers (#979) — locally-authenticated `claude` / `codex` as a subprocess ──────────
// SECURITY: the child env DELETES the billable API keys so a misconfigured CLI cannot silently bill the
// metered API instead of using the subscription OAuth token. The CLI runs read-only / no extra tools. Any
// non-zero exit / empty output / error-envelope THROWS so the caller degrades — never a silent answer.
const BILLABLE_KEY_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CODEX_API_KEY", "OPENAI_API_KEY"] as const;

function scrubBillableKeys(parent: Record<string, string | undefined>): Record<string, string | undefined> {
  const child = { ...parent };
  for (const k of BILLABLE_KEY_VARS) delete child[k];
  return child;
}

/** Pull the assistant's final text out of a CLI's JSON output (Claude Code `{result}` or Codex JSONL). */
export function extractCliText(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "";
  const tryParse = (s: string): string => {
    try {
      const o = JSON.parse(s) as Record<string, unknown>;
      const text = o.result ?? o.text ?? o.content ?? o.response;
      return typeof text === "string" ? text : "";
    } catch {
      return "";
    }
  };
  const whole = tryParse(trimmed);
  if (whole) return whole;
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    /* v8 ignore next */ // the filter above guarantees a non-empty line; this is a TS undefined-guard only
    if (!line) continue;
    const t = tryParse(line);
    if (t) return t;
  }
  return "";
}

/** Claude Code's `--output-format json` exits 0 even on an API/auth error, returning {is_error:true,result:"<msg>"}.
 *  Detect it so the error string is never surfaced as the model's answer. */
export function claudeErrorStatus(stdout: string): string | null {
  try {
    const o = JSON.parse(stdout.trim()) as Record<string, unknown>;
    if (o.is_error === true) return String(o.api_error_status ?? o.subtype ?? "unknown");
  } catch {
    /* not a single JSON object — handled by the empty-output guard */
  }
  return null;
}

type SpawnFn = (cmd: string, args: string[], opts: { env: Record<string, string | undefined>; input?: string; timeoutMs: number }) => Promise<{ stdout: string; code: number | null }>;

async function defaultSpawn(): Promise<SpawnFn> {
  const cp = await import("node:child_process");
  return (cmd, args, o) =>
    new Promise((resolve, reject) => {
      const stdio: ["pipe", "pipe", "pipe"] = ["pipe", "pipe", "pipe"];
      const child = cp.spawn(cmd, args, { env: o.env as NodeJS.ProcessEnv, stdio });
      let stdout = "";
      /* v8 ignore start */ // a 120s subprocess timeout is not unit-testable without a 2-minute wait
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("subscription_cli_timeout"));
      }, o.timeoutMs);
      /* v8 ignore stop */
      child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ stdout, code });
      });
      if (o.input != null) {
        child.stdin?.write(o.input);
        child.stdin?.end();
      }
    });
}

/** Claude Code subscription (CLAUDE_CODE_OAUTH_TOKEN via `claude setup-token`). Headless, read-only, JSON. */
export function createClaudeCodeAi(parentEnv: Record<string, string | undefined>, spawnImpl?: SpawnFn): SelfHostAi {
  return {
    async run(model, options) {
      const token = parentEnv.CLAUDE_CODE_OAUTH_TOKEN;
      if (!token) throw new Error("claude_code_no_oauth_token");
      const env = scrubBillableKeys(parentEnv);
      env.CLAUDE_CODE_OAUTH_TOKEN = token;
      const prompt = toMessages(options).map((m) => m.content).join("\n\n");
      const spawn = spawnImpl ?? (await defaultSpawn());
      const claudeModel = resolveModel(configuredModel(parentEnv), model, "sonnet");
      const { stdout, code } = await spawn("claude", ["--print", "--output-format", "json", "--model", claudeModel, "--permission-mode", "plan", "--disallowedTools", "Bash,Edit,Write,WebFetch,WebSearch"], { env, input: prompt, timeoutMs: 120_000 });
      if (code !== 0) throw new Error(`claude_code_exit_${code ?? "null"}`);
      const errStatus = claudeErrorStatus(stdout);
      if (errStatus) throw new Error(`claude_code_error_${errStatus}`);
      const text = extractCliText(stdout);
      if (!text) throw new Error("claude_code_empty_output");
      return { response: text };
    },
  };
}

/** Codex subscription (`codex exec`, auth from ~/.codex/auth.json). Gated/unverified — fail-safe. */
export function createCodexAi(parentEnv: Record<string, string | undefined>, spawnImpl?: SpawnFn): SelfHostAi {
  return {
    async run(model, options) {
      const env = scrubBillableKeys(parentEnv);
      const prompt = toMessages(options).map((m) => m.content).join("\n\n");
      const spawn = spawnImpl ?? (await defaultSpawn());
      const codexModel = resolveModel(configuredModel(parentEnv), model, "gpt-5");
      const { stdout, code } = await spawn("codex", ["exec", "--json", "--sandbox", "read-only", "--ask-for-approval", "never", "--model", codexModel, "--", prompt], { env, timeoutMs: 120_000 });
      if (code !== 0) throw new Error(`codex_exit_${code ?? "null"}`);
      const text = extractCliText(stdout);
      if (!text) throw new Error("codex_empty_output");
      return { response: text };
    },
  };
}

/** Try each provider in order until one returns; if all throw, rethrow the last error so the caller degrades
 *  (AI summary → "unavailable"; the review still runs deterministically). The fallback chain is what makes a
 *  BYOK setup robust — e.g. AI_PROVIDER="anthropic,ollama" uses the API first and a local model if it's down. */
export function createChainAi(providers: Array<{ name: string; ai: SelfHostAi }>): SelfHostAi {
  return {
    async run(model, options) {
      let lastError: unknown = new Error("no_ai_providers");
      for (const p of providers) {
        try {
          return await p.ai.run(model, options);
        } catch (error) {
          lastError = error;
          console.error(JSON.stringify({ level: "warn", event: "selfhost_ai_provider_failed", provider: p.name, error: error instanceof Error ? error.message : "unknown" }));
        }
      }
      throw lastError instanceof Error ? lastError : new Error("all_ai_providers_failed");
    },
  };
}

/** Build one provider adapter by name (BYO credentials read from provider-specific env, then the generic
 *  AI_API_KEY). Returns undefined when its required credential is missing. */
export function buildProvider(name: string, env: Record<string, string | undefined>): SelfHostAi | undefined {
  switch (name) {
    case "ollama":
    case "openai-compatible":
    case "openai":
      return createOpenAiCompatibleAi({
        baseUrl: env.AI_BASE_URL ?? (name === "openai" ? "https://api.openai.com/v1" : "http://localhost:11434/v1"),
        apiKey: env.AI_API_KEY ?? env.OPENAI_API_KEY,
        model: configuredModel(env),
        embedModel: env.AI_EMBED_MODEL,
      });
    case "anthropic": {
      const apiKey = env.ANTHROPIC_API_KEY ?? env.AI_API_KEY;
      return apiKey ? createAnthropicAi({ apiKey, model: configuredModel(env), baseUrl: env.AI_BASE_URL }) : undefined;
    }
    case "claude-code":
      return createClaudeCodeAi(env);
    case "codex":
      return createCodexAi(env);
    default:
      return undefined;
  }
}

/** Wrap ≥2 providers so a caller can address ONE by name — `.run("codex", …)` runs codex specifically — which is
 *  what lets the dual-reviewer path (#dual-ai-combiner) run Claude Code AND Codex as DISTINCT reviewers instead of
 *  one fallback chain. Any other model id (a real model name, or an embed model for RAG) routes to the fallback
 *  chain exactly as before — so single-AI / BYOK setups are unchanged. */
export function routeProviders(providers: Array<{ name: string; ai: SelfHostAi }>): SelfHostAi {
  const byName = new Map(providers.map((p) => [p.name, p.ai]));
  const chain = createChainAi(providers);
  return {
    async run(model, options) {
      const direct = byName.get(model.trim().toLowerCase());
      return (direct ?? chain).run(model, options);
    },
  };
}

/** Select the self-host AI provider(s) from AI_PROVIDER. A comma-separated list of TWO+ providers is addressable
 *  by name for dual review (see `routeProviders`) and otherwise falls back through them in order; a single
 *  provider is used directly. Returns undefined when unconfigured or no provider has its credential. */
export function createSelfHostAi(env: Record<string, string | undefined>): SelfHostAi | undefined {
  const raw = (env.AI_PROVIDER ?? "").trim().toLowerCase();
  if (!raw) return undefined;
  const providers = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((name) => ({ name, ai: buildProvider(name, env) }))
    .filter((p): p is { name: string; ai: SelfHostAi } => Boolean(p.ai));
  if (providers.length === 0) return undefined;
  if (providers.length === 1) return providers[0]?.ai;
  return routeProviders(providers);
}
