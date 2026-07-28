#!/usr/bin/env node
// #9003: a gate that can suppress a review or an action must be able to say WHY.
//
// The invariant, from the issue: "every decision -- and every NON-decision -- must record a reason. A pass
// that declines to review, declines to act, downgrades, defers, or drops work must emit an audit event naming
// the specific gate that made the call. 'Nothing happened and nothing says why' must be structurally
// impossible."
//
// This came out of the 2026-07-26 restart investigation, where a `forceAiReview: true` pass -- whose entire
// purpose is to spend a fresh review -- completed with no fresh review and ZERO audit events explaining why
// (#9000). Hours went into reverse-engineering by elimination. The disposition lane, which already names every
// hold via agentHoldAuditDetail, took minutes for the same class of question.
//
// WHAT THIS ENFORCES, and why it is shaped this way. It does not demand one particular return type. The
// codebase has already converged on two working answers, and either satisfies this check:
//
//   1. Return the reason directly. evaluateVisualVisionGate and evaluateScreenshotTableVisionGate return
//      `{ run: false, reason: "low_reputation" }` -- the gate and its explanation are one value, so they
//      cannot drift apart.
//   2. Pair the boolean with a resolver. shouldRequirePublicAiReviewForAdvisory stays boolean for the fast
//      path, and resolvePublicAiReviewGateSkipReason names the reason on the suppress path. Cheaper when the
//      hot path runs thousands of times and the reason is only needed when it says no.
//
// What is NOT acceptable is a bare boolean with no way to recover the reason, on a path where `false` silently
// suppresses work. That is exactly the shape that produced #9000.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The dispatch-path modules this applies to. Deliberately a named list rather than all of src/**: the rule is
 * about gates that suppress a REVIEW or an ACTION, and applying it to every boolean helper in the tree would
 * bury the few that matter under hundreds that do not -- the same reasoning src/selfhost/inert-config.ts uses
 * for scoping its own report.
 */
const DISPATCH_PATH_MODULES = [
  "src/queue/ai-review-orchestration.ts",
  "src/review/visual/visual-findings.ts",
  "src/review/visual/screenshot-table-vision.ts",
] as const;

/** Exported gate-shaped functions: the ones whose answer decides whether work happens. */
const GATE_DECLARATION = /^export (?:async )?function (should\w+|evaluate\w*Gate\w*|resolve\w*Gate\w*)\s*\(/gm;

/**
 * A return type that carries its own reason satisfies the rule outright; this matches only the bare-boolean
 * shape that does not.
 *
 * Deliberately NOT anchored to a line start. The first version was `/^\s*\)\s*:.../m`, which only ever matched
 * a multi-line signature -- so every single-line gate passed silently and the whole check was vacuous,
 * including against the real tree. Caught by the fixture tests, which is exactly what they are for.
 */
const BARE_BOOLEAN_RETURN = /\)\s*:\s*(?:Promise<\s*)?boolean\s*>?\s*\{/;

/**
 * Gates that stay boolean WITH a stated reason. Each entry names the paired resolver (option 2 above) or the
 * argument for why `false` here cannot silently suppress work.
 */
const ALLOWED_BARE_BOOLEAN: ReadonlyMap<string, string> = new Map([
  [
    "shouldStartAiReviewForAdvisory",
    "Both of its `false` paths are named by the caller, verified end-to-end. (1) The hard-gate path: processors.ts calls resolvePublicAiReviewGateSkipReason on the suppress branch and audits the reason -- that call is #9000's own fix. (2) The reputation-skip path: maybeAddReputationSkipHold pushes a named `ai_review_inconclusive` finding into the advisory before this point is reached. So a `false` here is never silent; the reason simply lives with the caller rather than in the return type.",
  ],
  [
    "shouldRequirePublicAiReviewForAdvisory",
    "Paired with resolvePublicAiReviewGateSkipReason in the same module, which names the reason on the suppress path (processors.ts audits it when aiReviewWillRun is false). The boolean is the hot path; the resolver is only called when it says no.",
  ],
]);

export type DispatchGateViolation = { file: string; gate: string; reason: string };

/**
 * The declaration text from `start` through this function's own body-opening brace, or null if unbalanced.
 *
 * Tracks paren depth to find the END of the parameter list first, because a parameter with an inline object
 * type (`args: { repoFullName: string }`) contains a `{` that is not the body's.
 */
function signatureOf(source: string, start: number): string | null {
  let depth = 0;
  let seenParen = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "(") {
      depth += 1;
      seenParen = true;
    } else if (ch === ")") {
      depth -= 1;
    } else if (ch === "{" && seenParen && depth === 0) {
      return source.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Pure over its inputs. `readFile` is injectable so tests can drive a synthetic offender without touching the
 * tree, matching check-dead-source-files.ts and check-command-redelivery-guards.ts.
 */
export function findDispatchGatesWithoutReasons(
  options: {
    modules?: readonly string[];
    readFile?: (file: string) => string;
    allowedBareBoolean?: ReadonlyMap<string, string>;
  } = {},
): DispatchGateViolation[] {
  const {
    modules = DISPATCH_PATH_MODULES,
    readFile = (file: string) => readFileSync(file, "utf8"),
    allowedBareBoolean = ALLOWED_BARE_BOOLEAN,
  } = options;

  const violations: DispatchGateViolation[] = [];
  for (const file of modules) {
    let source: string;
    try {
      source = readFile(file);
    } catch {
      // A module that does not exist in this checkout is not a violation -- report nothing for it.
      continue;
    }
    for (const match of source.matchAll(GATE_DECLARATION)) {
      const gate = match[1];
      if (gate === undefined || allowedBareBoolean.has(gate)) continue;
      // The signature must end at THIS function's own opening brace. A fixed-width slice reads on into the
      // next declaration, so a reason-returning gate followed by a boolean one inherits its neighbour's
      // `): boolean {` and is wrongly flagged -- the mirror image of the neighbour false-NEGATIVE noted below,
      // and caught by the same fixture tests.
      const signature = signatureOf(source, match.index ?? 0);
      if (signature === null || !BARE_BOOLEAN_RETURN.test(signature)) continue;
      // NOTE: deliberately NOT "does this module contain any resolve*SkipReason". That heuristic was the first
      // shape of this check and it is unsound: one resolver anywhere in a file would exempt every future gate
      // added beside it -- the same "a neighbour satisfies the scan for the one actually missing it" false
      // negative that check-regate-sort-key.ts had to replace brace-bounding for. Pairing must be STATED, per
      // gate, in ALLOWED_BARE_BOOLEAN, naming the resolver.
      violations.push({
        file,
        gate,
        reason: "returns a bare boolean with no paired reason resolver — a `false` here suppresses work with nothing recording why",
      });
    }
  }
  return violations.sort((a, b) => (a.file === b.file ? a.gate.localeCompare(b.gate) : a.file.localeCompare(b.file)));
}

function main(): void {
  const violations = findDispatchGatesWithoutReasons();
  if (violations.length === 0) {
    process.stdout.write("dispatch gate reasons: OK\n");
    return;
  }
  process.stderr.write(`Found ${violations.length} dispatch gate(s) that cannot say why they suppressed work (#9003):\n`);
  for (const violation of violations) {
    process.stderr.write(`  ${violation.file}: ${violation.gate} — ${violation.reason}\n`);
  }
  process.stderr.write(
    "\nA `forceAiReview: true` pass once completed with no fresh review and no audit event explaining why\n" +
      "(#9000); the investigation took hours of elimination. Either:\n\n" +
      "  • return the reason with the decision, as evaluateVisualVisionGate does\n" +
      "      -> { run: false, reason: \"low_reputation\" }\n" +
      "  • or add a paired resolve<X>SkipReason in the same module and audit it on the suppress path,\n" +
      "    as shouldRequirePublicAiReviewForAdvisory does\n\n" +
      "...or, if a `false` here genuinely cannot suppress work, add the gate to ALLOWED_BARE_BOOLEAN in\n" +
      "scripts/check-dispatch-gate-reasons.ts WITH that argument.\n",
  );
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
