#!/usr/bin/env node
// Reports p50/p95 wall-clock duration and failure rate for the ci.yml workflow over a trailing
// window, split by trigger (push vs pull_request) since they run different amounts of work (a push
// to main always runs the full unscoped suite; a PR can hit scoped test selection). Nothing currently
// tracks whether CI is trending slower over time -- this closes that blind spot without touching
// ci.yml itself. Duration is measured as updated_at - created_at (the run's real wall-clock span,
// including queue time), not the sum of individual job durations.

import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

async function fetchAllRuns(repo, token, sinceIso) {
  const runs = [];
  let page = 1;
  for (;;) {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/ci.yml/runs?status=completed&created=>=${sinceIso}&per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!response.ok) {
      throw new Error(`GitHub API error ${response.status}: ${await response.text()}`);
    }
    const body = await response.json();
    runs.push(...body.workflow_runs);
    if (body.workflow_runs.length < 100) break;
    page += 1;
    if (page > 20) break; // hard stop -- ~2000 runs is far more than a 7-day window should ever return
  }
  return runs;
}

export function durationSeconds(run) {
  return (new Date(run.updated_at).getTime() - new Date(run.created_at).getTime()) / 1000;
}

export function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  const index = Math.min(sortedValues.length - 1, Math.ceil((p / 100) * sortedValues.length) - 1);
  return sortedValues[Math.max(0, index)];
}

export function summarize(allRuns) {
  // "cancelled" excluded entirely, not just from the failure count: this workflow's own
  // cancel-in-progress concurrency setting means a cancelled run is almost always a rapid re-push
  // superseding its predecessor mid-run, not CI breaking -- counting it as a failure (or even as a
  // completed run for duration purposes, since it stopped partway through) would misrepresent both
  // metrics. "skipped" is real (a path-filtered job counting as success) and stays in the success side.
  const runs = allRuns.filter((r) => r.conclusion !== "cancelled");
  const durations = runs.map(durationSeconds).sort((a, b) => a - b);
  const failures = runs.filter((r) => r.conclusion !== "success" && r.conclusion !== "skipped").length;
  return {
    count: runs.length,
    excludedCancelled: allRuns.length - runs.length,
    p50Seconds: percentile(durations, 50),
    p95Seconds: percentile(durations, 95),
    failureRate: runs.length > 0 ? failures / runs.length : null,
    failures,
  };
}

// Entrypoint guard (#7456): the pure percentile/summarize/durationSeconds logic above is importable for
// tests without this driving code -- which reads required env, makes a live GitHub API call, and writes
// output -- ever running. Only executes when the file is invoked directly as a script.
async function main() {
  const WINDOW_DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.split("=")[1] ?? 7);
  const outputArg = process.argv.find((a) => a.startsWith("--output="));
  const OUTPUT_PATH = outputArg ? outputArg.split("=")[1] : null;

  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error("GITHUB_REPOSITORY is required");
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required");

  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const runs = await fetchAllRuns(repo, token, since);

  const report = {
    windowDays: WINDOW_DAYS,
    generatedAt: new Date().toISOString(),
    push: summarize(runs.filter((r) => r.event === "push")),
    pullRequest: summarize(runs.filter((r) => r.event === "pull_request")),
  };

  const json = JSON.stringify(report, null, 2);
  if (OUTPUT_PATH) {
    writeFileSync(OUTPUT_PATH, json);
  } else {
    process.stdout.write(`${json}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
