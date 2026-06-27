// Self-host AI provider (#979). gittensory calls `env.AI.run(model, { messages, max_tokens, temperature })`
// and reads `{ response }`. On self-host we provide an Ai-shaped adapter selected by AI_PROVIDER:
//   • ollama / openai-compatible / openai  — any OpenAI-compatible /chat/completions endpoint (BYO key)
//   • claude-code / codex                  — a locally-authenticated CLI SUBSCRIPTION, run as a subprocess
// Absent (no AI_PROVIDER) → env.AI is undefined → gittensory's AI summary degrades to "unavailable" and the
// review proceeds deterministically. Every path returns `{ response: string }` (or throws → the caller
// records an error and degrades — never a silent wrong answer).

import type { CombineStrategy, OnMerge } from "../services/ai-review";

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

const VALID_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
/** Map `AI_EFFORT` (the operator's intelligence dial) to a `claude --effort` level. Defaults to "high" — the
 *  engine wants a substantive review, not a fast shallow one — and falls back to "high" for any unset or
 *  unrecognized value so a typo can't silently downgrade reviews. The CLI clamps a level above the model's
 *  own ceiling (e.g. xhigh on Sonnet) down on its own. */
export function resolveEffort(configured: string | undefined): string {
  const level = (configured ?? "").trim().toLowerCase();
  return VALID_EFFORTS.has(level) ? level : "high";
}

// Per-effort subprocess timeout (ms) for the subscription CLIs. A higher effort legitimately runs longer, so the
// old fixed 120s cap silently SIGKILLed a large max-effort review mid-generation (the review then degrades to
// nothing). These scale the ceiling with the effort dial; AI_TIMEOUT_MS overrides them outright.
const EFFORT_TIMEOUT_MS: Record<string, number> = { low: 120_000, medium: 120_000, high: 240_000, xhigh: 360_000, max: 600_000 };

/** Resolve the subscription-CLI subprocess timeout (ms). An explicit `AI_TIMEOUT_MS` wins, clamped to a sane
 *  30s–30min range so a typo can neither hang a worker nor cut a review off after a few seconds. Absent/invalid ⇒
 *  it scales with the `AI_EFFORT` dial (resolveEffort always yields a known level, so the map lookup is total). */
export function resolveCliTimeoutMs(env: Record<string, string | undefined>): number {
  const raw = Number(env.AI_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw > 0) return Math.min(1_800_000, Math.max(30_000, raw));
  return EFFORT_TIMEOUT_MS[resolveEffort(env.AI_EFFORT)]!;
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
// SECURITY: subscription CLIs get a strict allowlisted env, not the worker env. This keeps runtime
// credentials out of prompt-injectable subprocesses while preserving CLI auth/home/proxy/cert settings. The CLI
// runs read-only / no extra tools, and non-zero exit / empty output / error-envelope THROWS so the caller degrades.
const SUBSCRIPTION_CLI_ENV_ALLOWLIST = [
  "CODEX_HOME",
  "HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LANG",
  "LC_ALL",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "PATH",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TERM",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "https_proxy",
  "http_proxy",
  "no_proxy",
] as const;

export function subscriptionCliEnv(
  parent: Record<string, string | undefined>,
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const child: Record<string, string | undefined> = {};
  for (const key of SUBSCRIPTION_CLI_ENV_ALLOWLIST) {
    const value = parent[key];
    if (value !== undefined) child[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) child[key] = value;
  }
  return child;
}

async function isolatedCliCwd(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return mkdtemp(join(tmpdir(), "gittensory-ai-"));
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

type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { env: Record<string, string | undefined>; input?: string; timeoutMs: number; cwd?: string },
) => Promise<{ stdout: string; code: number | null; stderr?: string }>;

async function defaultSpawn(): Promise<SpawnFn> {
  const cp = await import("node:child_process");
  return (cmd, args, o) =>
    new Promise((resolve, reject) => {
      const stdio: ["pipe", "pipe", "pipe"] = ["pipe", "pipe", "pipe"];
      const child = cp.spawn(cmd, args, { cwd: o.cwd, env: o.env as NodeJS.ProcessEnv, stdio });
      let stdout = "";
      // Capture stderr too — the CLI's actual error (auth, rate limit, model-not-supported, OOM) lands here, and
      // it's what makes a `claude_code_exit_1` / `codex_exit_1` diagnosable instead of an opaque exit code (#26).
      let stderr = "";
      /* v8 ignore start */ // a 120s subprocess timeout is not unit-testable without a 2-minute wait
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("subscription_cli_timeout"));
      }, o.timeoutMs);
      /* v8 ignore stop */
      child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ stdout, code, stderr });
      });
      if (o.input != null) {
        child.stdin?.write(o.input);
        child.stdin?.end();
      }
    });
}

/** Credential/token shapes that must never reach logs or Sentry. High-precision (prefixed key formats + JWT, each
 *  anchored on a word boundary) so genuine diagnostics — auth/rate-limit/model errors — survive redaction. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic keys (sk-..., sk-ant-..., sk-proj-...)
  /\bgh[oprsu]_[A-Za-z0-9]{20,}/g, // GitHub PAT / OAuth / server / refresh tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, // JWT (header.payload.signature)
  /\bAKIA[0-9A-Z]{16}/g, // AWS access key id
];

/** Redact secrets from untrusted CLI stderr before it enters an error message that flows to logs/Sentry. The
 *  claude/codex subprocesses can echo back the OAuth token we hand them via env (or a key from a config they read),
 *  and the central Sentry forwarder only scrubs secret-KEYED fields, never free-text — so a token inside an error
 *  string would otherwise leak. Strips the caller's known secret values exactly, then well-known token shapes. */
export function redactSecrets(text: string, knownSecrets: readonly string[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    // Length-guard so a short/empty token (e.g. a stubbed "t") can't blank out unrelated diagnostic text.
    if (secret.length >= 8) out = out.split(secret).join("[redacted]");
  }
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}

/** Claude Code subscription (CLAUDE_CODE_OAUTH_TOKEN via `claude setup-token`). Headless, read-only, JSON. */
export function createClaudeCodeAi(parentEnv: Record<string, string | undefined>, spawnImpl?: SpawnFn): SelfHostAi {
  return {
    async run(model, options) {
      // Claude has no embeddings model (CLI or API), so REJECT an embed request and let the provider chain fall
      // through to an embed-capable provider (ollama/openai-compatible). Without this throw the chain would treat
      // claude's empty-prompt text answer as "success" and never reach the embed provider → RAG silently breaks.
      if (options.text) throw new Error("claude_code_no_embed");
      const token = parentEnv.CLAUDE_CODE_OAUTH_TOKEN;
      if (!token) throw new Error("claude_code_no_oauth_token");
      const env = subscriptionCliEnv(parentEnv, { CLAUDE_CODE_OAUTH_TOKEN: token });
      const prompt = toMessages(options).map((m) => m.content).join("\n\n");
      const spawn = spawnImpl ?? (await defaultSpawn());
      const claudeModel = resolveModel(configuredModel(parentEnv), model, "claude-sonnet-4-6");
      const effort = resolveEffort(parentEnv.AI_EFFORT);
      const { stdout, code, stderr } = await spawn(
        "claude",
        ["--print", "--output-format", "json", "--model", claudeModel, "--permission-mode", "plan", "--effort", effort, "--disallowedTools", "Bash,Edit,Write,WebFetch,WebSearch"],
        { env, input: prompt, timeoutMs: resolveCliTimeoutMs(parentEnv), cwd: await isolatedCliCwd() },
      );
      if (code !== 0) throw new Error(`claude_code_exit_${code ?? "null"}: ${redactSecrets(stderr ?? "", [token]).slice(0, 500)}`);
      const errStatus = claudeErrorStatus(stdout);
      if (errStatus) throw new Error(`claude_code_error_${errStatus}`);
      const text = extractCliText(stdout);
      if (!text) throw new Error("claude_code_empty_output");
      return { response: text };
    },
  };
}

/** Codex subscription (`codex exec`, auth from $CODEX_HOME/auth.json, default ~/.codex). codex needs a WRITABLE
 *  home for its app-server state, so a brokered self-host points CODEX_HOME at a writable dir. Gated/unverified —
 *  fail-safe. */
export function createCodexAi(parentEnv: Record<string, string | undefined>, spawnImpl?: SpawnFn): SelfHostAi {
  return {
    async run(model, options) {
      // Codex is chat-only here — reject embed requests so the chain routes them to an embed-capable provider.
      if (options.text) throw new Error("codex_no_embed");
      const env = subscriptionCliEnv(parentEnv);
      const prompt = toMessages(options).map((m) => m.content).join("\n\n");
      const spawn = spawnImpl ?? (await defaultSpawn());
      // codex 0.142+: `exec` is non-interactive — the old `--ask-for-approval` flag was REMOVED (passing it errors).
      // `--skip-git-repo-check` lets it run outside a git repo. Pass `--model` ONLY when one is explicitly
      // configured: forcing a model (e.g. the old `gpt-5` default) fails on a ChatGPT-account login with "not
      // supported", whose default model codex selects on its own.
      const codexModel = resolveModel(configuredModel(parentEnv), model, "");
      const args = ["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only"];
      if (codexModel) args.push("--model", codexModel);
      args.push("--", prompt);
      const { stdout, code, stderr } = await spawn("codex", args, {
        env,
        timeoutMs: resolveCliTimeoutMs(parentEnv),
        cwd: await isolatedCliCwd(),
      });
      if (code !== 0) throw new Error(`codex_exit_${code ?? "null"}: ${redactSecrets(stderr ?? "").slice(0, 500)}`);
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
      // A reviewer id of `<provider>` or `<provider>:<model>` addresses ONE provider directly (the dual-review
      // path). When it matches, hand the provider the model PART (after the colon) — or "" so it falls to its own
      // default — NOT the provider name, which is not a real model id (`claude --model claude-code` would fail).
      // Any other id (a real model name, or an embed model for RAG) routes to the fallback chain unchanged.
      const trimmed = model.trim();
      const colon = trimmed.indexOf(":");
      const name = (colon < 0 ? trimmed : trimmed.slice(0, colon)).toLowerCase();
      const direct = byName.get(name);
      return direct ? direct.run(colon < 0 ? "" : trimmed.slice(colon + 1), options) : chain.run(model, options);
    },
  };
}

/** Build the credentialed providers named in AI_PROVIDER (any without a credential are silently dropped), in
 *  order, lowercased. Shared by the adapter and the dual-review plan so they never disagree about which providers
 *  exist (e.g. an uncredentialed entry can't become a "reviewer" the router would then miss). */
function buildProviders(env: Record<string, string | undefined>): Array<{ name: string; ai: SelfHostAi }> {
  return (env.AI_PROVIDER ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((name) => ({ name, ai: buildProvider(name, env) }))
    .filter((p): p is { name: string; ai: SelfHostAi } => Boolean(p.ai));
}

/** The credentialed self-host provider names from AI_PROVIDER, in order. Empty when unconfigured. */
export function resolveProviderNames(env: Record<string, string | undefined>): string[] {
  return buildProviders(env).map((p) => p.name);
}

/** CLI-subscription providers need their binary present on PATH; keep boot preflight parsing identical to AI_PROVIDER. */
export function resolveRequiredCliProviders(env: Record<string, string | undefined>): Array<{ provider: string; cli: string }> {
  const seen = new Set<string>();
  return resolveProviderNames(env)
    .map((provider) =>
      provider === "claude-code" ? { provider, cli: "claude" } : provider === "codex" ? { provider, cli: "codex" } : undefined,
    )
    .filter((required): required is { provider: string; cli: string } => {
      if (!required || seen.has(required.provider)) return false;
      seen.add(required.provider);
      return true;
    });
}

/** Select the self-host AI provider(s) from AI_PROVIDER. A comma-separated list of TWO+ providers is addressable
 *  by name for dual review (see `routeProviders`) and otherwise falls back through them in order; a single
 *  provider is used directly. Returns undefined when unconfigured or no provider has its credential. */
export function createSelfHostAi(env: Record<string, string | undefined>): SelfHostAi | undefined {
  const providers = buildProviders(env);
  if (providers.length === 0) return undefined;
  if (providers.length === 1) return providers[0]?.ai;
  return routeProviders(providers);
}

const COMBINE_STRATEGIES = new Set<CombineStrategy>(["single", "consensus", "synthesis"]);
const ON_MERGE_RULES = new Set<OnMerge>(["either", "both"]);

/** Resolve the self-host dual-review plan from env: the credentialed providers become the reviewer(s), `AI_COMBINE`
 *  the strategy (default `synthesis` for two — "both review, one synthesized decision"), `AI_ON_MERGE` the
 *  synthesis rule. Returns undefined when no provider is configured (cloud, or AI off) so ai-review keeps its
 *  byte-identical Workers-AI consensus default; one provider ⇒ `single`; two+ ⇒ the configured strategy over the
 *  first two. The result is attached to the self-host env at boot and passed to runGittensoryAiReview. */
export function resolveAiReviewerPlan(
  env: Record<string, string | undefined>,
): { reviewers: Array<{ model: string }>; combine: CombineStrategy; onMerge: OnMerge | undefined } | undefined {
  const names = resolveProviderNames(env);
  if (names.length === 0) return undefined;
  if (names.length === 1) return { reviewers: [{ model: names[0] as string }], combine: "single", onMerge: undefined };
  const rawCombine = (env.AI_COMBINE ?? "").trim().toLowerCase() as CombineStrategy;
  const combine: CombineStrategy = COMBINE_STRATEGIES.has(rawCombine) ? rawCombine : "synthesis";
  const rawOnMerge = (env.AI_ON_MERGE ?? "").trim().toLowerCase() as OnMerge;
  const onMerge = ON_MERGE_RULES.has(rawOnMerge) ? rawOnMerge : undefined;
  return { reviewers: names.slice(0, 2).map((model) => ({ model })), combine, onMerge };
}
