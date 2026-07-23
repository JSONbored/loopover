#!/usr/bin/env node
// Phase-2 calibration-corpus backfill CLI (#8170, epic #8082) — the two GitHub-truth passes over the rows
// phase 1 (#8157) synthesized. All matching/patching logic lives in backfill-calibration-corpus-phase2-core.ts
// (pure, unit-tested); this file is the thin IO wrapper — mirrors backfill-calibration-corpus.ts's split.
//
//   tsx scripts/backfill-calibration-corpus-phase2.ts --pass successors  --db loopover [--remote] [--apply]
//   tsx scripts/backfill-calibration-corpus-phase2.ts --pass raw-context --db loopover [--remote] [--apply]
//   … --pg postgres://…   runs against a self-host Postgres instead (#8171's driver; bare --pg uses DATABASE_URL)
//
// Both passes are dry-run by default, resumable (--state-file, default .backfill-phase2-state.json — the
// cursor survives budget exhaustion), and hard-capped on GitHub requests per run (--max-requests, default
// 300). Auth: GITHUB_TOKEN or GH_TOKEN. Pass A flips phase-1 override verdicts to `reversed` where #8166's
// successor heuristics confirm a bot-closed PR was superseded by a merge; pass B patches phase-1 fired rows
// with the PR diff the live #8130 capture records, PUBLIC repos only. Only rows whose ids carry the
// deterministic `backfill:` prefix are ever touched — live capture rows are out of reach by construction.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { openPgDatabase, resolvePgConnection, type PgCliSession } from "./pg-cli.js";
import { extractLinkedIssueNumbers } from "../src/db/repositories.js";
import {
  backfillFiredId,
  backfillOverrideId,
  matchRetroSuccessors,
  patchFiredMetadataWithDiff,
  patchOverrideMetadataToReversed,
  patchOverrideMetadataToSamePrMerged,
  renderPhase2Report,
  type HistoricalCloseSide,
  type Phase2Report,
  type SuccessorSide,
} from "./backfill-calibration-corpus-phase2-core.js";
import { BACKFILL_RULE_ID } from "./backfill-calibration-corpus-core.js";

type Pass = "successors" | "raw-context";
type Args = {
  db: string;
  remote: boolean;
  apply: boolean;
  pass: Pass;
  maxRequests: number;
  stateFile: string;
  pgPresent: boolean;
  pgValue: string | undefined;
  /** Opt-in for the weak class: shared-issue matches by a DIFFERENT author are routine duplicate
   *  competition in this culture, NOT bot-was-wrong evidence — excluded from apply unless forced. */
  includeSharedIssueOnly: boolean;
  planOut: string | undefined;
  planIn: string | undefined;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { db: "loopover", remote: false, apply: false, pass: "successors", maxRequests: 300, stateFile: ".backfill-phase2-state.json", pgPresent: false, pgValue: undefined, includeSharedIssueOnly: false, planOut: undefined, planIn: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--remote") args.remote = true;
    else if (flag === "--apply") args.apply = true;
    else if (flag === "--db") args.db = argv[++i]!;
    else if (flag === "--pg") {
      args.pgPresent = true;
      if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) args.pgValue = argv[++i];
    }
    else if (flag === "--pass") {
      const value = argv[++i];
      if (value !== "successors" && value !== "raw-context") throw new Error(`--pass must be successors or raw-context, got ${value}`);
      args.pass = value;
    } else if (flag === "--max-requests") args.maxRequests = Number(argv[++i]);
    else if (flag === "--state-file") args.stateFile = argv[++i]!;
    else if (flag === "--include-shared-issue-only") args.includeSharedIssueOnly = true;
    else if (flag === "--plan-out") args.planOut = argv[++i];
    else if (flag === "--plan-in") args.planIn = argv[++i];
  }
  if (!Number.isFinite(args.maxRequests) || args.maxRequests < 1) throw new Error("--max-requests must be a positive number");
  return args;
}

// Mirrors backfill-calibration-corpus.ts's d1Execute: fail-loud so a partial read/write never passes silently.
function d1Execute(db: string, remote: boolean, sql: string): Array<Record<string, unknown>> {
  const result = spawnSync("npx", ["wrangler", "d1", "execute", db, remote ? "--remote" : "--local", "--json", "--command", sql], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    // Fail loud instead of stalling the whole pass: a hung remote execute once sat 50 minutes silent.
    timeout: 120_000,
  });
  if (result.error) throw new Error(`wrangler d1 execute did not complete: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`wrangler d1 execute failed (${result.status}): ${(result.stderr || result.stdout || "").slice(0, 500)}`);
  }
  const parsed = JSON.parse(result.stdout);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return first?.results ?? [];
}

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// ── GitHub IO (budgeted; mirrors check-mcp-release-due.ts's timeout posture) ─────────────────────────────

const GITHUB_TIMEOUT_MS = 30_000;

class RequestBudget {
  used = 0;
  constructor(private readonly max: number) {}
  get exhausted(): boolean {
    return this.used >= this.max;
  }
  spend(): void {
    this.used += 1;
  }
}

async function githubFetch(budget: RequestBudget, path: string, accept = "application/vnd.github+json"): Promise<Response> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN (or GH_TOKEN) is required for the GitHub-truth passes");
  // Two hard-won lessons baked in (#8170's production runs):
  //   • a single transient network blip must not kill a multi-thousand-request pass ('fetch failed'
  //     at ~90% through a scan) — bounded retries on thrown fetches and 5xx;
  //   • GitHub's SECONDARY (burst) limit 403s must be WAITED OUT, not fatal: pace requests to a floor
  //     interval, and on 403/429 honor Retry-After (default 90s, cap 5 min) before retrying. A paced
  //     stall costs minutes; a dead run costs the whole scan plus the budget it already spent.
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await pace();
    budget.spend();
    try {
      const response = await fetch(`https://api.github.com${path}`, {
        headers: { authorization: `Bearer ${token}`, accept, "user-agent": "loopover-backfill-phase2" },
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      });
      if ((response.status === 403 || response.status === 429) && attempt < 5) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const waitMs = Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 90_000, 300_000);
        console.error(`GitHub ${response.status} on ${path} — waiting ${Math.round(waitMs / 1000)}s for the burst limit (attempt ${attempt}/5)`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }
      if (response.status >= 500 && attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// Default ~0.66 req/s (~2,400/hr): the scan shares the operator's PERSONAL token pool with everything
// else they run, so it deliberately stays under half the primary limit and far from the burst
// heuristics. Override per run with BACKFILL_REQUEST_FLOOR_MS when the pool is otherwise idle.
const REQUEST_FLOOR_MS = Math.max(Number(process.env.BACKFILL_REQUEST_FLOOR_MS) || 1500, 100);
let lastRequestAt = 0;
async function pace(): Promise<void> {
  const wait = lastRequestAt + REQUEST_FLOOR_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

async function githubJson<T>(budget: RequestBudget, path: string): Promise<T | null> {
  const response = await githubFetch(budget, path);
  if (response.status === 404 || response.status === 410) return null; // deleted repo/PR — skip, never guess
  if (!response.ok) throw new Error(`GitHub ${path} failed: ${response.status}`);
  return (await response.json()) as T;
}

type GithubPull = {
  number: number;
  state: string;
  merged_at: string | null;
  closed_at: string | null;
  body: string | null;
  title: string | null;
  user: { login?: string } | null;
  base: { repo: { private?: boolean } | null } | null;
};

async function fetchPullFiles(budget: RequestBudget, repo: string, number: number): Promise<string[]> {
  const files = await githubJson<Array<{ filename?: string }>>(budget, `/repos/${repo}/pulls/${number}/files?per_page=100`);
  return (files ?? []).map((file) => file.filename ?? "").filter((name) => name !== "");
}

function pullLinkedIssues(repo: string, pull: GithubPull): number[] {
  return extractLinkedIssueNumbers(`${pull.title ?? ""}\n${pull.body ?? ""}`, repo);
}

/** Merged PRs in `repo` whose merge could fall inside any pending close's lookback window. Pages
 *  sort=updated desc and stops once updated_at (an upper bound on merged_at, so nothing past it can have
 *  merged inside any window) predates the oldest close. Depth is budget-bound, not page-capped: a busy
 *  repo's history is deeper than any fixed small cap, and a silently truncated listing looks exactly like
 *  "no successors" — the first full production dry-run proved that failure mode (#8170). */
async function fetchMergedSuccessors(budget: RequestBudget, repo: string, oldestClosedAtIso: string): Promise<SuccessorSide[]> {
  const successors: SuccessorSide[] = [];
  for (let page = 1; page <= 200 && !budget.exhausted; page += 1) {
    const pulls = await githubJson<Array<GithubPull & { updated_at: string }>>(
      budget,
      `/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`,
    );
    if (!pulls || pulls.length === 0) break;
    for (const pull of pulls) {
      if (pull.merged_at) {
        successors.push({
          number: pull.number,
          mergedAt: pull.merged_at,
          authorLogin: pull.user?.login ?? null,
          linkedIssues: pullLinkedIssues(repo, pull),
          files: [], // fetched lazily only when the author path needs them (cost control)
        });
      }
    }
    if (pulls[pulls.length - 1]!.updated_at < oldestClosedAtIso) break;
  }
  return successors;
}

// ── State file (resumable cursor per pass) ───────────────────────────────────────────────────────────────

type CursorState = { successorsResumeFrom?: string; rawContextResumeFrom?: string };

function readState(path: string): CursorState {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CursorState;
  } catch {
    return {};
  }
}

// ── Passes ───────────────────────────────────────────────────────────────────────────────────────────────

type BackfillRow = { id: string; target_key: string; metadata_json: string; created_at: string };

// #8171's driver seam: when --pg selected a connection, every read/write below rides the selfhost adapter
// (same dialect translation as the deployed engine); otherwise the wrangler/D1 path is unchanged.
let pgSession: PgCliSession | null = null;

async function executeSql(args: Args, sql: string): Promise<Array<Record<string, unknown>>> {
  if (pgSession) return (await pgSession.db.prepare(sql).all<Record<string, unknown>>()).results ?? [];
  return d1Execute(args.db, args.remote, sql);
}

async function loadBackfillRows(args: Args, kind: "override" | "fired"): Promise<BackfillRow[]> {
  const rows = await executeSql(
    args,
    `SELECT id, target_key, metadata_json, created_at FROM audit_events WHERE id LIKE 'backfill:${BACKFILL_RULE_ID}:%:${kind}' ORDER BY target_key`,
  );
  return rows.filter(
    (row): row is BackfillRow =>
      typeof row.id === "string" && typeof row.target_key === "string" && typeof row.metadata_json === "string" && typeof row.created_at === "string",
  );
}

async function applyMetadataUpdate(args: Args, id: string, metadataJson: string): Promise<void> {
  await executeSql(args, `UPDATE audit_events SET metadata_json = ${sqlStringLiteral(metadataJson)} WHERE id = ${sqlStringLiteral(id)}`);
}

function splitTargetKey(targetKey: string): { repo: string; number: number } | null {
  const hash = targetKey.lastIndexOf("#");
  if (hash <= 0) return null;
  const number = Number(targetKey.slice(hash + 1));
  return Number.isFinite(number) ? { repo: targetKey.slice(0, hash), number } : null;
}

type PlanEntry =
  | { class: "same_pr_merged"; targetKey: string; mergedAt: string }
  | { class: "same_author" | "shared_issue_only"; targetKey: string; supersededBy: number; heuristics: RetroSuccessorMatch["heuristics"] };

/** Replay a previously scanned plan against the selected store — zero GitHub requests. The plan is the
 *  dry-run's own match output, so cloud and self-host stores (same seeded targets, same deterministic ids)
 *  apply identically without re-spending the API budget. */
async function runSuccessorsFromPlan(args: Args): Promise<Phase2Report> {
  const report: Phase2Report = { pass: "successors", scanned: 0, patched: 0, alreadyPatched: 0, noMatch: 0, matchedSameAuthor: 0, matchedSharedIssueOnly: 0, matchedSamePrMerged: 0, requestsUsed: 0, exhaustedBudget: false, resumeFrom: null };
  const plan = JSON.parse(readFileSync(args.planIn!, "utf8")) as PlanEntry[];
  const rowsById = new Map((await loadBackfillRows(args, "override")).map((row) => [row.id, row]));
  for (const entry of plan) {
    report.scanned += 1;
    const row = rowsById.get(backfillOverrideId(entry.targetKey));
    if (!row) {
      report.noMatch += 1;
      continue;
    }
    let patched: string | null;
    if (entry.class === "same_pr_merged") {
      report.matchedSamePrMerged += 1;
      patched = patchOverrideMetadataToSamePrMerged(row.metadata_json, entry.mergedAt);
    } else {
      if (entry.class === "same_author") report.matchedSameAuthor += 1;
      else {
        report.matchedSharedIssueOnly += 1;
        if (!args.includeSharedIssueOnly) continue; // counted, never applied without the explicit opt-in
      }
      patched = patchOverrideMetadataToReversed(row.metadata_json, { targetKey: entry.targetKey, supersededBy: entry.supersededBy, heuristics: entry.heuristics });
    }
    if (patched === null) report.alreadyPatched += 1;
    else if (args.apply) {
      await applyMetadataUpdate(args, backfillOverrideId(entry.targetKey), patched);
      report.patched += 1;
    } else report.patched += 1;
  }
  return report;
}

async function runSuccessorsPass(args: Args, budget: RequestBudget, state: CursorState): Promise<Phase2Report> {
  const report: Phase2Report = { pass: "successors", scanned: 0, patched: 0, alreadyPatched: 0, noMatch: 0, matchedSameAuthor: 0, matchedSharedIssueOnly: 0, matchedSamePrMerged: 0, requestsUsed: 0, exhaustedBudget: false, resumeFrom: null };
  const rows = (await loadBackfillRows(args, "override")).filter((row) => !state.successorsResumeFrom || row.target_key > state.successorsResumeFrom);
  const plan: PlanEntry[] = [];

  const byRepo = new Map<string, BackfillRow[]>();
  for (const row of rows) {
    const split = splitTargetKey(row.target_key);
    if (!split) continue;
    (byRepo.get(split.repo) ?? byRepo.set(split.repo, []).get(split.repo)!).push(row);
  }

  try {
  outer: for (const [repo, repoRows] of byRepo) {
    const oldestClosedAt = repoRows.reduce((min, row) => (row.created_at < min ? row.created_at : min), repoRows[0]!.created_at);
    const successors = await fetchMergedSuccessors(budget, repo, oldestClosedAt);
    const successorFiles = new Map<number, string[]>();

    for (const row of repoRows) {
      if (budget.exhausted) {
        report.exhaustedBudget = true;
        report.resumeFrom = state.successorsResumeFrom ?? null;
        break outer;
      }
      report.scanned += 1;
      const split = splitTargetKey(row.target_key)!;

      const closedPull = await githubJson<GithubPull>(budget, `/repos/${repo}/pulls/${split.number}`);
      if (!closedPull) {
        report.noMatch += 1; // deleted repo/PR — never guess
        state.successorsResumeFrom = row.target_key;
        continue;
      }
      if (closedPull.merged_at) {
        // The close-verdict PR ITSELF merged: the operator reopened + merged it — a definitive same-PR
        // reversal, the strongest label class this pass produces (no heuristics involved).
        report.matchedSamePrMerged += 1;
        plan.push({ class: "same_pr_merged", targetKey: row.target_key, mergedAt: closedPull.merged_at });
        const samePrPatched = patchOverrideMetadataToSamePrMerged(row.metadata_json, closedPull.merged_at);
        if (samePrPatched === null) report.alreadyPatched += 1;
        else if (args.apply) {
          await applyMetadataUpdate(args, backfillOverrideId(row.target_key), samePrPatched);
          report.patched += 1;
        } else report.patched += 1;
        state.successorsResumeFrom = row.target_key;
        continue;
      }
      const close: HistoricalCloseSide = {
        targetKey: row.target_key,
        repo,
        number: split.number,
        closedAt: closedPull.closed_at ?? row.created_at,
        authorLogin: closedPull.user?.login ?? null,
        linkedIssues: pullLinkedIssues(repo, closedPull),
        files: await fetchPullFiles(budget, repo, split.number),
      };

      // Cheap pass first: the linked-issue path needs no successor files at all.
      let match = matchRetroSuccessors(close, successors);
      if (!match && close.authorLogin) {
        // Author path: hydrate files for same-author successors only, then re-evaluate.
        const sameAuthor = successors.filter((successor) => successor.authorLogin?.toLowerCase() === close.authorLogin!.toLowerCase());
        for (const successor of sameAuthor) {
          if (budget.exhausted) break;
          if (!successorFiles.has(successor.number)) successorFiles.set(successor.number, await fetchPullFiles(budget, repo, successor.number));
        }
        match = matchRetroSuccessors(
          close,
          successors.map((successor) => ({ ...successor, files: successorFiles.get(successor.number) ?? successor.files })),
        );
      }

      if (!match) {
        report.noMatch += 1;
        state.successorsResumeFrom = row.target_key;
        continue;
      }
      const matchClass = match.heuristics.sameAuthorFileOverlap ? "same_author" : "shared_issue_only";
      if (matchClass === "same_author") report.matchedSameAuthor += 1;
      else report.matchedSharedIssueOnly += 1;
      plan.push({ class: matchClass, targetKey: row.target_key, supersededBy: match.supersededBy, heuristics: match.heuristics });
      if (matchClass === "shared_issue_only" && !args.includeSharedIssueOnly && args.apply) {
        state.successorsResumeFrom = row.target_key;
        continue; // counted + planned for the record, never applied without the explicit opt-in
      }
      const patched = patchOverrideMetadataToReversed(row.metadata_json, match);
      if (patched === null) {
        report.alreadyPatched += 1;
      } else if (args.apply) {
        await applyMetadataUpdate(args, backfillOverrideId(row.target_key), patched);
        report.patched += 1;
      } else {
        report.patched += 1; // dry-run: counted as "would patch"
      }
      state.successorsResumeFrom = row.target_key;
    }
  }
  } finally {
    // Persisted even when a fetch ultimately fails mid-pass: the plan-so-far plus the cursor make the
    // next run a cheap resume instead of a from-scratch re-scan.
    if (args.planOut) writeFileSync(args.planOut, `${JSON.stringify(plan, null, 2)}\n`);
  }
  report.requestsUsed = budget.used;
  return report;
}

async function runRawContextPass(args: Args, budget: RequestBudget, state: CursorState): Promise<Phase2Report> {
  const report: Phase2Report = { pass: "raw-context", scanned: 0, patched: 0, alreadyPatched: 0, noMatch: 0, matchedSameAuthor: 0, matchedSharedIssueOnly: 0, matchedSamePrMerged: 0, requestsUsed: 0, exhaustedBudget: false, resumeFrom: null };
  const rows = (await loadBackfillRows(args, "fired")).filter((row) => !state.rawContextResumeFrom || row.target_key > state.rawContextResumeFrom);
  const repoPrivacy = new Map<string, boolean>();

  for (const row of rows) {
    if (budget.exhausted) {
      report.exhaustedBudget = true;
      report.resumeFrom = state.rawContextResumeFrom ?? null;
      break;
    }
    report.scanned += 1;
    const split = splitTargetKey(row.target_key);
    if (!split) {
      report.noMatch += 1;
      continue;
    }

    if (!repoPrivacy.has(split.repo)) {
      const repoInfo = await githubJson<{ private?: boolean }>(budget, `/repos/${split.repo}`);
      repoPrivacy.set(split.repo, repoInfo?.private !== false); // missing repo counts as private — never fetch
    }
    if (repoPrivacy.get(split.repo)) {
      report.noMatch += 1; // private (or gone) repos are out of scope by the issue's own boundary
      state.rawContextResumeFrom = row.target_key;
      continue;
    }

    const diffResponse = await githubFetch(budget, `/repos/${split.repo}/pulls/${split.number}`, "application/vnd.github.v3.diff");
    if (!diffResponse.ok) {
      report.noMatch += 1;
      state.rawContextResumeFrom = row.target_key;
      continue;
    }
    const diffText = await diffResponse.text();
    // The D1 CLI driver inlines the UPDATE as literal SQL (wrangler --command cannot bind parameters), and
    // quote-doubling can double the payload: a full 120KB diff exceeds D1's per-statement length
    // (SQLITE_TOOBIG, hit live at row 37 of the first cloud apply). Cap the literal path with a
    // self-describing marker; the pg driver binds parameters and keeps the full bound diff.
    const bounded = pgSession || diffText.length <= 45_000 ? diffText : `${diffText.slice(0, 45_000)}\n[diff truncated: D1 CLI statement-length limit]`;
    const patched = patchFiredMetadataWithDiff(row.metadata_json, bounded);
    if (patched === null) {
      report.alreadyPatched += 1;
    } else if (args.apply) {
      await applyMetadataUpdate(args, backfillFiredId(row.target_key), patched);
      report.patched += 1;
    } else {
      report.patched += 1;
    }
    state.rawContextResumeFrom = row.target_key;
  }
  report.requestsUsed = budget.used;
  return report;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pgConnection = resolvePgConnection(args.pgPresent, args.pgValue, process.env.DATABASE_URL);
  if (pgConnection) pgSession = openPgDatabase(pgConnection);
  const state = readState(args.stateFile);
  const budget = new RequestBudget(args.maxRequests);

  const report =
    args.pass === "successors"
      ? args.planIn
        ? await runSuccessorsFromPlan(args)
        : await runSuccessorsPass(args, budget, state)
      : await runRawContextPass(args, budget, state);
  await pgSession?.close();
  writeFileSync(args.stateFile, `${JSON.stringify(state, null, 2)}\n`);
  console.log(renderPhase2Report(report, args.apply ? "apply" : "dry-run"));
  if (!args.apply) {
    console.error("dry-run only — re-run with --apply to write. Patches are idempotent (already-patched rows are skipped).");
    console.error("NOTE: the resume cursor advances in dry-run too — delete the state file before switching to --apply.");
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
