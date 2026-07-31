#!/usr/bin/env node
// Escalate a workflow that has failed on CONSECUTIVE runs, once per outage (#10146, generalising #9951).
//
// #9951 built this for the publish workflows after they failed on every single main commit for as far back
// as the run history went -- a one-line missing build step -- while nobody noticed, because the only signal
// was a `::warning::` nobody reads and a red check that looks like release noise.
//
// The identical thing then happened to selfhost.yml. Migration 0209 shipped SQLite-only `AUTOINCREMENT`
// (#10138); the real-Postgres suite caught it correctly on the very first push, and the workflow stayed red
// across five consecutive runs while PRs kept merging, because a post-merge failure blocks nothing and pages
// no one. Two instances of one class is the point at which the mechanism belongs in one place instead of
// being reimplemented per workflow -- which is why this is a script both callers invoke rather than a second
// copy of the bash.
//
// ── A FLAKE AND AN OUTAGE ARE DIFFERENT THINGS ────────────────────────────────────────────────────────────
// A deterministic failure fails identically every time, so a retry buys nothing and a single red run is not
// evidence of one. Consecutive failures at the HEAD of the run history are. Below the threshold this stays
// silent on purpose: an alert that fires on every transient red is the same unread noise in a new place.
//
// ── ONCE PER OUTAGE ───────────────────────────────────────────────────────────────────────────────────────
// An open tracking issue is reused rather than a fresh one filed per commit, for the same reason.
//
// ── A HAND RETRY IS NOT AN OUTAGE (#10234) ────────────────────────────────────────────────────────────────
// The premise above -- "a deterministic failure fails identically every time" -- holds just as well for a
// maintainer retrying a publish before its dependency is live, and only the first of those is an outage
// nobody is watching. #10171 was exactly that: six consecutive publish-miner.yml failures escalated to an
// issue, and every one was a hand `gh workflow run` against main, failing ETARGET on a @loopover/contract
// version that was not published yet. The next run after contract landed succeeded with no code change.
// The workflow was never broken. An alert that fires on the maintainer's own retries is the unread noise
// #9951 built this to escape, just relocated.
//
// ── WHY PROVENANCE HAS TO BE STAMPED ──────────────────────────────────────────────────────────────────────
// The obvious fix -- filter on the run's `event` / `triggering_actor` / `head_branch` -- does not work here,
// and it is worth recording why so it is not attempted again. The reconcile path in mcp-release-please.yml
// (`dispatch_and_wait`) issues a BARE `gh workflow run "$workflow"`: no `--ref`, no inputs, under a PAT. So
// its runs land as `workflow_dispatch` / `main` / the PAT owner -- the identical triple a laptop produces.
// Verified live: publish-miner run #484 (`30637452300`), which the reconcile job's own log shows it
// dispatched, is indistinguishable on every one of those fields from the six manual #10171 failures. And
// `GET /actions/runs/:id` carries no `inputs` key, so a dispatch input cannot be read back either.
//
// `run-name:` IS rendered into `display_title`, which the runs API does return -- the same trick
// visual-capture-fallback.yml already uses to correlate a dispatch back to its PR. So the publish workflows
// stamp AUTOMATION_RUN_NAME_MARKER into their run name when the automation dispatches them, and the streak
// below counts only runs carrying it.

import { execFileSync } from "node:child_process";

/**
 * The marker the publish workflows render into `run-name:` when the release automation dispatches them,
 * and which `isAutomationDispatched` reads back out of `display_title`.
 *
 * Changing this string is a two-sided edit -- every `.github/workflows/publish-*.yml` `run-name:` must
 * change with it, or every automated run silently reads as manual and the escalation goes permanently
 * quiet. scripts/check-dispatch-provenance-stamped.ts fails the build if the two sides drift apart.
 */
export const AUTOMATION_RUN_NAME_MARKER = "[automated]";

/** The fields of a workflow run this script reads. Mirrors the GitHub runs API's own names. */
export type WorkflowRunSummary = {
  readonly conclusion: string | null | undefined;
  readonly event: string | null | undefined;
  readonly displayTitle: string | null | undefined;
};

/**
 * PURE. Was this run started by automation rather than by a human at a terminal?
 *
 * Only `workflow_dispatch` is ambiguous. Every other trigger -- `push` (selfhost.yml), `schedule`,
 * `workflow_run` -- is automation by construction, so it counts exactly as it did before #10234; that is
 * what keeps this change from silently narrowing the selfhost.yml caller it also serves.
 *
 * The default for an unrecognised dispatch is therefore "manual", i.e. EXCLUDED. That is the deliberate
 * direction: a maintainer's own failed dispatch is already visible to the maintainer who ran it, so
 * dropping it costs nothing, while counting it re-creates #10171.
 */
export function isAutomationDispatched(run: WorkflowRunSummary): boolean {
  if (run.event !== "workflow_dispatch") return true;
  return (run.displayTitle ?? "").includes(AUTOMATION_RUN_NAME_MARKER);
}

/**
 * PURE. How many AUTOMATION-dispatched runs at the head of the history did NOT succeed.
 *
 * `runs` is newest-first, as the GitHub API returns it. Manual dispatches are dropped entirely rather than
 * merely "not resetting" the streak -- excluding is the safer of the two, since a run nobody automated is
 * not evidence about the automated path in either direction.
 *
 * A window with no success anywhere means the whole window is bad -- that is the standing-outage case, and
 * reporting `length` rather than 0 is what makes it escalate instead of silently reading as healthy. That
 * distinction is the entire point: the naive `indexOf("success")` returns -1 there, and -1 treated as a
 * count would report "no failures" for the worst possible state. Note this now applies to the FILTERED
 * list, so a history of nothing but manual runs correctly reports 0 rather than its full length.
 */
export function leadingNonSuccessCount(runs: readonly WorkflowRunSummary[]): number {
  const automated = runs.filter(isAutomationDispatched);
  const firstSuccess = automated.findIndex((run) => run.conclusion === "success");
  return firstSuccess === -1 ? automated.length : firstSuccess;
}

/** The tracking issue's title for a workflow. Stable, and derived from the workflow file name, so the
 *  reuse-an-open-issue lookup below can find the one this outage already filed. */
export function outageIssueTitle(workflow: string): string {
  return `workflow outage: ${workflow} has failed on consecutive runs`;
}

function gh(args: readonly string[]): string {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function outageBody(workflow: string, streak: number, threshold: number): string {
  return [
    `\`${workflow}\` has failed on **${streak} consecutive automation-dispatched runs**.`,
    "",
    "That is no longer a flake being retried -- a deterministic failure fails identically every time, so this",
    "has been broken for that entire stretch and every run since the first one was already telling us so.",
    "",
    "Manually-dispatched runs are excluded from this count (#10234), so this is not a maintainer's own retries.",
    "",
    "Check the most recent run's logs, fix the cause, and close this issue. It is re-filed automatically only",
    `if the failure streak reaches ${threshold} again after a success.`,
    "",
    "Filed automatically by scripts/escalate-workflow-outage.ts (#10146).",
  ].join("\n");
}

function parseArg(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    if (fallback !== undefined) return fallback;
    console.error(`escalate-workflow-outage: --${name} is required`);
    process.exit(2);
  }
  return value;
}

function main(): void {
  const workflow = parseArg("workflow");
  const threshold = Number(parseArg("threshold", "3"));
  const repo = process.env.GITHUB_REPOSITORY ?? "";
  if (!repo) {
    console.error("escalate-workflow-outage: GITHUB_REPOSITORY is not set");
    process.exit(2);
  }

  let runs: WorkflowRunSummary[] = [];
  try {
    runs = JSON.parse(
      gh([
        "api",
        `repos/${repo}/actions/workflows/${workflow}/runs?per_page=10&status=completed`,
        "--jq",
        // `display_title` is where `run-name:` lands, and it is the only field that recovers dispatch
        // provenance -- see the header. Renamed to camelCase here so WorkflowRunSummary stays idiomatic.
        "[.workflow_runs[] | {conclusion, event, displayTitle: .display_title}]",
      ]),
    ) as WorkflowRunSummary[];
  } catch (error) {
    // Never fail the caller over the ALERTING path -- the workflow this runs in has already failed, and
    // turning "could not check the streak" into a second red is pure noise on top of the real problem.
    console.warn(`::warning::escalate-workflow-outage: could not read run history for ${workflow}: ${String(error)}`);
    return;
  }

  const streak = leadingNonSuccessCount(runs);
  if (streak < threshold) {
    console.log(`${workflow}: ${streak} consecutive automated failure(s) -- below the ${threshold}-run escalation threshold, treating as transient.`);
    return;
  }

  const title = outageIssueTitle(workflow);
  try {
    const existing = gh(["issue", "list", "--repo", repo, "--state", "open", "--search", `${title} in:title`, "--json", "number", "--jq", ".[0].number // empty"]);
    if (existing) {
      console.log(`${workflow}: standing outage already tracked in #${existing} -- not filing a duplicate.`);
      return;
    }
    gh(["issue", "create", "--repo", repo, "--title", title, "--label", "maintainer-only", "--body", outageBody(workflow, streak, threshold)]);
    console.log(`::error::${workflow} has failed ${streak} consecutive runs -- standing outage filed.`);
  } catch (error) {
    console.warn(`::warning::${workflow} standing outage detected but the tracking issue could not be filed: ${String(error)}`);
  }
}

// Only run when invoked directly, so the pure helpers above stay importable by tests.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
