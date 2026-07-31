// The dispatch-provenance stamp is a TWO-SIDED string, and both sides fail silently (#10234).
//
// scripts/escalate-workflow-outage.ts decides "was this run automated?" by looking for
// AUTOMATION_RUN_NAME_MARKER in the run's `display_title`. The publish workflows put it there via
// `run-name:`. Nothing at runtime notices when those two drift apart -- the escalation simply reads every
// automated run as manual, filters them all out, and goes permanently quiet. The alert would still be
// green, still be "wired", and would never fire again.
//
// That is the same shape as #9860's checkers-that-guard-nothing: a mechanism whose presence is read as
// coverage while it covers nothing. So the lockstep is asserted mechanically here rather than left to
// whoever next edits a `run-name:` remembering an unwritten obligation.
//
// Three invariants, each one a real way to break it:
//
//   1. A workflow declaring the provenance input MUST stamp the marker into `run-name:`.
//      Breaks by: editing or deleting the run-name, or renaming the marker on the script side only.
//   2. That `run-name:` MUST be conditional on the input. An unconditional marker stamps EVERY run,
//      including a human's, which restores the exact #10171 false alarm this all exists to remove.
//   3. Every dispatch site targeting such a workflow MUST pass the flag. Breaks by: adding a new
//      `gh workflow run` and not knowing the flag exists -- those runs then read as manual.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { AUTOMATION_RUN_NAME_MARKER } from "./escalate-workflow-outage";

const WORKFLOWS_DIR = ".github/workflows";

/** The `workflow_dispatch` input carrying provenance. Must match what mcp-release-please.yml passes. */
export const PROVENANCE_INPUT = "dispatched_by_automation";

/** True when this workflow declares the provenance input, i.e. it opts in to being stamped. */
export function declaresProvenanceInput(text: string): boolean {
  return new RegExp(`^\\s+${PROVENANCE_INPUT}:\\s*$`, "m").test(text);
}

/** The top-level `run-name:` value, or undefined when the workflow has none. */
export function runNameValue(text: string): string | undefined {
  return /^run-name:[ \t]*(.+)$/m.exec(text)?.[1]?.trim();
}

/**
 * PURE. Everything wrong with one workflow's stamp. Empty for a workflow that does not opt in, so this
 * stays silent about push-triggered workflows (selfhost.yml) that have no dispatch ambiguity to resolve.
 */
export function stampProblems(text: string, marker: string): string[] {
  if (!declaresProvenanceInput(text)) return [];
  const runName = runNameValue(text);
  if (runName === undefined) {
    return [`declares the \`${PROVENANCE_INPUT}\` input but has no top-level \`run-name:\`, so nothing reaches \`display_title\` and every run reads as manual`];
  }
  const problems: string[] = [];
  if (!runName.includes(marker)) {
    problems.push(`\`run-name:\` does not contain \`${marker}\`, the marker escalate-workflow-outage.ts searches \`display_title\` for`);
  }
  if (!runName.includes(`inputs.${PROVENANCE_INPUT}`)) {
    problems.push(`\`run-name:\` does not branch on \`inputs.${PROVENANCE_INPUT}\`, so a HUMAN dispatch would be stamped as automated too`);
  }
  return problems;
}

/**
 * PURE. Dispatch sites in `text` that target a provenance-stamped workflow without passing the flag.
 *
 * A `$`-bearing target is a shell variable the reconcile path resolves at runtime (`gh workflow run
 * "$workflow"`), so it cannot be matched against `provenanceWorkflows` statically and is required to pass
 * the flag unconditionally. That is deliberate: the reconcile path is the ONE that calls the escalation,
 * and an unstamped dispatch there is precisely the blind spot this file exists to prevent.
 */
export function dispatchesMissingFlag(text: string, provenanceWorkflows: ReadonlySet<string>): string[] {
  const missing: string[] = [];
  for (const line of text.split("\n")) {
    // Prose in these files discusses `gh workflow run` at length; a commented mention is not a dispatch.
    if (line.trim().startsWith("#")) continue;
    const match = /gh workflow run[ \t]+(\S+)(.*)$/.exec(line);
    if (match === null) continue;
    const target = match[1]!.replace(/^["']|["']$/g, "");
    const isRuntimeTarget = target.includes("$");
    if (!isRuntimeTarget && !provenanceWorkflows.has(target)) continue;
    if (!match[2]!.includes(`-f ${PROVENANCE_INPUT}=true`)) missing.push(target);
  }
  return missing;
}

function main(): void {
  const files = readdirSync(WORKFLOWS_DIR).filter((entry) => entry.endsWith(".yml") || entry.endsWith(".yaml"));
  const texts = new Map(files.map((file) => [file, readFileSync(join(WORKFLOWS_DIR, file), "utf8")]));
  const stamped = new Set([...texts].filter(([, text]) => declaresProvenanceInput(text)).map(([file]) => file));

  const failures: string[] = [];
  for (const [file, text] of texts) {
    for (const problem of stampProblems(text, AUTOMATION_RUN_NAME_MARKER)) {
      failures.push(`${WORKFLOWS_DIR}/${file}: ${problem}`);
    }
    for (const target of dispatchesMissingFlag(text, stamped)) {
      failures.push(`${WORKFLOWS_DIR}/${file}: dispatches \`${target}\` without \`-f ${PROVENANCE_INPUT}=true\`, so those runs read as a hand retry and are excluded from the outage streak`);
    }
  }

  if (failures.length > 0) {
    console.error(`check-dispatch-provenance-stamped: ${failures.length} problem(s) — the outage escalation would silently stop seeing automated runs (#10234):\n`);
    for (const failure of failures) console.error(`  ${failure}`);
    console.error(
      [
        "",
        `The marker is \`${AUTOMATION_RUN_NAME_MARKER}\`, exported as AUTOMATION_RUN_NAME_MARKER from scripts/escalate-workflow-outage.ts.`,
        "Both sides must move together:",
        `  • workflow — \`run-name: "<Name>\${{ inputs.${PROVENANCE_INPUT} && ' ${AUTOMATION_RUN_NAME_MARKER}' || '' }}"\``,
        `  • dispatch — pass \`-f ${PROVENANCE_INPUT}=true\` from every automated \`gh workflow run\``,
      ].join("\n"),
    );
    process.exit(1);
  }

  console.log(`check-dispatch-provenance-stamped: ${stamped.size} workflow(s) stamp dispatch provenance, and every automated dispatch passes the flag.`);
}

if (process.argv[1]?.endsWith("check-dispatch-provenance-stamped.ts")) main();
