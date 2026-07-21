#!/usr/bin/env node
// Fetches per-test-file historical duration data from Codecov's Test Analytics API and aggregates it
// into a per-file average, for the test-shard bin-packer (scripts/compute-test-shards.mjs) to consume.
// Codecov already ingests a JUnit report per shard on every push to main (see ci.yml's coverage-upload
// steps, report_type: test_results) and pools it across runs -- this reads that pooled history back
// out instead of this repo tracking its own duration history from scratch.
//
// Filtered to branch=main deliberately: a PR's own JUnit upload is override_branch'd to that PR's own
// branch name (see ci.yml's upload steps), not "main" -- so branch=main naturally selects only
// push-triggered, full-unscoped-suite runs, which is exactly the population the shard bin-packer needs
// (duration-aware sharding only applies to the full-suite case; see compute-test-shards.mjs).
//
// Requires a Codecov personal API access token (Codecov Settings -> Access -> Generate Token), NOT the
// existing CODECOV_TOKEN secret -- that one is an upload-only token and doesn't authenticate this read
// API. Codecov's docs don't publish a numeric rate limit for this endpoint, so this is deliberately run
// on a schedule (test-timing-refresh.yml), not per-PR.
//
// Uses /test-analytics/, not /test-results/: the latter is now deprecated (confirmed by actually
// running this script -- Codecov returns a 301 with "This endpoint has been deprecated. Please use
// /test-analytics/ instead."). Verified via Codecov's live OpenAPI schema (api.codecov.io/api/v2/schema/)
// that /test-analytics/ returns the identical PaginatedTestrunList wrapper and Testrun field shape
// (filename, duration_seconds, commit_sha, etc.) -- a URL rename, not a schema change, so nothing else
// in this file needed to change.
//
// #7457: aggregateByFile (and the retry-decision helper) are named exports so unit tests can cover the
// per-commit-then-across-commits averaging without hitting the live Codecov driver. That driver runs
// only when this file is the process entrypoint.

import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export type CodecovTestRunRow = {
  filename?: string | null | undefined;
  commit_sha?: string | null | undefined;
  duration_seconds?: number | null | undefined;
};

type CodecovTestAnalyticsPage = {
  results: CodecovTestRunRow[];
  next: string | null;
};

export const RETRYABLE_STATUS: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

/** True when a Codecov response status should be retried (and attempt budget remains). */
export function shouldRetryCodecovFetch(status: number, attempt: number, maxAttempts: number): boolean {
  return RETRYABLE_STATUS.has(status) && attempt < maxAttempts;
}

export function aggregateByFile(rows: readonly CodecovTestRunRow[]): Record<string, number> {
  // Per-file duration must be averaged ACROSS RUNS, not just summed across every row: a file with many
  // test cases would otherwise dwarf a file with few, and a file that appears in many historical rows
  // (many runs) would inflate further with each additional run pooled in -- neither reflects "how long
  // does this file actually take in a single run." So first sum each file's rows *within* a single
  // commit (that commit's real per-run file duration), then average those per-commit totals across all
  // commits the file appears in.
  const perCommitTotals = new Map<string, Map<string | null | undefined, number>>();
  for (const row of rows) {
    if (!row.filename || row.duration_seconds == null) continue;
    if (!perCommitTotals.has(row.filename)) perCommitTotals.set(row.filename, new Map());
    const commits = perCommitTotals.get(row.filename)!;
    commits.set(row.commit_sha, (commits.get(row.commit_sha) ?? 0) + row.duration_seconds);
  }

  const averages: Record<string, number> = {};
  for (const [filename, commits] of perCommitTotals) {
    const totals = [...commits.values()];
    averages[filename] = totals.reduce((sum, value) => sum + value, 0) / totals.length;
  }
  return averages;
}

async function fetchWithRetry(url: string, token: string, maxAttempts = 4): Promise<CodecovTestAnalyticsPage> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetch(url, {
      headers: { Authorization: `bearer ${token}`, Accept: "application/json" },
    });
    if (response.ok) return response.json() as Promise<CodecovTestAnalyticsPage>;
    if (!shouldRetryCodecovFetch(response.status, attempt, maxAttempts)) {
      throw new Error(`Codecov API error ${response.status} on ${url}: ${await response.text()}`);
    }
    const delayMs = 2 ** attempt * 1000;
    console.warn(`Codecov API returned ${response.status} (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error("unreachable");
}

async function fetchAllTestRuns({
  owner,
  repoName,
  token,
  maxPages,
}: {
  owner: string;
  repoName: string;
  token: string;
  maxPages: number;
}): Promise<{ rows: CodecovTestRunRow[]; truncated: boolean }> {
  const rows: CodecovTestRunRow[] = [];
  let url: string | null = `https://api.codecov.io/api/v2/gh/${owner}/repos/${repoName}/test-analytics/?branch=main&page_size=100`;
  let pages = 0;
  while (url && pages < maxPages) {
    const body = await fetchWithRetry(url, token);
    rows.push(...body.results);
    url = body.next;
    pages += 1;
  }
  return { rows, truncated: url !== null };
}

async function main() {
  const maxPages = Number(process.argv.find((a) => a.startsWith("--max-pages="))?.split("=")[1] ?? 20);
  const outputArg = process.argv.find((a) => a.startsWith("--output="));
  const outputPath = outputArg ? outputArg.split("=")[1] : null;

  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error("GITHUB_REPOSITORY is required (e.g. JSONbored/loopover)");
  const [owner, repoName] = repo.split("/");
  const token = process.env.CODECOV_API_TOKEN;
  if (!token) throw new Error("CODECOV_API_TOKEN is required");

  const { rows, truncated } = await fetchAllTestRuns({ owner: owner!, repoName: repoName!, token, maxPages });
  const averageSecondsByFile = aggregateByFile(rows);

  const report = {
    fetchedAt: new Date().toISOString(),
    sourceRowCount: rows.length,
    fileCount: Object.keys(averageSecondsByFile).length,
    truncated, // true if MAX_PAGES was hit before the API ran out of pages -- more history existed than was pulled
    averageSecondsByFile,
  };

  const json = JSON.stringify(report, null, 2);
  if (outputPath) {
    writeFileSync(outputPath, json);
    console.log(`Wrote ${report.fileCount} files' timing data (from ${report.sourceRowCount} rows) to ${outputPath}`);
  } else {
    process.stdout.write(`${json}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
