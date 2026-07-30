#!/usr/bin/env node
// #9724: turn one or more `loopover-verify --json` reports into the nightly job's verdict and, when something
// is wrong, the body of the tracking issue a maintainer will actually have to act on.
//
// WHY THIS IS A SCRIPT AND NOT INLINE BASH. The interesting logic here is a judgement -- which claims count as
// a regression, and what a reader needs in order to fix it -- and that judgement is exactly the part that must
// not be discovered to be wrong on the night it first fires. As a pure function it is unit-tested against real
// report shapes, including the shapes that must NOT open an issue.
//
// SKIP IS NOT FAILURE, AND IS NOT SUCCESS EITHER. `loopover-verify` reports a surface it could not obtain as
// `skip`, and the verifier's own header is emphatic that collapsing "could not check" into "checked, fine" is
// how you build a monitor that always says green. So skips never open an issue -- a deployment legitimately
// serves no corpus for a rule, and the public API's ledger is empty BY DESIGN (#9940), which is a permanent,
// expected skip -- but they are always reported in the body, because "we verified nothing at all tonight" is
// something a maintainer reading a green run deserves to see.

import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

/** One claim as `loopover-verify --json` emits it. Structural, matching the verifier's own reasoning about
 *  older deployments: the nightly must be able to parse a report from a CLI version it does not control. */
export type VerifyClaim = {
  id?: unknown;
  claim?: unknown;
  status?: unknown;
  detail?: unknown;
};

export type VerifyRun = {
  /** Human label for the surface, e.g. "public API". Appears in the issue body and the job log. */
  label: string;
  baseUrl: string;
  /** The CLI's exit code. Non-zero with no failing claim means the tool itself broke -- see below. */
  exitCode: number;
  /** Parsed `--json` payload, or null when the CLI produced nothing parseable. */
  report: { results?: unknown } | null;
};

export type ClaimLine = { surface: string; status: string; claim: string; detail: string };

export type VerificationReport = {
  ok: boolean;
  failures: ClaimLine[];
  skips: ClaimLine[];
  passes: ClaimLine[];
  title: string;
  body: string;
};

const str = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);

/** PURE. Flatten one run's claims into labelled lines. A report whose `results` is absent or not an array
 *  yields nothing here; {@link buildVerificationReport} turns that into its own failure rather than letting an
 *  unreadable report read as "no failures". */
export function claimLinesFor(run: VerifyRun): ClaimLine[] {
  const results = run.report?.results;
  if (!Array.isArray(results)) return [];
  return results.map((entry) => {
    const claim = entry as VerifyClaim;
    return {
      surface: run.label,
      status: str(claim.status, "unknown").toLowerCase(),
      claim: str(claim.claim, str(claim.id, "(unnamed claim)")),
      detail: str(claim.detail, "(no detail published)"),
    };
  });
}

/**
 * PURE. Decide whether the public verification path is healthy, and write the issue body if it is not.
 *
 * Four independent things count as broken, and every one after the first is a case that would otherwise
 * present as a silent green:
 *
 *   1. any claim the verifier reports as `fail`;
 *   2. a run that produced NO readable report at all (the CLI crashed, the JSON was malformed, npx could not
 *      resolve the package). Nothing failed, because nothing ran -- which is a regression in the published
 *      verification path itself, precisely what this job exists to notice;
 *   3. a non-zero exit code with no failing claim to explain it. The tool is telling us something went wrong
 *      in a way its own claim list does not describe, and trusting the empty claim list over the exit code
 *      would be choosing the more comfortable of two contradictory signals;
 *   4. a run in which NOTHING PASSED. This is the one that matters most, and it was found by pointing the real
 *      verifier at a deliberately wrong base URL: every claim came back `skip` ("/v1/public/eval-scores
 *      unavailable (HTTP 404)") and the CLI exited 0. Judged claim-by-claim that is four legitimate skips and
 *      a clean exit -- so the monitor would have reported GREEN against a completely dead endpoint, which is
 *      the exact failure this job exists to prevent.
 *
 *      The verifier is right to call them skips: from inside a single claim, "this surface is disabled" and
 *      "this host is wrong" are indistinguishable. The MONITOR has the context the claim lacks -- production is
 *      supposed to be serving these -- so requiring at least one positively verified claim per surface is a
 *      judgement that belongs here rather than in the CLI.
 *
 *      The floor is one, not a proportion, because the two surfaces are legitimately lopsided and both must
 *      clear it with room to spare (measured against production): `api.loopover.ai` passes record-digests,
 *      corpus-commitments and stats-parity while skipping anchor-checkpoint (its ledger is empty BY DESIGN,
 *      #9940), and `shots.loopover.ai` passes anchor-checkpoint while skipping the other three (it does not
 *      publish stats). A threshold like "most claims pass" would fail the Orb on a healthy night.
 */
export function buildVerificationReport(runs: readonly VerifyRun[]): VerificationReport {
  const all = runs.flatMap(claimLinesFor);
  const failures = all.filter((line) => line.status === "fail");
  const skips = all.filter((line) => line.status === "skip");
  const passes = all.filter((line) => line.status === "pass");

  const brokenRuns = runs.filter((run) => run.report === null || !Array.isArray(run.report.results));
  const unexplained = runs.filter(
    (run) => run.exitCode !== 0 && !brokenRuns.includes(run) && !claimLinesFor(run).some((line) => line.status === "fail"),
  );
  // Case 4. Only for runs that produced a readable report -- a broken run is already reported as such, and
  // saying "and also nothing passed" about it would be two findings for one cause.
  const verifiedNothing = runs.filter((run) => !brokenRuns.includes(run) && !claimLinesFor(run).some((line) => line.status === "pass"));

  const ok = failures.length === 0 && brokenRuns.length === 0 && unexplained.length === 0 && verifiedNothing.length === 0;
  const title = TRACKING_ISSUE_TITLE;
  if (ok) {
    return { ok, failures, skips, passes, title, body: "" };
  }

  const lines: string[] = [
    "The nightly anonymous verification run failed. These are LoopOver's own published claims, checked the way",
    "an outsider checks them: the verifier published on npm, run against production, with no credentials of any",
    "kind. A failure here means a stranger following the walkthrough right now gets the same result.",
    "",
  ];

  for (const run of brokenRuns) {
    lines.push(`### ${run.label} — the verifier produced no readable report`, "");
    lines.push(
      `\`${run.baseUrl}\` exited ${run.exitCode} without emitting parseable \`--json\` output. Nothing was checked, which`,
      "is itself the regression: the published verification path did not run. Check the job log for the raw output.",
      "",
    );
  }

  for (const run of unexplained) {
    lines.push(`### ${run.label} — non-zero exit with no failing claim`, "");
    lines.push(
      `\`${run.baseUrl}\` exited ${run.exitCode} but reported no \`fail\` claim. The tool is signalling a problem its own`,
      "claim list does not describe; the exit code is the signal to trust here, not the empty list.",
      "",
    );
  }

  for (const run of verifiedNothing) {
    lines.push(`### ${run.label} — nothing was verified`, "");
    lines.push(
      `Every claim against \`${run.baseUrl}\` came back skipped, so not one published commitment was actually`,
      "recomputed. The most common cause is that the surface is not reachable at that host at all -- a wrong or",
      "renamed base URL returns 404 for every endpoint, which the verifier reports claim-by-claim as \"unavailable\"",
      "and exits 0. A healthy surface always positively verifies at least one claim.",
      "",
    );
  }

  if (failures.length > 0) {
    lines.push("### Failing claims", "");
    lines.push("| Surface | Claim | Detail |", "| --- | --- | --- |");
    for (const line of failures) lines.push(`| ${line.surface} | ${escapeCell(line.claim)} | ${escapeCell(line.detail)} |`);
    lines.push("");
  }

  if (skips.length > 0) {
    // Reported, never counted. A permanent skip is expected (the public API's ledger is empty by design), but a
    // NEW one next to a failure is often the actual cause, so it has to be visible in the same body.
    lines.push("### Skipped (not counted as failures)", "");
    lines.push("| Surface | Claim | Detail |", "| --- | --- | --- |");
    for (const line of skips) lines.push(`| ${line.surface} | ${escapeCell(line.claim)} | ${escapeCell(line.detail)} |`);
    lines.push("");
  }

  lines.push("### Reproduce", "");
  lines.push("```bash");
  for (const run of runs) lines.push(`npx -p @loopover/mcp loopover-verify --base-url ${run.baseUrl}`);
  lines.push("```", "");
  lines.push(
    "This issue is updated in place while the failure persists and closed automatically by the next green run,",
    "so it never needs manual triage to stay accurate. Filed by `.github/workflows/verify-public-claims.yml` (#9724).",
  );

  return { ok, failures, skips, passes, title, body: lines.join("\n") };
}

/** The single tracking issue's title. A CONSTANT, not templated with a date or a claim name: the workflow finds
 *  the existing issue by exact title, and anything varying per run would file a new issue every night instead of
 *  updating one. */
export const TRACKING_ISSUE_TITLE = "verifiability: the nightly anonymous verification run is failing";

/** Markdown table cells cannot contain a raw pipe or newline; verifier details legitimately contain both. */
export function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** PURE. The one-line job summary, printed whether or not anything failed. */
export function summarize(report: VerificationReport): string {
  return `${report.passes.length} passed, ${report.failures.length} failed, ${report.skips.length} skipped`;
}

/** Parse one run from the CLI's stdout. Never throws: unparseable output IS a result (see case 2 above). */
export function parseRun(label: string, baseUrl: string, exitCode: number, stdout: string): VerifyRun {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (parsed === null || typeof parsed !== "object") return { label, baseUrl, exitCode, report: null };
    return { label, baseUrl, exitCode, report: parsed as { results?: unknown } };
  } catch {
    return { label, baseUrl, exitCode, report: null };
  }
}

/** The heredoc delimiter for the multi-line `body` output. GitHub requires a delimiter that does not occur in
 *  the value; this one is long and structured enough that verifier prose cannot collide with it, and
 *  {@link renderGithubOutput} asserts that rather than assuming it. */
export const OUTPUT_DELIMITER = "VERIFY_BODY_EOF_9d3f1c";

/**
 * PURE. The exact bytes to append to `$GITHUB_OUTPUT`.
 *
 * Built here, as one string, rather than by the workflow shell echoing around the script's stdout. That shape
 * was subtly broken: the script appending its own scalars while the shell wrapped its stdout in a heredoc
 * interleaves the two writers, and `VERIFY_OK=` lands INSIDE the body block -- leaving the workflow reading an
 * empty verdict and, because an empty string is not `"true"`, filing an outage issue on a healthy night.
 */
export function renderGithubOutput(report: VerificationReport): string {
  if (report.body.includes(OUTPUT_DELIMITER)) {
    // Unreachable with the delimiter above, but an unguarded heredoc is an output-injection primitive: a body
    // containing the delimiter would terminate the block early and let the rest be parsed as more outputs.
    throw new Error("verification body contains the output delimiter");
  }
  return [`VERIFY_OK=${report.ok ? "true" : "false"}`, `VERIFY_SUMMARY=${summarize(report)}`, `body<<${OUTPUT_DELIMITER}`, report.body, OUTPUT_DELIMITER, ""].join("\n");
}

/** PURE. Parse the CLI's positional arguments into runs. Four per surface. */
export function parseArgs(argv: readonly string[], readFile: (path: string) => string): VerifyRun[] {
  const runs: VerifyRun[] = [];
  for (let index = 0; index < argv.length; index += 4) {
    const label = argv[index] ?? "";
    const baseUrl = argv[index + 1] ?? "";
    const exitCode = Number.parseInt(argv[index + 2] ?? "", 10);
    const file = argv[index + 3] ?? "";
    let stdout = "";
    try {
      stdout = readFile(file);
    } catch {
      // An unreadable capture file is the same finding as unparseable output: nothing was verified.
    }
    // A non-numeric exit code is treated as a failure rather than a zero -- "we could not tell how it exited"
    // must never be the optimistic branch.
    runs.push(parseRun(label, baseUrl, Number.isFinite(exitCode) ? exitCode : 1, stdout));
  }
  return runs;
}

/** CLI: `verify-public-claims-report.ts <label> <baseUrl> <exitCode> <stdoutFile> [...]`, four arguments per
 *  run. Appends the structured outputs via `writeOutput` and logs a human summary to stdout. */
export function runCli(argv: readonly string[], writeOutput: (chunk: string) => void, readFile: (path: string) => string = (path) => readFileSync(path, "utf8")): number {
  if (argv.length === 0 || argv.length % 4 !== 0) {
    process.stderr.write("usage: verify-public-claims-report <label> <baseUrl> <exitCode> <stdoutFile> [...]\n");
    return 2;
  }
  const report = buildVerificationReport(parseArgs(argv, readFile));
  writeOutput(renderGithubOutput(report));
  process.stdout.write(`${summarize(report)}\n`);
  if (!report.ok) process.stdout.write(`\n${report.body}\n`);
  // Always 0 on a produced verdict: the workflow reads VERIFY_OK and decides. A non-zero exit here would abort
  // the step that has to go on to file or close the tracking issue -- the job's actual deliverable.
  return 0;
}

/* v8 ignore start -- the self-execution guard; every branch above is driven directly in tests. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputPath = process.env["GITHUB_OUTPUT"];
  const { appendFileSync } = await import("node:fs");
  const code = runCli(process.argv.slice(2), (chunk) => {
    if (outputPath) appendFileSync(outputPath, chunk);
    else process.stderr.write(chunk);
  });
  process.exit(code);
}
/* v8 ignore stop */
