#!/usr/bin/env node
// #9563: every webhook-owned handler must decide about #9312's redelivery guard, out loud.
//
// GitHub can redeliver the same issue_comment, and the job queue's max_retries:3 plus the DLQ re-drive reuse
// the identical deliveryId. There is no global delivery-level dedupe: src/github/webhook.ts suppresses a
// re-POST whose row is already `processed`, but a QUEUE retry re-enters processGitHubWebhook directly, and
// recordWebhookEvent is an upsert written AFTER the handler returns. So a handler without the guard genuinely
// runs twice, and #9312 added one to the handlers someone greped for at the time. Three were missed (#9561,
// #9562): one wrote duplicate permanent review-memory suppression rows, two spent a second paid model call.
//
// WHY A GREP MISSES THEM, and therefore why this check is not just a lint. The handlers are written in two
// different formatting styles -- some declare the identical signature on one line, some across five:
//
//   async function maybeProcessResolveCommand(env: Env, deliveryId: string, payload: GitHubWebhookPayload): ...
//   async function maybeProcessGateOverrideCommand(
//     env: Env,
//     deliveryId: string,
//     payload: GitHubWebhookPayload,
//   ): Promise<boolean> {
//
// A grep for either shape silently misses the other half of the family, which is the mechanical cause of the
// drift rather than carelessness (#9541 opens on exactly this observation). This check normalizes whitespace
// so the signature matches regardless of formatting.
//
// The allowlist below carries the handlers that are safe WITHOUT the guard, each with the mechanism that makes
// it safe -- so "this one is fine" is a stated claim a reviewer can check, not an absence someone has to
// re-derive. Same "an exception must be stated, not inferred from absence" shape as check-dead-source-files.ts
// and check-regate-sort-key.ts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SCANNED_FILE = "src/queue/processors.ts";

/**
 * The calls that count as having made the decision — either satisfies this check.
 *
 * `hasAuditEventForDelivery` is the guard itself. `runPrCommandPrologueForEnv` is #9541's shared prologue,
 * which OWNS that call for the `@loopover <verb>` command family: a handler delegating to it cannot skip the
 * guard, because the sequence is no longer the handler's to get wrong. Accepting delegation is the point —
 * it means the cheapest way to satisfy this check is also the structurally correct one.
 */
const GUARD_CALLS = ["hasAuditEventForDelivery", "runPrCommandPrologueForEnv"] as const;

/**
 * Hard ceiling on how far a handler body may be scanned, purely so a malformed/unbalanced file cannot make
 * this walk the rest of the module. The real bound is the function's own closing brace — see {@link bodyText}.
 * The largest handler in the family is ~470 lines today.
 */
const HANDLER_SCAN_CEILING_LINES = 900;

/**
 * Handlers that are safe WITHOUT the guard, each with the specific mechanism. Both were verified by reading
 * the call paths, not inferred from the function name.
 */
const ALLOWED_WITHOUT_GUARD: ReadonlyMap<string, string> = new Map([
  [
    "maybeProcessConfigurationCommand",
    "Read-only. Its only effect is createOrUpdateAgentCommandComment with a deterministic body (summarizeEffectiveConfig), so a replay produces a byte-identical body and the PATCH is skipped — no new comment, no model call, no state mutation. Duplicate telemetry rows only.",
  ],
  [
    "maybeProcessAgentCommandFeedbackReaction",
    "Idempotent by uniqueness constraint, not by suppression. Its only persistent write, recordAgentCommandFeedback, is an onConflictDoUpdate targeting (answerId, actorHash) — backed by the unique index github_agent_command_feedback_actor_answer_unique — and actorHash is derived from repo + actor login, so a replay rewrites the same row with the same vote rather than double-counting. getCommandUsefulnessSummary aggregates that table, not the audit log. Nothing else here posts a comment, calls a model, or writes a product-usage row.",
  ],
  [
    "maybeProcessPlanCommand",
    "isPlanCommandCoolingDown already short-circuits a replay into recordPlanSkip(\"cooldown_active\") before any generateIssuePlan spend. Its key (actor + repo) is strictly BROADER than the guard's (actor + targetKey + deliveryId), and ISSUE_PLAN_COOLDOWN_MS is 10 * 60 * 1000 — identical to COMMAND_RATE_LIMIT_REDELIVERY_WINDOW_MS — so the coverage window matches exactly.",
  ],
]);

export type RedeliveryGuardViolation = { file: string; line: number; handler: string };

/**
 * Pure over its inputs: every handler in the `(env, deliveryId, payload)` webhook family that neither calls
 * {@link GUARD_CALL} nor appears in the allowlist. `readFile` is injectable so tests can drive a synthetic
 * offender without touching the tree.
 */
export function findMissingRedeliveryGuards(
  options: {
    file?: string;
    readFile?: (file: string) => string;
    allowedWithoutGuard?: ReadonlyMap<string, string>;
  } = {},
): RedeliveryGuardViolation[] {
  const {
    file = SCANNED_FILE,
    readFile = (target: string) => readFileSync(target, "utf8"),
    allowedWithoutGuard = ALLOWED_WITHOUT_GUARD,
  } = options;

  const lines = readFile(file).split("\n");
  const violations: RedeliveryGuardViolation[] = [];
  for (const [index, handler] of handlerDeclarations(lines)) {
    if (allowedWithoutGuard.has(handler)) continue;
    if (GUARD_CALLS.some((call) => bodyText(lines, index).includes(call))) continue;
    violations.push({ file, line: index + 1, handler });
  }
  return violations.sort((a, b) => a.line - b.line);
}

/**
 * Every `maybeProcess*` declaration whose parameter list is the webhook family's, as `[lineIndex, name]`.
 *
 * Matched against a WHITESPACE-NORMALIZED window rather than the raw line, because the signature is written
 * both on one line and across five — the formatting split that hid three of these from the greps that added
 * the guard in the first place.
 */
function handlerDeclarations(lines: readonly string[]): Array<[number, string]> {
  const found: Array<[number, string]> = [];
  for (const [index, line] of lines.entries()) {
    const declaration = /^\s*(?:export\s+)?async function (maybeProcess\w+)\s*\(/.exec(line);
    if (!declaration) continue;
    const name = declaration[1];
    if (name === undefined) continue;
    // Six lines is enough for the widest form in the family (name, three params, closing paren, return type)
    // without reaching into the body of a one-line declaration's successor.
    const signature = lines.slice(index, index + 6).join(" ").replace(/\s+/g, " ");
    // Optional spaces around the parens and before the trailing comma: after normalization the one-line form
    // yields "(env: Env, ...GitHubWebhookPayload)" and the multi-line form "( env: Env, ...Payload, )". Both
    // are the same signature, and requiring either spacing is precisely the half-blindness this check removes.
    if (!/\( ?env: Env, deliveryId: string, payload: GitHubWebhookPayload,? ?\)/.test(signature)) continue;
    found.push([index, name]);
  }
  return found;
}

/**
 * The text of the function body starting at `startIndex`, bounded by that function's own closing brace rather
 * than a fixed line count.
 *
 * A fixed window is what makes this class of check quietly useless: with handlers 30–470 lines long and packed
 * adjacently, a neighbour's guard call would satisfy the scan for the handler actually missing one. That exact
 * false negative happened while check-regate-sort-key.ts was being written, so this tracks brace depth and
 * judges each handler on its own body.
 */
function bodyText(lines: readonly string[], startIndex: number): string {
  const collected: string[] = [];
  let depth = 0;
  let opened = false;
  for (let i = startIndex; i < Math.min(lines.length, startIndex + HANDLER_SCAN_CEILING_LINES); i += 1) {
    const line = lines[i] ?? "";
    collected.push(line);
    for (const char of line) {
      if (char === "{") {
        depth += 1;
        opened = true;
      } else if (char === "}") depth -= 1;
    }
    if (opened && depth <= 0) break;
  }
  return collected.join("\n");
}

function main(): void {
  const violations = findMissingRedeliveryGuards();
  if (violations.length === 0) {
    process.stdout.write("command redelivery guards: OK\n");
    return;
  }
  process.stderr.write(`Found ${violations.length} webhook handler(s) with no redelivery guard (#9563):\n`);
  for (const violation of violations) {
    process.stderr.write(`  ${violation.file}:${violation.line} — ${violation.handler}\n`);
  }
  process.stderr.write(
    "\nGitHub redelivers the same issue_comment, and the queue's max_retries + DLQ re-drive reuse the identical\n" +
      "deliveryId. There is NO global delivery-level dedupe, so an unguarded handler runs twice — which has meant\n" +
      "duplicate permanent suppression rows and, for the panel handlers, a second paid model call.\n\n" +
      "Either add the guard:\n\n" +
      "  const redeliverySinceIso = new Date(Date.now() - COMMAND_RATE_LIMIT_REDELIVERY_WINDOW_MS).toISOString();\n" +
      `  if (await ${GUARD_CALLS[0]}(env, actor, "<completed event type>", targetKey, deliveryId, redeliverySinceIso)) return true;\n\n` +
      "...or delegate the whole prologue to runPrCommandPrologueForEnv (#9541), which owns the guard for you.\n\n" +
      "...or, if the handler is genuinely replay-safe, add it to ALLOWED_WITHOUT_GUARD in\n" +
      "scripts/check-command-redelivery-guards.ts WITH the mechanism that makes it safe.\n",
  );
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
