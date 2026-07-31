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

import { execFileSync } from "node:child_process";

/**
 * PURE. How many runs at the head of the history did NOT succeed.
 *
 * `runs` is newest-first, as the GitHub API returns it. A window with no success anywhere means the whole
 * window is bad -- that is the standing-outage case, and reporting `length` rather than 0 is what makes it
 * escalate instead of silently reading as healthy. That distinction is the entire point: the naive
 * `indexOf("success")` returns -1 there, and -1 treated as a count would report "no failures" for the worst
 * possible state.
 */
export function leadingNonSuccessCount(runs: readonly (string | null | undefined)[]): number {
  const firstSuccess = runs.findIndex((conclusion) => conclusion === "success");
  return firstSuccess === -1 ? runs.length : firstSuccess;
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
    `\`${workflow}\` has failed on **${streak} consecutive runs**.`,
    "",
    "That is no longer a flake being retried -- a deterministic failure fails identically every time, so this",
    "has been broken for that entire stretch and every run since the first one was already telling us so.",
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

  let conclusions: (string | null)[] = [];
  try {
    conclusions = JSON.parse(
      gh(["api", `repos/${repo}/actions/workflows/${workflow}/runs?per_page=10&status=completed`, "--jq", "[.workflow_runs[].conclusion]"]),
    ) as (string | null)[];
  } catch (error) {
    // Never fail the caller over the ALERTING path -- the workflow this runs in has already failed, and
    // turning "could not check the streak" into a second red is pure noise on top of the real problem.
    console.warn(`::warning::escalate-workflow-outage: could not read run history for ${workflow}: ${String(error)}`);
    return;
  }

  const streak = leadingNonSuccessCount(conclusions);
  if (streak < threshold) {
    console.log(`${workflow}: ${streak} consecutive failure(s) -- below the ${threshold}-run escalation threshold, treating as transient.`);
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
