#!/usr/bin/env node
// Flags a required status check that's been pending/in_progress on an open PR for longer than a
// threshold, and posts a comment on the affected PR if one isn't already there.
//
// Motivation: this repo hit a real incident where "Superagent Security Scan" -- a required,
// third-party GitHub App check this repo has zero control over -- hung for over 90 minutes with no
// visibility beyond manually pulling data PR-by-PR. Since a required check must resolve before
// mergeable_state can go clean, a single stuck required check silently stalls the ENTIRE auto-merge
// pipeline (this repo's gate merges based on mergeable_state, see .claude/skills/contributing-to-
// loopover/reference.md section 3) -- with nothing surfacing that fact anywhere. This doesn't fix a
// stuck check (nothing on this repo's side can -- it's someone else's service), it just makes the
// situation visible fast instead of requiring another manual multi-PR investigation like the one that
// found the original incident.

import { pathToFileURL } from "node:url";

export const MARKER = "<!-- stuck-required-check-watchdog -->";

// Hardcoded, not read live from branch protection: GET /branches/main/protection/required_status_checks
// needs "Administration" repository read permission, which the default GITHUB_TOKEN does not get even
// with an elevated `permissions:` block in the workflow (confirmed against GitHub's own docs -- that
// scope isn't in the grantable set for the ephemeral per-run token at all, deliberately, since branch
// protection is considered too privileged). Update this list by hand if the required checks on `main`
// ever change (`gh api repos/{owner}/{repo}/branches/main/protection/required_status_checks` locally,
// with a real user token, to check the current list).
export const REQUIRED_CONTEXTS = new Set(["validate", "Superagent Security Scan"]);

// The subset of REQUIRED_CONTEXTS that no workflow in this repo declares -- currently only the third-party
// "Superagent Security Scan" GitHub App check (see the header comment). Kept beside REQUIRED_CONTEXTS, and
// exported, so a workflow-drift test can tell workflow-sourced required checks (which must still match a
// ci.yml job name) apart from genuinely external ones, and so this "which of these are external" knowledge
// is documented next to the hardcoded list rather than hidden in a test (#7774).
export const EXTERNAL_REQUIRED_CHECKS = new Set(["Superagent Security Scan"]);

/** Build the authenticated GitHub API caller used by the live entrypoint. Kept as a factory so the
 *  pure/testable logic below can take `githubApi` as an injected dependency instead of closing over a
 *  module-level token. */
function makeGithubApi(token) {
  return async function githubApi(path, options = {}) {
    const response = await fetch(`https://api.github.com${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...options.headers,
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub API error ${response.status} on ${path}: ${await response.text()}`);
    }
    return response.status === 204 ? null : response.json();
  };
}

export function minutesSince(isoString) {
  return (Date.now() - new Date(isoString).getTime()) / 60000;
}

export async function findStuckChecksForPr(pr, requiredContexts, { githubApi, owner, repoName, thresholdMinutes }) {
  const checkRuns = await githubApi(`/repos/${owner}/${repoName}/commits/${pr.head.sha}/check-runs?per_page=100`);
  const stuck = [];
  for (const run of checkRuns.check_runs ?? []) {
    if (!requiredContexts.has(run.name)) continue;
    if (run.status === "completed") continue;
    const elapsedMinutes = run.started_at ? minutesSince(run.started_at) : null;
    if (elapsedMinutes !== null && elapsedMinutes >= thresholdMinutes) {
      stuck.push({ name: run.name, status: run.status, startedAt: run.started_at, elapsedMinutes: Math.round(elapsedMinutes), htmlUrl: run.html_url });
    }
  }
  return stuck;
}

export async function hasExistingWatchdogComment(prNumber, { githubApi, owner, repoName }) {
  const comments = await githubApi(`/repos/${owner}/${repoName}/issues/${prNumber}/comments?per_page=100`);
  return comments.some((comment) => comment.body?.includes(MARKER));
}

async function postComment(prNumber, stuckChecks, { githubApi, owner, repoName }) {
  const lines = [
    MARKER,
    "## ⚠️ A required check looks stuck",
    "",
    "The following required status check(s) have been pending for longer than expected. Since a required check has to resolve before this PR can be merged, this may be blocking not just this PR but the whole auto-merge pipeline:",
    "",
    ...stuckChecks.map((check) => `- **${check.name}** — pending for ~${check.elapsedMinutes} min (started ${check.startedAt})${check.htmlUrl ? ` — [details](${check.htmlUrl})` : ""}`),
    "",
    "This is very likely an issue with the check's own service, not this PR's content. If it doesn't resolve on its own, it may be worth checking that service's status directly.",
    "",
    "_This comment was posted automatically by a scheduled check. It won't repeat for the same stuck check on this PR._",
  ];
  await githubApi(`/repos/${owner}/${repoName}/issues/${prNumber}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: lines.join("\n") }),
  });
}

/** Scan every open, non-draft PR for stuck required checks, printing a line per stuck PR and posting a
 *  one-time (marker-guarded) comment unless `dryRun`. `githubApi` is injected so this whole flow is
 *  testable without live GitHub calls. Returns the number of new comments posted. */
export async function runStuckCheckWatchdog({
  githubApi,
  owner,
  repoName,
  thresholdMinutes,
  dryRun = false,
  requiredContexts = REQUIRED_CONTEXTS,
  log = console.log,
}) {
  const prs = (await githubApi(`/repos/${owner}/${repoName}/pulls?state=open&per_page=100`)).filter((pr) => !pr.draft);
  let flaggedCount = 0;

  for (const pr of prs) {
    const stuckChecks = await findStuckChecksForPr(pr, requiredContexts, { githubApi, owner, repoName, thresholdMinutes });
    if (stuckChecks.length === 0) continue;

    log(`PR #${pr.number}: ${stuckChecks.length} required check(s) stuck past ${thresholdMinutes}min: ${stuckChecks.map((c) => `${c.name} (~${c.elapsedMinutes}min)`).join(", ")}`);

    if (await hasExistingWatchdogComment(pr.number, { githubApi, owner, repoName })) {
      log(`  Already flagged this PR -- skipping (idempotent).`);
      continue;
    }

    if (dryRun) {
      log(`  --dry-run: would post a comment on PR #${pr.number}, skipping the actual POST.`);
      continue;
    }

    await postComment(pr.number, stuckChecks, { githubApi, owner, repoName });
    flaggedCount += 1;
    log(`  Posted a new comment on PR #${pr.number}.`);
  }

  log(`Checked ${prs.length} open PR(s); flagged ${flaggedCount} new stuck-check comment(s).`);
  return flaggedCount;
}

// Entrypoint guard (#7455): the pure detection logic above is importable for tests with an injected
// githubApi; only direct invocation reads env, builds the live API caller, and makes real calls.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const thresholdMinutes = Number(process.argv.find((a) => a.startsWith("--threshold-minutes="))?.split("=")[1] ?? 20);
  const dryRun = process.argv.includes("--dry-run");

  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error("GITHUB_REPOSITORY is required");
  const [owner, repoName] = repo.split("/");
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required");

  await runStuckCheckWatchdog({ githubApi: makeGithubApi(token), owner, repoName, thresholdMinutes, dryRun });
}
