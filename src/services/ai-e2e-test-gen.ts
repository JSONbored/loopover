// Gittensory AI-generated E2E test coverage (the `e2eTests` capability, #4191/#4200, part of the #4189 epic).
//
// Turns a PR's changed-file diffs into a complete Playwright test file, following the SAME shape as
// `ai-slop.ts`'s AI-assisted advisory: an opt-in, fail-safe second capability layered on top of the
// deterministic engine, never blocking, never throwing, and BYOK-aware.
//
// Hard guarantees:
//   • Gated on the `e2eTests` converged feature (#4190): the global kill-switch AND the
//     repo-specific manifest/allowlist activation must both permit generation, PLUS the
//     same two generic AI toggles every AI-generated artifact in this codebase already respects
//     (AI_SUMMARIES_ENABLED, AI_PUBLIC_COMMENTS_ENABLED) — defense in depth, byte-identical to today when
//     any of the three is off.
//   • Fail-safe on every path: disabled / no provider / over-budget / unparseable output → `testSource: null`,
//     never a thrown error.
//   • BYOK-aware exactly like the AI review + slop advisory paths: the maintainer's own frontier model when
//     `providerKey` is supplied (billed to their account, counted against the shared per-repo/day BYOK cap),
//     else the free/default reviewer (self-host `env.AI` provider, or the legacy Workers-AI pair) metered
//     against the shared daily neuron budget (`sumAiEstimatedNeuronsSince` — the SAME counter every other
//     AI-generated artifact draws from, so this feature can never silently blow through the budget).
//   • Safety-aware: when the `safety` converged feature is on for the repo, the diff/title/body are defanged
//     (`defangReviewInput`) before they ever reach the model — the SAME prompt-injection defense the AI
//     reviewer itself uses, applied here rather than inventing a second one.
//   • The parsed test source is validated (fenced code block extraction + a Playwright-shaped signature
//     check) before being returned — malformed or off-topic model output is dropped, never surfaced.
import { countByokAiEventsForRepoSince, recordAiUsageEvent, sumAiEstimatedNeuronsSince } from "../db/repositories";
import { convergedFeatureActive } from "../review/feature-activation";
import { defangReviewInput } from "../review/safety";
import { isE2eTestGenerationEnabled } from "../review/e2e-test-gen-wire";
import { resolveReviewPathInstructions, type FocusManifestReviewConfig } from "../signals/focus-manifest";
import {
  type AiReviewActualUsage,
  type AiReviewProviderKey,
  BEST_REVIEW_MODELS,
  DEFAULT_BYOK_DAILY_REPO_LIMIT,
  RELIABLE_FALLBACK_MODELS,
  callAiProvider,
  clampNumber,
  coerceAiText,
  coerceAiUsage,
  estimateNeurons,
  isEnabled,
  utcDayStartIso,
} from "./ai-review";

type AiGatewayOptions = { gateway?: { id: string } };
type AiRunner = { run?: (model: string, options: Record<string, unknown>, extra?: AiGatewayOptions) => Promise<unknown> };

const E2E_TEST_GEN_SYSTEM_PROMPT = [
  "You are a senior test engineer writing an END-TO-END test for a pull request's changed behavior, using",
  "the requested test framework. Judge ONLY the diff and context provided.",
  "Write exactly ONE complete, runnable test file: correct imports, at least one realistic user-flow",
  "assertion covering the changed behavior, and at least one edge/error-path assertion when the diff makes",
  "one apparent. Prefer resilient selectors (role/text/testid) over brittle CSS/XPath.",
  "Follow any repo-specific test-coverage instructions provided EXACTLY — they encode the maintainer's own",
  "conventions and take precedence over your own defaults.",
  "Never invent application behavior the diff does not support; if the diff gives too little signal for a",
  "meaningful end-to-end test, write the closest reasonable test you honestly can rather than fabricating one.",
  "Never mention rewards, rankings, payouts, wallets, hotkeys, coldkeys, trust scores, scoreability, or",
  "reviewability.",
  "Respond with ONLY a single fenced code block containing the complete test file — no prose before or",
  "after the fence.",
].join(" ");

const E2E_TEST_GEN_MODELS = [BEST_REVIEW_MODELS[0], RELIABLE_FALLBACK_MODELS[0]] as const;
const E2E_TEST_GEN_ATTEMPTS_PER_MODEL = 3;
const E2E_TEST_GEN_MAX_CALLS = E2E_TEST_GEN_MODELS.length * E2E_TEST_GEN_ATTEMPTS_PER_MODEL;

const MAX_DIFF_CHARS = 60_000;
const MAX_FILES_IN_PROMPT = 20;
const DEFAULT_FRAMEWORK = "Playwright";

export type E2eTestGenChangedFile = {
  path: string;
  /** Unified-diff patch text (added/removed lines only). Absent/empty ⇒ excluded from the prompt — never
   *  guessed from the path alone. */
  patch?: string | null | undefined;
};

export type E2eTestGenInput = {
  repoFullName: string;
  prNumber: number;
  title: string;
  body?: string | null | undefined;
  files: E2eTestGenChangedFile[];
  /** Target test framework. Defaults to "Playwright" — see the #4189 epic for why. */
  framework?: string | undefined;
  /** Repo/path-scoped test-coverage instructions (#4200). Absent when unconfigured. */
  instructions?: string | null | undefined;
  actor?: string | null | undefined;
  /** Optional BYOK: when present, the maintainer's frontier model generates the test (billed to their
   *  account, counted against the shared per-repo/day BYOK cap) instead of the free/default reviewer. */
  providerKey?: AiReviewProviderKey | null | undefined;
};

export type E2eTestGenResult =
  | { status: "disabled"; reason: string }
  | { status: "unavailable"; reason: string }
  | { status: "quota_exceeded"; estimatedNeurons: number; remainingBudget: number }
  | { status: "ok"; testSource: string | null; estimatedNeurons: number };

/**
 * Pure: join a PR's changed-file patches into one diff-ish string for the prompt, capped on both file
 * count and total characters. A file with no patch text is skipped (fail-safe: absence of patch data is
 * never treated as "nothing changed here," it is simply omitted from the prompt).
 */
export function buildE2eTestGenDiffText(files: E2eTestGenChangedFile[]): string {
  const withPatches = files
    .filter((file) => typeof file.patch === "string" && file.patch.trim().length > 0)
    .slice(0, MAX_FILES_IN_PROMPT);
  if (withPatches.length === 0) return "";
  return withPatches
    .map((file) => `--- ${file.path} ---\n${file.patch}`)
    .join("\n\n")
    .slice(0, MAX_DIFF_CHARS);
}

/**
 * Pure: combine a repo's general `review.instructions` (#4200) with any `review.pathInstructions` entries
 * matching the PR's changed files into one instructions block for E2E test generation — reusing the
 * EXISTING config-as-code mechanism the AI reviewer itself already consumes (`resolveReviewPathInstructions`),
 * rather than inventing a second, e2e-test-gen-specific instructions schema. A maintainer's repo-wide
 * conventions ("use Playwright with our page-object pattern under test/e2e/pages/") and path-scoped rules
 * ("always test the payment-failure retry path for src/checkout/**") apply equally well to steering an AI
 * reviewer or an AI test generator, so both draw from the same maintainer-authored brief. Returns null when
 * nothing is configured (no repo-wide instructions, no matching path instructions) — never an empty string,
 * so a caller can treat "no instructions" and "instructions" as a clean two-way branch.
 */
export function resolveE2eTestGenInstructions(
  review: Pick<FocusManifestReviewConfig, "instructions" | "pathInstructions"> | null | undefined,
  changedPaths: string[],
): string | null {
  const repoWide = review?.instructions?.trim() || "";
  const pathGuidance = resolveReviewPathInstructions(review?.pathInstructions ?? [], changedPaths).trim();
  const combined = [repoWide, pathGuidance].filter(Boolean).join("\n\n");
  return combined || null;
}

/**
 * Pure: build the user prompt from an already-assembled (and, if the `safety` feature is on, already
 * defanged) diff/title/body. Callers that need defanging apply it before calling this — this function
 * itself never re-derives safety, matching the render-layer discipline established by fix-handoff.
 */
export function buildE2eTestGenPrompt(input: {
  repoFullName: string;
  prNumber: number;
  title: string;
  body?: string | null | undefined;
  diff: string;
  framework?: string | undefined;
  instructions?: string | null | undefined;
}): string {
  const framework = input.framework?.trim() || DEFAULT_FRAMEWORK;
  return [
    `Repository: ${input.repoFullName}`,
    `Pull request #${input.prNumber}: ${input.title}`,
    input.body ? `Description:\n${input.body.slice(0, 2000)}` : "Description: (none)",
    `Target test framework: ${framework}`,
    input.instructions ? `Repo-specific test-coverage instructions (follow exactly):\n${input.instructions.slice(0, 4000)}` : "",
    "",
    input.diff ? `Changed files (unified diff, truncated if large):\n${input.diff}` : "No test-relevant diff content available.",
  ]
    .filter(Boolean)
    .join("\n");
}

const FENCED_CODE_BLOCK_RE = /```(?:[a-z]*)\n([\s\S]*?)```/i;
// Deliberately narrow (mirrors #1972 boundary-test-generation's "false positives are worse than a narrow
// true-positive set" discipline): both a Playwright test call AND its own import must be present before
// model output is trusted as real Playwright source, not just plausible-looking prose.
const PLAYWRIGHT_TEST_SIGNATURE_RE = /\btest(?:\.describe)?\s*\(/;
const PLAYWRIGHT_IMPORT_RE = /from\s+["']@playwright\/test["']/;

/**
 * Pure: extract and validate a generated Playwright test file from raw model output. Strips a fenced code
 * block if present (falls back to the raw text otherwise, mirroring `parseSlopOpinion`'s tolerance for a
 * missing fence). Returns null — never throws, never returns unvalidated text — when the result doesn't
 * carry both a recognizable Playwright test call and its own `@playwright/test` import.
 */
export function parseE2eTestGenResponse(text: string): string | null {
  // The capture group is mandatory (no trailing `?`), so a successful match always populates match[1] —
  // the non-null assertion introduces no reachability gap (unlike a `?? ""` fallback, which would add an
  // unreachable branch that patch-coverage can never satisfy).
  const match = FENCED_CODE_BLOCK_RE.exec(text);
  const source = (match ? match[1]! : text).trim();
  if (!source) return null;
  if (!PLAYWRIGHT_TEST_SIGNATURE_RE.test(source)) return null;
  if (!PLAYWRIGHT_IMPORT_RE.test(source)) return null;
  return source;
}

type WorkersE2eTestGenResult = { testSource: string | null; usage?: AiReviewActualUsage | undefined };

/** One free/default-reviewer generation attempt (whichever provider `env.AI` resolves to) with bounded
 *  retry/fallback attempts, all pre-budgeted. Mirrors `runWorkersSlopOpinion`'s exact shape. */
async function runWorkersE2eTestGen(env: Env, system: string, user: string, maxTokens: number): Promise<WorkersE2eTestGenResult> {
  const ai = env.AI as unknown as AiRunner | undefined;
  if (!ai || typeof ai.run !== "function") return { testSource: null };
  const gatewayId = env.AI_GATEWAY_ID?.trim();
  const extra: AiGatewayOptions | undefined = gatewayId ? { gateway: { id: gatewayId } } : undefined;
  for (const model of E2E_TEST_GEN_MODELS) {
    for (let attempt = 0; attempt < E2E_TEST_GEN_ATTEMPTS_PER_MODEL; attempt += 1) {
      try {
        const result = await ai.run(
          model,
          { max_tokens: maxTokens, temperature: 0, messages: [{ role: "system", content: system }, { role: "user", content: user }] },
          extra,
        );
        const parsed = parseE2eTestGenResponse(coerceAiText(result));
        if (parsed) return { testSource: parsed, usage: coerceAiUsage(result) };
      } catch {
        /* retry / fall through to fallback */
      }
    }
  }
  return { testSource: null };
}

async function record(
  env: Env,
  input: E2eTestGenInput,
  status: string,
  estimatedNeurons: number,
  detail: string,
  metadata?: Record<string, unknown>,
  usage?: AiReviewActualUsage | undefined,
): Promise<void> {
  await recordAiUsageEvent(env, {
    feature: "ai_e2e_test_gen",
    actor: input.actor ?? null,
    route: "github_app.ai_e2e_test_gen",
    // `byok:<provider>` so countByokAiEventsForRepoSince (model LIKE 'byok:%') counts it toward the cap.
    // Non-BYOK: prefer the REAL model the provider reported (usage.model, populated for self-host CLI/HTTP
    // providers including advisory-routed Ollama calls) over the hardcoded fallback label, which otherwise
    // misrepresented every advisory-routed call as a legacy Workers-AI model id it never actually ran on.
    model: input.providerKey ? `byok:${input.providerKey.provider}` : (usage?.model ?? E2E_TEST_GEN_MODELS.join("+")),
    status,
    estimatedNeurons,
    provider: usage?.provider,
    effort: usage?.effort,
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    totalTokens: usage?.totalTokens,
    costUsd: usage?.costUsd,
    detail,
    metadata: { repoFullName: input.repoFullName, pullNumber: input.prNumber, ...(metadata ?? {}) },
  });
}

/**
 * Generate a Playwright E2E test for a PR's changed behavior. Fail-safe on every path — `disabled` /
 * `unavailable` / `quota_exceeded` / an `ok` result with `testSource: null` are all valid, non-throwing
 * outcomes; the caller decides what (if anything) to render or dispatch from the result.
 */
export async function runGittensoryE2eTestGeneration(env: Env, input: E2eTestGenInput): Promise<E2eTestGenResult> {
  if (!isE2eTestGenerationEnabled(env)) return { status: "disabled", reason: "E2E test generation is disabled." };
  if (!(await convergedFeatureActive(env, input.repoFullName, "e2eTests"))) {
    return { status: "disabled", reason: "E2E test generation is not enabled for this repository." };
  }
  if (!isEnabled(env.AI_SUMMARIES_ENABLED)) return { status: "disabled", reason: "AI summaries are disabled." };
  if (!isEnabled(env.AI_PUBLIC_COMMENTS_ENABLED)) return { status: "disabled", reason: "Public AI comments are disabled." };
  if (!input.providerKey && !env.AI) return { status: "unavailable", reason: "AI provider is not configured." };

  const rawDiff = buildE2eTestGenDiffText(input.files);
  const safetyOn = await convergedFeatureActive(env, input.repoFullName, "safety");
  const defanged = safetyOn
    ? defangReviewInput({ repoFullName: input.repoFullName, prNumber: input.prNumber, title: input.title, body: input.body, diff: rawDiff })
    : { title: input.title, body: input.body, diff: rawDiff };

  const maxTokens = clampNumber(Number(env.AI_MAX_OUTPUT_TOKENS) || 4096, 1024, 8192);
  const user = buildE2eTestGenPrompt({
    repoFullName: input.repoFullName,
    prNumber: input.prNumber,
    title: defanged.title,
    body: defanged.body,
    diff: defanged.diff,
    framework: input.framework,
    instructions: input.instructions,
  });

  // Free calls = the pre-budgeted retry/fallback attempts (worst case), same discipline as ai-slop.ts's
  // WORKERS_SLOP_MAX_CALLS — malformed output or transient failures can never amplify spend beyond the
  // daily neuron budget. BYOK bills the maintainer's own account, so it draws 0 free-budget calls.
  const freeCalls = input.providerKey ? 0 : E2E_TEST_GEN_MAX_CALLS;
  const estimatedNeurons = freeCalls === 0 ? 0 : estimateNeurons(E2E_TEST_GEN_SYSTEM_PROMPT.length + user.length, maxTokens, freeCalls);
  // Resolve the shared daily neuron budget IDENTICALLY to the AI review + slop paths: default HIGH
  // (10,000,000), clamp to 10,000,000 — every AI-generated artifact sums into the SAME usage counter.
  const rawNeuronBudget = Number(env.AI_DAILY_NEURON_BUDGET);
  const budget = clampNumber(env.AI_DAILY_NEURON_BUDGET && Number.isFinite(rawNeuronBudget) ? rawNeuronBudget : 10_000_000, 0, 10_000_000);
  const used = await sumAiEstimatedNeuronsSince(env, utcDayStartIso());
  const remainingBudget = Math.max(0, budget - used);
  if (estimatedNeurons > remainingBudget) {
    await record(env, input, "quota_exceeded", 0, `estimated ${estimatedNeurons} neurons exceeds remaining ${remainingBudget}`);
    return { status: "quota_exceeded", estimatedNeurons, remainingBudget };
  }
  if (input.providerKey) {
    const byokDailyLimit = clampNumber(Number(env.AI_BYOK_DAILY_REPO_LIMIT || DEFAULT_BYOK_DAILY_REPO_LIMIT), 0, 10_000);
    const byokUsed = await countByokAiEventsForRepoSince(env, input.repoFullName, utcDayStartIso());
    if (byokUsed >= byokDailyLimit) {
      await record(env, input, "quota_exceeded", 0, `BYOK daily repo limit ${byokDailyLimit} reached`);
      return { status: "quota_exceeded", estimatedNeurons, remainingBudget };
    }
  }

  // BYOK frontier model if configured, else the free/default-reviewer primary (with fallback). Both fail-safe to null.
  let testSource: string | null;
  let usage: AiReviewActualUsage | undefined;
  if (input.providerKey) {
    const { text, usage: byokUsage } = await callAiProvider(input.providerKey, E2E_TEST_GEN_SYSTEM_PROMPT, user, maxTokens);
    testSource = text ? parseE2eTestGenResponse(text) : null;
    usage = byokUsage;
  } else {
    ({ testSource, usage } = await runWorkersE2eTestGen(env, E2E_TEST_GEN_SYSTEM_PROMPT, user, maxTokens));
  }
  await record(
    env,
    input,
    "ok",
    estimatedNeurons,
    testSource ? "test source generated" : "no usable output",
    { byok: Boolean(input.providerKey) },
    usage,
  );
  return { status: "ok", testSource, estimatedNeurons };
}

/** Internal helpers exposed for unit testing only (mirrors `__aiSlopInternals`'s shape) — not part of the
 *  public module surface. */
export const __aiE2eTestGenInternals = { runWorkersE2eTestGen };
