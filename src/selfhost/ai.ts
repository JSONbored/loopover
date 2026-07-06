// Self-host AI provider (#979). gittensory calls `env.AI.run(model, { messages, max_tokens, temperature })`
// and reads `{ response }`. On self-host we provide an Ai-shaped adapter selected by AI_PROVIDER:
//   • ollama / openai-compatible / openai  — any OpenAI-compatible /chat/completions endpoint (BYO key)
//   • claude-code / codex                  — a locally-authenticated CLI SUBSCRIPTION, run as a subprocess
// Absent (no AI_PROVIDER) → env.AI is undefined → gittensory's AI summary degrades to "unavailable" and the
// review proceeds deterministically. Every path returns `{ response: string }` (or throws → the caller
// records an error and degrades — never a silent wrong answer).

import type { CombineStrategy, OnMerge } from "../services/ai-review";
import { isConfiguredSelfHostProvider, resolveConfiguredProviderNames } from "./ai-config";
export { assertNoLegacySharedAiEnv } from "./ai-config";
import { incr } from "./metrics";
import { withReviewSpan } from "./tracing";
import { delimiter } from "node:path";

interface AiRunOptions {
  messages?: Array<{ role: string; content: string }>;
  prompt?: string;
  systemAppend?: string;
  text?: string[]; // embedding input — the core's embedTexts passes { text: string[] }
  max_tokens?: number;
  temperature?: number;
  // Correlation context for a provider-failure log (#codex-timeout-fields): purely observational, never read by a
  // provider's own request logic. The caller (runWorkersOpinion) passes whatever of these it already has in scope
  // for THIS review — job id and attempt are per-attempt, repoFullName/pullNumber identify the PR being reviewed —
  // so an operator can correlate a `selfhost_ai_provider_failed` line back to the job/PR without cross-referencing
  // timestamps. All optional: absent ⇒ the log line is byte-identical to before.
  jobId?: string;
  repoFullName?: string;
  pullNumber?: number;
  attempt?: number;
  // `.gittensory.yml` `review.ai_model` (#selfhost-ai-model-override): per-repo override for the subscription
  // CLI providers, resolved by the caller from the repo's manifest and forwarded here so this file makes no
  // manifest fetch of its own. Each field is read ONLY by its matching provider's `.run()` (claude-code reads
  // the claude* pair, codex reads the codex* pair) and takes priority over that provider's global env var, which
  // in turn still wins over this file's own hardcoded default. Absent ⇒ byte-identical to today (global env var,
  // then default, exactly as before this override existed).
  claudeModel?: string;
  claudeEffort?: string;
  codexModel?: string;
  codexEffort?: string;
}
/** A chat completion (`response`) or an embedding result (`data`). Both optional: the core reads whichever it
 *  asked for (extractAiText → `response`, embedTexts → `data`), each defensive about the other being absent.
 *  `usage` is best-effort local accounting for self-host operators; callers must never make review decisions
 *  from it because provider envelopes are not uniform. */
export type AiResult = { response?: string; data?: number[][]; usage?: AiUsage };
export interface SelfHostAi {
  run(model: string, options: AiRunOptions): Promise<AiResult>;
}

function toMessages(options: AiRunOptions): Array<{ role: string; content: string }> {
  if (Array.isArray(options.messages)) return options.messages;
  return [{ role: "user", content: String(options.prompt ?? "") }];
}

function normalizedSystemAppend(options: AiRunOptions): string | undefined {
  const trimmed = options.systemAppend?.trim();
  return trimmed ? trimmed : undefined;
}

function stripSystemAppend(content: string, systemAppend: string): string {
  const index = content.indexOf(systemAppend);
  if (index < 0) return content;
  return `${content.slice(0, index)}${content.slice(index + systemAppend.length)}`.trimEnd();
}

function toCliPrompt(options: AiRunOptions, systemAppend: string | undefined): string {
  return toMessages(options)
    .map((message) =>
      systemAppend && message.role === "system"
        ? stripSystemAppend(message.content, systemAppend)
        : message.content,
    )
    .join("\n\n");
}

function prependCodexSystemAppend(prompt: string, systemAppend: string | undefined): string {
  return systemAppend
    ? `ADDITIONAL SYSTEM INSTRUCTIONS:\n${systemAppend}\n\n${prompt}`
    : prompt;
}

/** The core passes a Workers-AI model id (e.g. "@cf/meta/llama-3.1-8b-instruct-fp8-fast") that is meaningless
 *  off-Workers — handing it to Ollama or `claude --model` fails. Prefer the provider-specific self-host model,
 *  then any non-Workers model the core passed, then a provider default. */
export function resolveModel(configured: string | undefined, passed: string, providerDefault: string): string {
  if (configured && configured.trim()) return configured.trim();
  if (passed && !passed.startsWith("@cf/")) return passed;
  return providerDefault;
}

function firstConfigured(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.trim() !== "");
}

// `repoOverride` (from `review.ai_model`, #selfhost-ai-model-override) takes priority over the global env var —
// a per-repo config narrows/redirects the operator's own already-permitted choice, so it must outrank the
// operator-wide default without ever being ABLE to escape it (there is no third, wider tier to escalate to).
function configuredClaudeModel(env: Record<string, string | undefined>, repoOverride?: string | undefined): string | undefined {
  return firstConfigured(repoOverride, env.CLAUDE_AI_MODEL);
}

function configuredCodexModel(env: Record<string, string | undefined>, repoOverride?: string | undefined): string | undefined {
  return firstConfigured(repoOverride, env.CODEX_AI_MODEL);
}

function configuredAnthropicModel(env: Record<string, string | undefined>): string | undefined {
  return firstConfigured(env.ANTHROPIC_AI_MODEL);
}

function configuredOpenAiCompatibleModel(name: string, env: Record<string, string | undefined>): string | undefined {
  if (name === "ollama") return firstConfigured(env.OLLAMA_AI_MODEL);
  if (name === "openai") return firstConfigured(env.OPENAI_AI_MODEL);
  return firstConfigured(env.OPENAI_COMPATIBLE_AI_MODEL);
}

const DEFAULT_OLLAMA_CHAT_MODEL = "llama3.1";
const DEFAULT_OPENAI_COMPATIBLE_CHAT_MODEL = "llama3.1";
const DEFAULT_OPENAI_CHAT_MODEL = "gpt-5.5";

function defaultOpenAiCompatibleModel(name: string): string {
  if (name === "openai") return DEFAULT_OPENAI_CHAT_MODEL;
  if (name === "ollama") return DEFAULT_OLLAMA_CHAT_MODEL;
  return DEFAULT_OPENAI_COMPATIBLE_CHAT_MODEL;
}

const VALID_CLAUDE_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const VALID_CODEX_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
/** Map `CLAUDE_AI_EFFORT` to a `claude --effort` level. Defaults to "medium" so subscription fallback preserves
 *  enough reasoning depth for reviews without burning high-effort tokens on every PR. A typo falls back to medium
 *  instead of silently disabling the reviewer; operators can still raise important repos to high/xhigh/max. */
export function resolveEffort(configured: string | undefined): string {
  const level = (configured ?? "").trim().toLowerCase();
  return VALID_CLAUDE_EFFORTS.has(level) ? level : "medium";
}

/** Map `CODEX_AI_EFFORT` to Codex reasoning effort. Codex currently supports xhigh as its top level, so a
 *  mistaken `max` preserves intent by resolving to xhigh instead of being dropped. */
export function resolveCodexEffort(configured: string | undefined): string {
  const level = (configured ?? "").trim().toLowerCase();
  if (VALID_CODEX_EFFORTS.has(level)) return level;
  if (level === "max") return "xhigh";
  return "medium";
}

// Per-effort subprocess timeout (ms) for the subscription CLIs. A higher effort legitimately runs longer, so the
// old fixed 120s cap silently SIGKILLed a large max-effort review mid-generation (the review then degrades to
// nothing). These scale the ceiling with the provider-specific effort dial; provider-specific timeout vars override
// them outright.
//
// `medium` was left pinned to `low`'s 120s when this ladder was introduced (#3612-era), on the assumption that
// capping it tightly would conserve subscription tokens. In production it did the opposite: `medium` is the
// DEFAULT effort (see resolveEffort/resolveCodexEffort above), so a real medium-effort review that runs past 120s
// gets SIGKILLed mid-generation — the tokens already spent are wasted, and because that PR's head SHA never gets
// a completed gate check, the regate-repair sweep (queue/processors.ts's surfaceRepairPriorityPullNumbers) treats
// it as an outage and bypasses its own staleness throttle to retry it every ~2 minutes, indefinitely. Giving
// `medium` its own tier (rather than reusing `low`'s) lets a normal medium-effort review actually finish instead
// of feeding that loop (#3747). Split per-provider (rather than one shared map) so a future provider-specific
// tuning change doesn't have to touch the other provider's ladder to make it.
const CLAUDE_EFFORT_TIMEOUT_MS: Record<string, number> = { low: 120_000, medium: 180_000, high: 240_000, xhigh: 360_000, max: 600_000 };
const CODEX_EFFORT_TIMEOUT_MS: Record<string, number> = { low: 120_000, medium: 180_000, high: 240_000, xhigh: 360_000, max: 600_000 };

function resolveCliTimeoutFrom(configured: string | undefined, effort: string, effortTimeoutMs: Record<string, number>): number {
  const raw = Number(configured);
  if (Number.isFinite(raw) && raw > 0) return Math.min(1_800_000, Math.max(30_000, raw));
  return effortTimeoutMs[effort]!;
}

export function resolveClaudeCliTimeoutMs(env: Record<string, string | undefined>): number {
  return resolveCliTimeoutFrom(firstConfigured(env.CLAUDE_AI_TIMEOUT_MS), resolveEffort(firstConfigured(env.CLAUDE_AI_EFFORT)), CLAUDE_EFFORT_TIMEOUT_MS);
}

export function resolveCodexCliTimeoutMs(env: Record<string, string | undefined>): number {
  return resolveCliTimeoutFrom(firstConfigured(env.CODEX_AI_TIMEOUT_MS), resolveCodexEffort(firstConfigured(env.CODEX_AI_EFFORT)), CODEX_EFFORT_TIMEOUT_MS);
}

// Fast-fail deadline for Codex's "Reading prompt from stdin..." hang (GITTENSORY-K/GITTENSORY-M): observed in prod
// as `codex exec` printing ONLY its own startup banner to stderr and then never producing a single byte of JSONL
// on stdout before the FULL timeoutMs (up to 600_000ms at max effort) elapses and the process is SIGKILLed. That
// full timeout is sized for a legitimately long-running review, so waiting it out to detect a completely dead
// subprocess stalls the codex → claude-code fallback chain for up to 10 minutes per attempt. This is a SEPARATE,
// much shorter deadline: if not one single byte has arrived on STDOUT by this point, the process is almost
// certainly hung at the stdin-read step, not merely thinking. Deliberately STDOUT-ONLY, not "either stream" —
// the startup banner itself is unconditional stderr output on every invocation, so treating it as "alive" would
// let it satisfy this deadline forever and never catch the exact hang it exists to detect; real JSONL progress
// from `codex --json` always lands on stdout, so stdout is the only reliable liveness signal. 30s default: long
// enough that a busy host (cold container start, contended CPU) doesn't false-positive on a merely-slow-to-start
// real call, short enough that the codex→claude-code fallback (or a caller retry) kicks in almost immediately
// instead of after a 10-minute stall. Independent of CODEX_AI_EFFORT/CODEX_AI_TIMEOUT_MS on purpose: a higher
// effort makes a COMPLETION take longer, it does not make the CLI slower to print its FIRST stdout byte, so this
// must not scale with effort the way the full timeout does. Bounds mirror resolveCliTimeoutFrom's floor but cap
// well under the shortest full timeout (120_000ms) so this can never itself become the effective timeout.
export function resolveCodexFirstOutputTimeoutMs(env: Record<string, string | undefined>): number {
  const raw = Number(firstConfigured(env.CODEX_AI_FIRST_OUTPUT_TIMEOUT_MS));
  if (Number.isFinite(raw) && raw > 0) return Math.min(120_000, Math.max(1_000, raw));
  return 30_000;
}

/** OpenAI-compatible endpoint (Ollama's /v1, OpenAI, vLLM, LM Studio, …) — chat + embeddings. */
export function createOpenAiCompatibleAi(opts: {
  baseUrl: string;
  apiKey?: string | undefined;
  model?: string | undefined;
  defaultModel?: string | undefined;
  embedModel?: string | undefined;
}): SelfHostAi {
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
      const resolvedModel = resolveModel(opts.model, model, opts.defaultModel ?? DEFAULT_OPENAI_COMPATIBLE_CHAT_MODEL);
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          model: resolvedModel,
          messages: toMessages(options),
          max_tokens: options.max_tokens,
          temperature: options.temperature,
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`ai_http_${res.status}`);
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const usage = extractCliUsage(JSON.stringify(data));
      return { response: data.choices?.[0]?.message?.content ?? "", usage: { ...usage, model: usage.model ?? resolvedModel } };
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
      const resolvedModel = resolveModel(opts.model, model, "claude-sonnet-5");
      const res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: resolvedModel, max_tokens: options.max_tokens ?? 1024, ...(system ? { system } : {}), messages }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`anthropic_http_${res.status}`);
      const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
      const usage = extractCliUsage(JSON.stringify(data));
      return {
        response: (data.content ?? [])
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join(""),
        usage: { ...usage, model: usage.model ?? resolvedModel },
      };
    },
  };
}

// ── Subscription CLI providers (#979) — locally-authenticated `claude` / `codex` as a subprocess ──────────
// SECURITY: subscription CLIs get a strict allowlisted env, not the worker env. This keeps runtime
// credentials out of prompt-injectable subprocesses while preserving CLI auth/home/proxy/cert settings. The CLI
// runs read-only / no extra tools, and non-zero exit / empty output / error-envelope THROWS so the caller degrades.
const SUBSCRIPTION_CLI_ENV_ALLOWLIST = [
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

const DEFAULT_SUBSCRIPTION_CLI_BIN_DIR = "/home/node/.npm-global/bin";

function normalizeCliPathDir(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\/+$/, "");
}

export function resolveSubscriptionCliPath(parent: Record<string, string | undefined>): string {
  const prefixBin = normalizeCliPathDir(parent.NPM_CONFIG_PREFIX);
  const prepend = [prefixBin ? `${prefixBin}/bin` : undefined, DEFAULT_SUBSCRIPTION_CLI_BIN_DIR].filter((v): v is string => Boolean(v));
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const part of [...prepend, ...(parent.PATH ?? "").split(delimiter)]) {
    const trimmed = part.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    parts.push(trimmed);
  }
  return parts.join(delimiter);
}

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
  child.PATH = resolveSubscriptionCliPath(parent);
  return child;
}

function assertCodexCredentialIsolation(parent: Record<string, string | undefined>): void {
  // `codex exec` receives attacker-controlled PR title/body/diff text. Its read-only sandbox prevents writes, but not
  // reads, so a self-hosted OAuth home mounted into the same filesystem can be prompt-injected into public output.
  // Fail closed until Codex exposes a brokered credential mode that does not put auth.json in the review sandbox.
  if (parent.CODEX_HOME || parent.GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER !== "1") {
    throw new Error("codex_credential_isolation_required");
  }
}

function codexCliEnv(parent: Record<string, string | undefined>): Record<string, string | undefined> {
  const child = subscriptionCliEnv(parent);
  delete child.CODEX_HOME;
  return child;
}

/** Resolve the path to codex's auth file so we can preflight it before spawning the subprocess.
 *  Codex stores credentials at `$CODEX_HOME/auth.json` when CODEX_HOME is set, otherwise
 *  `$HOME/.codex/auth.json`. The Docker setup symlinks /home/node/.codex → /data/codex, so this
 *  path is only populated after the operator runs `codex auth` at runtime. */
export function resolveCodexAuthPath(env: Record<string, string | undefined>): string {
  // Use the sync path.join from the already-imported "node:path" delimiter import above.
  // We only need `join` here, which we can reconstruct simply to avoid a dynamic import in a sync helper.
  const sep = "/";
  const base = env.CODEX_HOME ?? `${env.HOME ?? "~"}${sep}.codex`;
  return `${base}${sep}auth.json`;
}

/** Throws `codex_auth_not_configured` if codex's auth.json does not exist or is unreadable.
 *  Called before spawning the codex subprocess so the error message is immediately actionable
 *  ("run `codex auth`") rather than the cryptic `codex_exit_1: Reading prompt from stdin...`
 *  that surfaces when the CLI silently fails without credentials. */
async function assertCodexAuthConfigured(env: Record<string, string | undefined>): Promise<void> {
  const { access, constants } = await import("node:fs/promises");
  const authPath = resolveCodexAuthPath(env);
  try {
    await access(authPath, constants.R_OK);
  } catch {
    throw new Error(
      `codex_auth_not_configured: ${authPath} not found or unreadable — run \`codex auth\` to authenticate, then restart the container`,
    );
  }
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
      if (typeof text === "string") return text;
      const item = asRecord(o.item);
      if (typeof item?.text === "string") return item.text;
      const content = item?.content;
      if (Array.isArray(content)) {
        return content
          .map((part) => asRecord(part)?.text)
          .filter((part): part is string => typeof part === "string")
          .join("");
      }
      return "";
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

export type CliUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  model?: string;
};

export type AiUsage = CliUsage & {
  provider?: string;
  effort?: string;
};

const INPUT_TOKEN_KEYS = ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"] as const;
const OUTPUT_TOKEN_KEYS = ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"] as const;
const TOTAL_TOKEN_KEYS = ["total_tokens", "totalTokens"] as const;
const COST_KEYS = ["total_cost_usd", "totalCostUsd", "cost_usd", "costUsd"] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function finiteNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function maxNumber(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  let out: number | undefined;
  for (const key of keys) {
    const n = finiteNumber(record[key]);
    if (n !== undefined) out = Math.max(out ?? 0, n);
  }
  return out;
}

function mergeUsage(out: CliUsage, record: Record<string, unknown>): void {
  const nested = [
    record,
    asRecord(record.usage),
    asRecord(record.token_usage),
    asRecord(record.tokenUsage),
    asRecord(record.usage_metadata),
    asRecord(record.usageMetadata),
  ].filter((entry): entry is Record<string, unknown> => Boolean(entry));
  for (const entry of nested) {
    const inputTokens = maxNumber(entry, INPUT_TOKEN_KEYS);
    if (inputTokens !== undefined) out.inputTokens = Math.max(out.inputTokens ?? 0, inputTokens);
    const outputTokens = maxNumber(entry, OUTPUT_TOKEN_KEYS);
    if (outputTokens !== undefined) out.outputTokens = Math.max(out.outputTokens ?? 0, outputTokens);
    const totalTokens = maxNumber(entry, TOTAL_TOKEN_KEYS);
    if (totalTokens !== undefined) out.totalTokens = Math.max(out.totalTokens ?? 0, totalTokens);
    const costUsd = maxNumber(entry, COST_KEYS);
    if (costUsd !== undefined) out.costUsd = Math.max(out.costUsd ?? 0, costUsd);
    if (typeof entry.model === "string" && entry.model.trim()) out.model = entry.model.trim();
  }
}

/** Best-effort usage extraction from subscription CLI JSON/JSONL output. Claude Code's authoritative usage is OTEL,
 *  while Codex JSONL is still evolving, so this accepts common token/cost field spellings and records the largest
 *  cumulative value seen across the stream. Missing fields simply mean "no metric", never a review failure. */
export function extractCliUsage(stdout: string): CliUsage {
  const usage: CliUsage = {};
  const trimmed = stdout.trim();
  if (!trimmed) return usage;
  const parse = (text: string): void => {
    try {
      const record = asRecord(JSON.parse(text));
      if (record) mergeUsage(usage, record);
    } catch {
      // Non-JSON output is valid for some CLI failure modes; usage is best-effort only.
    }
  };
  parse(trimmed);
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.trim()) parse(line);
  }
  return usage;
}

function cliUsageFromStdout(provider: string, model: string, effort: string, stdout: string): AiUsage & { model: string } {
  const usage = extractCliUsage(stdout);
  return { ...usage, provider, model: usage.model ?? (model || "default"), effort };
}

function recordCliUsageMetrics(provider: string, model: string, effort: string, stdout: string): AiUsage & { model: string } {
  const usage = cliUsageFromStdout(provider, model, effort, stdout);
  const labels = { provider, model: usage.model, effort };
  incr("gittensory_ai_requests_total", labels);
  incr("gittensory_ai_cost_usd_total", { provider: labels.provider }, usage.costUsd ?? 0);
  if (usage.inputTokens !== undefined) incr("gittensory_ai_input_tokens_total", { ...labels, kind: "review" }, usage.inputTokens);
  if (usage.outputTokens !== undefined) incr("gittensory_ai_output_tokens_total", { ...labels, kind: "review" }, usage.outputTokens);
  if (usage.totalTokens !== undefined) incr("gittensory_ai_total_tokens_total", labels, usage.totalTokens);
  return usage;
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

/** Extract a diagnostic error string from Codex's JSONL stdout on a non-zero exit. Codex writes its actual
 *  error (auth failure, unknown model, API error) into the JSON stream rather than stderr — stderr typically
 *  contains only the startup status "Reading prompt from stdin..." which is uninformative. Scans lines in
 *  reverse (the error object is usually last) and returns the first human-readable detail found, or null. */
export function codexErrorFromStdout(stdout: string): string | null {
  const lines = stdout.trim().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line?.trim()) continue;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      const errorObj = o.error as Record<string, unknown> | undefined;
      const detail =
        (typeof o.error === "string" && o.error) ||
        (typeof o.message === "string" && o.message) ||
        (typeof o.msg === "string" && o.msg) ||
        (errorObj && typeof errorObj.message === "string" ? errorObj.message : null) ||
        null;
      if (detail) return redactSecrets(detail).slice(0, 500);
    } catch {
      /* not JSON — skip */
    }
  }
  return null;
}

type SpawnFn = (
  cmd: string,
  args: string[],
  opts: {
    env: Record<string, string | undefined>;
    input?: string;
    timeoutMs: number;
    cwd?: string;
    // Optional, generic on SpawnFn (not codex-specific) so any CLI whose real progress lands on STDOUT (not
    // stderr banners/logs) could opt in later — but ONLY codex wires it up today (see
    // resolveCodexFirstOutputTimeoutMs): Claude Code has no comparable prod-observed dead-air hang, so leaving
    // this undefined for that caller keeps its spawn path byte-identical to before this option existed. See the
    // stdout-only rationale on the timer construction below — this deadline is cleared by stdout data ONLY.
    firstOutputTimeoutMs?: number;
  },
) => Promise<{ stdout: string; code: number | null; stderr?: string; timedOut?: boolean; stalledNoOutput?: boolean }>;

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
      let sawStdout = false;
      /* v8 ignore start */ // a 120s subprocess timeout is not unit-testable without a 2-minute wait
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        // Resolve (not reject) so callers receive whatever stdout/stderr was accumulated before the kill —
        // that partial output may contain the real error detail (e.g. codex JSONL error lines).
        resolve({ stdout, code: null, stderr, timedOut: true });
      }, o.timeoutMs);
      /* v8 ignore stop */
      // Fast-fail deadline (GITTENSORY-K/GITTENSORY-M): a SEPARATE, shorter timer that only fires if STDOUT has
      // not produced a single byte by firstOutputTimeoutMs — cleared the instant any data arrives on stdout, same
      // as the full timer is cleared on `close`/`error`. Deliberately STDOUT-ONLY, not "either stream": codex's
      // own "Reading prompt from stdin..." startup banner is written to STDERR unconditionally, on every
      // invocation, whether or not it goes on to actually process anything — clearing on stderr too would let
      // that banner alone satisfy the deadline forever, which is exactly the real hang this exists to catch
      // (confirmed as a defect during review: the first version of this fix cleared on either stream and would
      // never have fired for the actual "banner then silence" failure mode). Real JSONL progress from codex
      // (`--json`) always lands on stdout, so stdout is the only reliable "codex is genuinely alive" signal. If
      // output DOES start flowing on stdout but then stalls later, only the full timeoutMs above still governs —
      // this timer has already been cleared by the first stdout byte and never fires.
      const firstOutputTimer =
        o.firstOutputTimeoutMs != null
          ? /* v8 ignore start */ // real-timer path; tests inject a fake spawnImpl instead of racing setTimeout
            setTimeout(() => {
              child.kill("SIGKILL");
              resolve({ stdout, code: null, stderr, timedOut: true, stalledNoOutput: true });
            }, o.firstOutputTimeoutMs)
          : /* v8 ignore stop */
            undefined;
      child.stdout?.on("data", (d: Buffer) => {
        if (!sawStdout) {
          sawStdout = true;
          if (firstOutputTimer) clearTimeout(firstOutputTimer);
        }
        stdout += d.toString("utf8");
      });
      child.stderr?.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        if (firstOutputTimer) clearTimeout(firstOutputTimer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (firstOutputTimer) clearTimeout(firstOutputTimer);
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

function errorMessage(error: unknown, knownSecrets: readonly string[] = []): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message, knownSecrets).slice(0, 500);
}

function logSelfHostAiProviderFailed(input: {
  provider: string;
  model: string;
  effort?: string | undefined;
  timeoutMs?: number | undefined;
  error: unknown;
  knownSecrets?: readonly string[] | undefined;
  // Correlation context (#codex-timeout-fields), forwarded from the caller's AiRunOptions when supplied — never
  // fabricated here. Undefined fields are dropped by JSON.stringify, so an omitted value keeps the log line
  // byte-identical to before this field existed.
  jobId?: string | undefined;
  repoFullName?: string | undefined;
  pullNumber?: number | undefined;
  attempt?: number | undefined;
}): void {
  console.error(
    JSON.stringify({
      level: "error",
      event: "selfhost_ai_provider_failed",
      provider: input.provider,
      model: input.model || "default",
      effort: input.effort,
      timeoutMs: input.timeoutMs,
      jobId: input.jobId,
      repoFullName: input.repoFullName,
      pullNumber: input.pullNumber,
      attempt: input.attempt,
      error: errorMessage(input.error, input.knownSecrets),
    }),
  );
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
      const claudeModel = resolveModel(configuredClaudeModel(parentEnv, options.claudeModel), model, "claude-sonnet-5");
      const effort = resolveEffort(firstConfigured(options.claudeEffort, parentEnv.CLAUDE_AI_EFFORT));
      const timeoutMs = resolveClaudeCliTimeoutMs(parentEnv);
      let attempted = false;
      let stdoutForMetrics = "";
      try {
        if (!token) throw new Error("claude_code_no_oauth_token");
        // Usage telemetry (#claude-code-otel-passthrough): the allowlist deliberately excludes these -- they are
        // plain, non-secret config (an exporter endpoint/protocol, a boolean, a poll interval), never PR content
        // or credentials -- so they're threaded through explicitly here, the same way CLAUDE_CODE_OAUTH_TOKEN is,
        // rather than widening SUBSCRIPTION_CLI_ENV_ALLOWLIST itself (which also gates the codex subprocess and
        // should stay minimal). Without this the CLI silently never emits telemetry: the parent container has the
        // OTEL vars, but the spawned subprocess previously received none of them, so the Claude usage dashboard
        // (Grafana, via the OTEL collector → Prometheus) stayed empty regardless of `.env`.
        const env = subscriptionCliEnv(parentEnv, {
          CLAUDE_CODE_OAUTH_TOKEN: token,
          CLAUDE_CODE_ENABLE_TELEMETRY: parentEnv.CLAUDE_CODE_ENABLE_TELEMETRY,
          OTEL_METRICS_EXPORTER: parentEnv.OTEL_METRICS_EXPORTER,
          OTEL_TRACES_EXPORTER: parentEnv.OTEL_TRACES_EXPORTER,
          OTEL_EXPORTER_OTLP_ENDPOINT: parentEnv.OTEL_EXPORTER_OTLP_ENDPOINT,
          OTEL_EXPORTER_OTLP_PROTOCOL: parentEnv.OTEL_EXPORTER_OTLP_PROTOCOL,
          OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: parentEnv.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE,
          OTEL_METRIC_EXPORT_INTERVAL: parentEnv.OTEL_METRIC_EXPORT_INTERVAL,
        });
        const systemAppend = normalizedSystemAppend(options);
        const prompt = toCliPrompt(options, systemAppend);
        const spawn = spawnImpl ?? (await defaultSpawn());
        const args = ["--print", "--output-format", "json", "--model", claudeModel, "--permission-mode", "plan", "--effort", effort, "--disallowedTools", "Bash,Edit,Write,WebFetch,WebSearch"];
        if (systemAppend) args.push("--append-system-prompt", systemAppend);
        attempted = true;
        const { stdout, code, stderr, timedOut } = await spawn(
          "claude",
          args,
          { env, input: prompt, timeoutMs, cwd: await isolatedCliCwd() },
        );
        stdoutForMetrics = stdout;
        if (timedOut) throw new Error("subscription_cli_timeout");
        // Surface the STRUCTURED error envelope FIRST. `claude --output-format json` reports API/auth/model errors in its
        // stdout JSON ({is_error,api_error_status}) on a NON-ZERO exit too — e.g. an unknown model exits 1 with the 404
        // envelope in stdout and EMPTY stderr. Checking it before the exit code turns an opaque `claude_code_exit_1: `
        // (the #1610 symptom) into a precise `claude_code_error_404` — the signal that makes a reviewer outage
        // diagnosable in logs + Sentry instead of a dead end.
        const errStatus = claudeErrorStatus(stdout);
        if (errStatus) throw new Error(`claude_code_error_${errStatus}`);
        if (code !== 0) throw new Error(`claude_code_exit_${code ?? "null"}: ${redactSecrets(stderr ?? "", [token]).slice(0, 500)}`);
        const text = extractCliText(stdout);
        if (!text) throw new Error("claude_code_empty_output");
        return { response: text, usage: cliUsageFromStdout("claude-code", claudeModel, effort, stdoutForMetrics) };
      } catch (error) {
        logSelfHostAiProviderFailed({
          provider: "claude-code",
          model: claudeModel,
          effort,
          timeoutMs,
          error,
          knownSecrets: token ? [token] : [],
          jobId: options.jobId,
          repoFullName: options.repoFullName,
          pullNumber: options.pullNumber,
          attempt: options.attempt,
        });
        throw error;
      } finally {
        if (attempted) recordCliUsageMetrics("claude-code", claudeModel, effort, stdoutForMetrics);
      }
    },
  };
}

/** Codex subscription (`codex exec`). Fail closed by default: Codex OAuth homes are readable by prompt-influenced
 *  review sandboxes unless an operator explicitly opts into that risk for an isolated deployment. */
export function createCodexAi(
  parentEnv: Record<string, string | undefined>,
  spawnImpl?: SpawnFn,
  authCheckImpl: (env: Record<string, string | undefined>) => Promise<void> = assertCodexAuthConfigured,
): SelfHostAi {
  return {
    async run(model, options) {
      // Codex is chat-only here — reject embed requests so the chain routes them to an embed-capable provider.
      if (options.text) throw new Error("codex_no_embed");
      // codex 0.142+: `exec` is non-interactive — the old `--ask-for-approval` flag was REMOVED (passing it errors).
      // `--skip-git-repo-check` lets it run outside a git repo. Pass `--model` ONLY when one is explicitly
      // configured: otherwise Codex selects the account default.
      const codexModel = resolveModel(configuredCodexModel(parentEnv, options.codexModel), model, "");
      const effort = resolveCodexEffort(firstConfigured(options.codexEffort, parentEnv.CODEX_AI_EFFORT));
      const timeoutMs = resolveCodexCliTimeoutMs(parentEnv);
      // Clamp below timeoutMs so a misconfigured/low CODEX_AI_TIMEOUT_MS (its own floor is 30_000ms, the same as
      // this deadline's default) can never make the fast-fail deadline equal or exceed the outer safety net —
      // that would make the "outer" timeout unreachable and defeat the point of having two distinct signals.
      const firstOutputTimeoutMs = Math.min(resolveCodexFirstOutputTimeoutMs(parentEnv), Math.max(1, timeoutMs - 1));
      let attempted = false;
      let stdoutForMetrics = "";
      try {
        assertCodexCredentialIsolation(parentEnv);
        await authCheckImpl(parentEnv);
        const env = codexCliEnv(parentEnv);
        const systemAppend = normalizedSystemAppend(options);
        const prompt = prependCodexSystemAppend(toCliPrompt(options, systemAppend), systemAppend);
        const spawn = spawnImpl ?? (await defaultSpawn());
        const args = ["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only"];
        if (codexModel) args.push("--model", codexModel);
        args.push("-c", `model_reasoning_effort="${effort}"`);
        attempted = true;
        const { stdout, code, stderr, timedOut, stalledNoOutput } = await spawn("codex", args, {
          env,
          // `codex exec` reads stdin when no prompt argv is provided; keep PR prompts/diffs out of process listings.
          input: prompt,
          timeoutMs,
          firstOutputTimeoutMs,
          cwd: await isolatedCliCwd(),
        });
        stdoutForMetrics = stdout;
        if (timedOut && stalledNoOutput) {
          // Fast-fail path (GITTENSORY-K/GITTENSORY-M): killed at firstOutputTimeoutMs, well before the full
          // timeoutMs, because STDOUT produced no bytes at all — the "Reading prompt from stdin..." hang where
          // codex prints its own startup banner to STDERR and then never emits any JSONL. Stdout-only is
          // deliberate: that banner would otherwise satisfy an "either stream" deadline on every single
          // invocation, defeating the point. A DISTINCT error (never reusing `codex_timeout`) so this fast-fail
          // is separately countable in Sentry/logs from a genuine full-timeout case where the process was at
          // least emitting JSONL before it was killed — that distinction is what lets an operator tell "codex
          // never started" apart from "codex hung mid-review".
          throw new Error("codex_stalled_no_output: no stdout within firstOutputTimeoutMs — codex likely hung reading stdin");
        }
        if (timedOut) {
          // Include whatever the JSONL stream captured before the kill — codex writes errors there, not to stderr.
          const detail = codexErrorFromStdout(stdout) ?? (redactSecrets(stderr ?? "").slice(0, 200) || "no output");
          throw new Error(`codex_timeout: ${detail}`);
        }
        if (code !== 0) {
          const stderrTrimmed = (stderr ?? "").trim();
          const jsonlDetail = codexErrorFromStdout(stdout);
          if (!jsonlDetail && stderrTrimmed === "Reading prompt from stdin...") {
            // codex's JSONL stream carried no structured detail and stderr is ONLY the stdin-reading banner (no
            // API/auth error appended) — auth.json was present at boot-time but is now expired or was deleted.
            // Surface a distinct error so Sentry groups it separately from genuine API failures (rate limits,
            // model errors, network issues).
            throw new Error("codex_no_auth: auth.json missing or expired — re-run `codex auth` and restart");
          }
          // Prefer the structured error from codex's JSONL stdout over the uninformative stderr startup message
          // ("Reading prompt from stdin..."). Codex reports auth/model/API failures in its JSON stream; stderr
          // at exit time usually only contains that startup status line and nothing actionable.
          const detail = jsonlDetail ?? redactSecrets(stderrTrimmed).slice(0, 500);
          throw new Error(`codex_exit_${code}: ${detail}`);
        }
        const text = extractCliText(stdout);
        if (!text) throw new Error("codex_empty_output");
        return { response: text, usage: cliUsageFromStdout("codex", codexModel, effort, stdoutForMetrics) };
      } catch (error) {
        logSelfHostAiProviderFailed({
          provider: "codex",
          model: codexModel,
          effort,
          timeoutMs,
          error,
          jobId: options.jobId,
          repoFullName: options.repoFullName,
          pullNumber: options.pullNumber,
          attempt: options.attempt,
        });
        throw error;
      } finally {
        if (attempted) recordCliUsageMetrics("codex", codexModel, effort, stdoutForMetrics);
      }
    },
  };
}

// Readiness tracking (#2497): /ready has no way to tell "every configured AI provider is unreachable" (bad
// API key, CLI missing auth, provider outage) from healthy — a live per-request reachability check would cost
// a real API/CLI call on every health-check tick, so instead track a consecutive-exhaustion streak here and
// let /ready read it. A single threshold absorbs one-off transient failures (a bad request, a momentary
// network blip) without flapping readiness; only a SUSTAINED run of total chain exhaustion degrades it.
const AI_UNHEALTHY_FAILURE_STREAK = 3;
let aiConsecutiveFailures = 0;

/** False once the chain has exhausted every provider AI_UNHEALTHY_FAILURE_STREAK times in a row; true otherwise
 *  (including when no AI call has happened yet, or the most recent one succeeded). */
export function isAiProviderHealthy(): boolean {
  return aiConsecutiveFailures < AI_UNHEALTHY_FAILURE_STREAK;
}

/** Test-only reset so streak state from one test can't leak into the next (module-level counter). */
export function resetAiProviderHealthForTest(): void {
  aiConsecutiveFailures = 0;
}

function recordAiProviderSuccess(): void {
  aiConsecutiveFailures = 0;
}

function recordAiProvidersExhausted(): void {
  aiConsecutiveFailures += 1;
}

// Per-provider circuit breaker (#2540): a provider that is failing hard (bad credential, sustained outage)
// otherwise pays the FULL cost of a fresh attempt (a real HTTP call, or a real CLI subprocess spawn) on
// every single review during the outage. This is independent of `aiConsecutiveFailures` above -- that streak
// tracks whole-CHAIN exhaustion for /ready; this tracks one PROVIDER's own reliability so a known-broken
// provider can be skipped fast without affecting readiness semantics.
const AI_PROVIDER_FAILURE_THRESHOLD = 3;
const AI_PROVIDER_COOLDOWN_MS = 60_000;
const aiProviderCircuits = new Map<string, { failures: number; cooldownUntil: number }>();
const EXPECTED_EMBEDDING_ROUTING_ERRORS = new Set(["claude_code_no_embed", "codex_no_embed"]);

/** Test-only reset so circuit state from one test can't leak into the next (module-level map). */
export function resetAiProviderCircuitBreakerForTest(): void {
  aiProviderCircuits.clear();
}

/** Whether a missing-CLI boot check should force /ready unhealthy: only when EVERY configured provider is
 *  among the missing-CLI set, i.e. the whole AI_PROVIDER chain has zero chance of working -- not just one
 *  provider within a chain that has a working fallback (another present CLI, or an HTTP-based provider,
 *  unverifiable this cheaply at boot but not KNOWN-broken either). Flagged by the gate's own review: an
 *  earlier version force-marked the whole probe unhealthy for ANY missing CLI, which was a false positive
 *  for a chain like "claude-code,anthropic" where claude-code's CLI is missing but anthropic can still serve
 *  every request via routeProviders' fallback (#2497 follow-up). Pure so the boundary is unit-testable
 *  independent of server.ts, which has no test harness. */
export function shouldMarkAiProviderUnhealthyAtBoot(
  configuredProviders: readonly string[],
  missingCliProviders: readonly string[],
): boolean {
  if (missingCliProviders.length === 0) return false;
  const configured = new Set(configuredProviders);
  if (configured.size === 0) return false;
  const missing = new Set(missingCliProviders);
  return [...configured].every((provider) => missing.has(provider));
}

/** Force the streak straight to the unhealthy threshold (#2497 follow-up): for a REQUIRED CLI-subscription
 *  provider's binary missing from PATH, caught at boot (server.ts's own fail-loud CLI-presence check) --
 *  a real, immediately-known misconfiguration that shouldn't need three real AI-call failures to surface in
 *  /ready, unlike a bad HTTP-provider API key or an unreachable endpoint, which can only be confirmed by a
 *  real call and so still rely on the historical streak above. Callers should gate this with
 *  shouldMarkAiProviderUnhealthyAtBoot so a chain with a working fallback provider isn't force-marked
 *  unhealthy just because one sibling provider's CLI is missing. */
export function markAiProviderUnhealthyAtBoot(): void {
  aiConsecutiveFailures = AI_UNHEALTHY_FAILURE_STREAK;
}

/** Try each provider in order until one returns; if all throw, rethrow the last error so the caller degrades
 *  (AI summary → "unavailable"; the review still runs deterministically). The fallback chain is what makes a
 *  BYOK setup robust — e.g. AI_PROVIDER="anthropic,ollama" uses the API first and a local model if it's down. */
export function createChainAi(providers: Array<{ name: string; ai: SelfHostAi }>): SelfHostAi {
  return {
    async run(model, options) {
      let lastError: unknown = new Error("no_ai_providers");
      const failures: Array<{ provider: string; error: string }> = [];
      for (const p of providers) {
        try {
          const result = await runProviderWithOtel(p, model, options);
          recordAiProviderSuccess();
          return result;
        } catch (error) {
          lastError = error;
          failures.push({ provider: p.name, error: errorMessage(error) });
          console.error(
            JSON.stringify({
              level: "warn",
              event: "selfhost_ai_provider_failed_in_chain",
              provider: p.name,
              jobId: options.jobId,
              repoFullName: options.repoFullName,
              pullNumber: options.pullNumber,
              attempt: options.attempt,
              error: errorMessage(error),
            }),
          );
        }
      }
      recordAiProvidersExhausted();
      console.error(
        JSON.stringify({
          level: "error",
          event: "selfhost_ai_providers_exhausted",
          provider: failures.length === 1 ? failures[0]?.provider : undefined,
          model: model || "default",
          providers: failures.map((failure) => failure.provider),
          failures,
          error: errorMessage(lastError),
        }),
      );
      throw lastError instanceof Error ? lastError : new Error("all_ai_providers_failed");
    },
  };
}

function requestKind(options: AiRunOptions): "embedding" | "review" {
  return Array.isArray(options.text) ? "embedding" : "review";
}

function isExpectedEmbeddingRoutingError(options: AiRunOptions, error: unknown): boolean {
  return requestKind(options) === "embedding" && EXPECTED_EMBEDDING_ROUTING_ERRORS.has(errorMessage(error));
}

async function runProviderWithOtel(
  provider: { name: string; ai: SelfHostAi },
  model: string,
  options: AiRunOptions,
): Promise<AiResult> {
  const circuit = aiProviderCircuits.get(provider.name);
  if (circuit && circuit.cooldownUntil > Date.now()) {
    incr("gittensory_ai_provider_circuit_open_total", { provider: provider.name });
    throw new Error(
      `circuit_open: provider "${provider.name}" is in cooldown after ${AI_PROVIDER_FAILURE_THRESHOLD} consecutive failures — skipping this attempt`,
    );
  }
  try {
    const result = await withReviewSpan(
      "selfhost.ai.provider",
      { "ai.provider": provider.name, "ai.model": model || "default", "ai.request_kind": requestKind(options) },
      () => provider.ai.run(model, options),
    );
    aiProviderCircuits.delete(provider.name);
    if (result.usage) {
      return {
        ...result,
        usage: {
          ...result.usage,
          provider: result.usage.provider ?? provider.name,
          model: result.usage.model ?? (model || "default"),
        },
      };
    }
    return result;
  } catch (error) {
    if (isExpectedEmbeddingRoutingError(options, error)) throw error;
    incr("gittensory_ai_provider_failures_total", { provider: provider.name });
    // Re-read the map here rather than reusing the `circuit` captured above: that read happened BEFORE the
    // `await` on the real provider call, so under concurrent same-provider calls it can be stale by the time
    // this catch runs, and computing `failures` from it would clobber a sibling call's write (lost-update race)
    // instead of accumulating. No `await` between this read and the `.set()` below, so it's race-free.
    const failures = (aiProviderCircuits.get(provider.name)?.failures ?? 0) + 1;
    aiProviderCircuits.set(provider.name, {
      failures,
      cooldownUntil: failures >= AI_PROVIDER_FAILURE_THRESHOLD ? Date.now() + AI_PROVIDER_COOLDOWN_MS : 0,
    });
    throw error;
  }
}

/** Build one provider adapter by name. Provider config stays explicit so dual-provider setups cannot accidentally
 *  reuse the wrong model/base/key across different backends. */
export function buildProvider(name: string, env: Record<string, string | undefined>): SelfHostAi | undefined {
  if (!isConfiguredSelfHostProvider(name, env)) return undefined;
  switch (name) {
    case "ollama":
    case "openai-compatible":
    case "openai":
      return createOpenAiCompatibleAi({
        baseUrl:
          name === "ollama"
            ? (env.OLLAMA_AI_BASE_URL ?? "http://localhost:11434/v1")
            : name === "openai"
              ? (env.OPENAI_AI_BASE_URL ?? "https://api.openai.com/v1")
              : (env.OPENAI_COMPATIBLE_AI_BASE_URL ?? "http://localhost:11434/v1"),
        apiKey: name === "ollama" ? env.OLLAMA_AI_API_KEY : name === "openai" ? env.OPENAI_API_KEY : env.OPENAI_COMPATIBLE_AI_API_KEY,
        model: configuredOpenAiCompatibleModel(name, env),
        defaultModel: defaultOpenAiCompatibleModel(name),
        embedModel: env.AI_EMBED_MODEL,
      });
    case "anthropic": {
      const apiKey = env.ANTHROPIC_API_KEY;
      return apiKey ? createAnthropicAi({ apiKey, model: configuredAnthropicModel(env), baseUrl: env.ANTHROPIC_AI_BASE_URL }) : undefined;
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
      if (!direct) return chain.run(model, options);
      try {
        const result = await runProviderWithOtel({ name, ai: direct }, colon < 0 ? "" : trimmed.slice(colon + 1), options);
        recordAiProviderSuccess();
        return result;
      } catch (error) {
        recordAiProvidersExhausted();
        throw error;
      }
    },
  };
}

/** Build the credentialed providers named in AI_PROVIDER (any without a credential are silently dropped), in
 *  order, lowercased. Shared by the adapter and the dual-review plan so they never disagree about which providers
 *  exist (e.g. an uncredentialed entry can't become a "reviewer" the router would then miss). */
function buildProviders(env: Record<string, string | undefined>): Array<{ name: string; ai: SelfHostAi }> {
  return resolveConfiguredProviderNames(env)
    .map((name) => ({ name, ai: buildProvider(name, env) }))
    .filter((p): p is { name: string; ai: SelfHostAi } => Boolean(p.ai));
}

/** The credentialed self-host provider names from AI_PROVIDER, in order. Empty when unconfigured. */
export function resolveProviderNames(env: Record<string, string | undefined>): string[] {
  return resolveConfiguredProviderNames(env);
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

/** Select the self-host AI provider(s) from AI_PROVIDER and wrap them in the name-aware router. A comma-separated
 *  list is addressable by name for configured reviewers (see `routeProviders`) and otherwise falls back through
 *  providers in order; a SINGLE provider is wrapped the same way — NOT returned bare — so a reviewer-plan address
 *  that names the provider (`{ model: "claude-code" }`, the single-provider plan from `resolveAiReviewerPlan`)
 *  resolves to that provider's own default model instead of reaching it verbatim as `claude --model claude-code`
 *  (a 404 that broke every review on a single-provider self-host, #1610). Returns undefined when unconfigured or no
 *  provider has its credential. */
export function createSelfHostAi(env: Record<string, string | undefined>): SelfHostAi | undefined {
  const providers = buildProviders(env);
  if (providers.length === 0) return undefined;
  return routeProviders(providers);
}

const COMBINE_STRATEGIES = new Set<CombineStrategy>(["single", "consensus", "synthesis"]);
const ON_MERGE_RULES = new Set<OnMerge>(["either", "both"]);
const TRUE_ENV_VALUES = new Set(["1", "true", "yes", "on"]);

function enabledEnvFlag(value: string | undefined): boolean {
  return TRUE_ENV_VALUES.has((value ?? "").trim().toLowerCase());
}

/** Resolve the self-host review plan from env. By default, `AI_PROVIDER=a,b` means one reviewer using `a` with
 *  `b` as the per-review fallback, so a Codex quota/auth outage can fall through to Claude Code without paying
 *  for two simultaneous reviewers. Existing multi-provider configs that explicitly set `AI_COMBINE` or
 *  `AI_ON_MERGE` keep their two-reviewer behavior; `AI_DUAL_REVIEW=1` is the explicit opt-in for new dual
 *  review configs. */
export function resolveAiReviewerPlan(
  env: Record<string, string | undefined>,
): { reviewers: Array<{ model: string; fallback?: string | null | undefined }>; combine: CombineStrategy; onMerge: OnMerge | undefined } | undefined {
  const names = resolveProviderNames(env);
  if (names.length === 0) return undefined;
  const hasLegacyDualReviewConfig = (env.AI_COMBINE ?? "").trim() !== "" || (env.AI_ON_MERGE ?? "").trim() !== "";
  if (names.length === 1) return { reviewers: [{ model: names[0] as string }], combine: "single", onMerge: undefined };
  if (!enabledEnvFlag(env.AI_DUAL_REVIEW) && !hasLegacyDualReviewConfig) {
    const primary = names[0] as string;
    const fallback = names.find((name) => name !== primary);
    return {
      reviewers: [
        {
          model: primary,
          ...(fallback ? { fallback } : {}),
        },
      ],
      combine: "single",
      onMerge: undefined,
    };
  }
  // Fail loud when the two SLOTS the dual-review plan actually uses (the first two names) are the same
  // provider: routeProviders' `byName` map collapses duplicate provider names to one runtime instance, so
  // "dual review" would silently become "one provider called twice" -- no independent second opinion, and
  // that provider's outage takes down both slots. A THIRD+ duplicate further down the list is fine; only
  // the first two matter because resolveAiReviewerPlan below caps reviewers at names.slice(0, 2).
  if (names[0] === names[1]) {
    throw new Error(
      `ai_reviewer_providers_not_distinct: AI_PROVIDER lists "${names[0]}" for both dual-review reviewer slots — configure two distinct providers (e.g. AI_PROVIDER=claude-code,codex) for independent dual review, or a single provider (AI_PROVIDER=codex) for single-reviewer mode.`,
    );
  }
  const rawCombine = (env.AI_COMBINE ?? "").trim().toLowerCase() as CombineStrategy;
  const combine: CombineStrategy = COMBINE_STRATEGIES.has(rawCombine) ? rawCombine : "synthesis";
  const rawOnMerge = (env.AI_ON_MERGE ?? "").trim().toLowerCase() as OnMerge;
  const onMerge = ON_MERGE_RULES.has(rawOnMerge) ? rawOnMerge : undefined;
  return { reviewers: names.slice(0, 2).map((model) => ({ model })), combine, onMerge };
}
