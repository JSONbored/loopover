#!/usr/bin/env node
// #10227: the verdict-stability backoff (#10184) must guard the verdict DERIVATION, not a pass entry point.
//
// The bug class this closes, stated once. #10204 put the skip at the entry of the whole publish-and-maintain
// pass, so it suppressed everything the pass OWED -- bounded retry chains, one-shot markers, budgets -- and
// not just the redundant re-derivation. Each bounded retry then needed an entry in an `explicitlyRequested`
// allowlist, and a chain that forgot to join it was silently truncated the day it shipped. It is the shape of
// rule whose correctness depends on every future author remembering an unwritten obligation, and the repo has
// been burned by that shape enough times (#9860, #10061) to stop trusting it.
//
// The redesign removes the obligation instead of documenting it: one guard, at the single point a pass derives
// a verdict, with everything the pass owes running above it. A new retry chain is then safe BY CONSTRUCTION.
// That guarantee is only worth anything while the structure holds, so this checks the structure:
//
//   1. ONE call site. The guard is a choke point or it is nothing; two call sites means it is a per-entry-point
//      rule again, and the second one will drift.
//   2. That call site is inside maybePublishPrPublicSurface -- the function both entry points reach a verdict
//      through.
//   3. It sits ABOVE the derivation it is meant to skip (the pending gate check-run and the gate evaluation).
//      A guard that drifts below them still compiles, still passes every behavioural test that only asserts
//      "backed off", and saves nothing.
//   4. Every publish-and-maintain entry point routes through it: a function that runs maybeRunAgentMaintenance
//      must get its gate from maybePublishPrPublicSurface. This is the one the issue asked for -- a NEW entry
//      point that derives a verdict some other way bypasses the choke point, and nothing else would notice.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PROCESSORS = "src/queue/processors.ts";

/** The guard, the function that must contain it, and the two derivation steps it must precede. */
const GUARD_CALL = "await stableVerdictBackoffEngaged(env, {";
const CHOKE_POINT_FUNCTION = "maybePublishPrPublicSurface";
const DERIVATION_MARKERS = ["createOrUpdatePendingGateCheckRun(", "gateEvaluation = await withReviewPipelineSpan("] as const;

/** The call that makes a function a publish-and-maintain entry point, and the call that must accompany it. */
const MAINTENANCE_CALL = "maybeRunAgentMaintenance(env, {";
const PUBLISH_CALL = "maybePublishPrPublicSurface(";

export type Violation = { rule: string; detail: string };

/** Byte offsets of every occurrence of `needle` in `source`. */
export function occurrences(source: string, needle: string): number[] {
  const found: number[] = [];
  for (let at = source.indexOf(needle); at !== -1; at = source.indexOf(needle, at + 1)) found.push(at);
  return found;
}

/**
 * The `[start, end)` byte range of the top-level function named `name`.
 *
 * Deliberately brace-free: it runs from the declaration to the next TOP-LEVEL declaration, which is what
 * "column 0" identifies unambiguously in this file's formatting. A brace counter would have to understand
 * strings, regex literals and template literals to be correct over a 13k-line file, and being subtly wrong
 * about the range is worse here than not checking, because a checker that cries wolf gets muted.
 */
export function topLevelFunctionRange(source: string, name: string): { start: number; end: number } | null {
  const declaration = source.indexOf(`\nasync function ${name}(`);
  if (declaration === -1) return null;
  const start = declaration + 1;
  const next = source.slice(start + 1).search(/\n(?:export )?(?:async )?function /);
  return { start, end: next === -1 ? source.length : start + 1 + next };
}

/**
 * The enclosing top-level function for a byte offset: the last `function` declaration at column 0 before it.
 * Used to answer "which entry point is this maybeRunAgentMaintenance call in", so a caller's own body -- not
 * the whole file -- is what gets searched for the matching publish call.
 */
export function enclosingFunction(source: string, offset: number): { name: string; start: number } | null {
  const before = source.slice(0, offset);
  const matches = [...before.matchAll(/\n(?:export )?(?:async )?function (\w+)\(/g)];
  const last = matches.at(-1);
  if (!last || last[1] === undefined || last.index === undefined) return null;
  return { name: last[1], start: last.index + 1 };
}

/** Every violation of the four rules above, in the order they are numbered. */
export function findViolations(source: string): Violation[] {
  const violations: Violation[] = [];
  const guards = occurrences(source, GUARD_CALL);

  if (guards.length !== 1) {
    violations.push({
      rule: "one call site",
      detail: `stableVerdictBackoffEngaged is called ${guards.length} time(s); the choke point is exactly one.`,
    });
    // Rules 2 and 3 are about THE call site, so they cannot be evaluated without one.
    if (guards.length === 0) return violations;
  }

  const chokePoint = topLevelFunctionRange(source, CHOKE_POINT_FUNCTION);
  if (chokePoint === null) {
    violations.push({ rule: "choke point exists", detail: `${CHOKE_POINT_FUNCTION} was renamed or removed; this checker needs updating with it.` });
    return violations;
  }

  const guard = guards[0]!;
  if (guard < chokePoint.start || guard >= chokePoint.end) {
    violations.push({ rule: "guard is inside the choke point", detail: `the guard is outside ${CHOKE_POINT_FUNCTION}, so it is guarding a pass entry again.` });
  } else {
    for (const marker of DERIVATION_MARKERS) {
      const derivation = source.indexOf(marker, chokePoint.start);
      if (derivation !== -1 && derivation < chokePoint.end && derivation < guard) {
        violations.push({ rule: "guard precedes the derivation", detail: `\`${marker}\` runs BEFORE the guard, so a backed-off pass still pays for it.` });
      }
    }
  }

  for (const call of occurrences(source, MAINTENANCE_CALL)) {
    const entry = enclosingFunction(source, call);
    if (entry === null) continue;
    if (!source.slice(entry.start, call).includes(PUBLISH_CALL)) {
      violations.push({
        rule: "entry points route through the choke point",
        detail: `${entry.name} runs the maintenance pass without deriving its gate through ${CHOKE_POINT_FUNCTION}, so it bypasses the backoff.`,
      });
    }
  }

  return violations;
}

function main(): void {
  const violations = findViolations(readFileSync(PROCESSORS, "utf8"));
  if (violations.length === 0) {
    console.log("check-verdict-backoff-chokepoint: the verdict-stability backoff guards exactly one derivation choke point.");
    return;
  }
  process.stderr.write(`check-verdict-backoff-chokepoint: ${violations.length} violation(s) of the #10227 choke-point invariant in ${PROCESSORS}:\n\n`);
  for (const violation of violations) process.stderr.write(`  [${violation.rule}] ${violation.detail}\n`);
  process.stderr.write(
    "\nThe backoff must guard the point a pass DERIVES a verdict, not the entry of a pass. Guarding an entry\n" +
      "suppresses everything the pass owed -- bounded retry chains, one-shot markers, budgets -- and then every\n" +
      "one of them needs an exemption it has to remember to ask for (#10204 truncated #10061's recapture chain\n" +
      "from 5 attempts to 3 exactly this way). Put the work a pass OWES above the guard, and the verdict\n" +
      "derivation below it, and no future chain needs to know the guard exists.\n",
  );
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
