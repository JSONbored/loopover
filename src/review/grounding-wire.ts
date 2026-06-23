// Convergence (grounding) wiring: feeds the AI reviewer the FINISHED CI results + the FULL post-change
// content of the changed files, so a non-frontier model stops hallucinating CI outcomes ("this breaks the
// build" on a green PR) and undefined symbols (flagged because they're defined just outside the visible hunk).
//
// Single env switch: GITTENSORY_REVIEW_GROUNDING. Default OFF (unset/"false") — when OFF this module gathers nothing,
// the reviewer prompt is byte-identical to today, and no extra GitHub fetch is made. Truthy follows the
// codebase convention (`/^(1|true|yes|on)$/i`, same as isSafetyEnabled / isEnabled).
//
// The ported, self-contained grounding engine lives in `./review-grounding`; this file is the thin HOST
// adapter that supplies its two inputs from data gittensory already has — the cached CI check summaries
// (listCheckSummaries) and a GitHub Contents-API-backed FileFetcher — and renders the prompt text. Fully
// fail-safe: any missing CI data / fetch error degrades to "no grounding" and the review proceeds on the diff.

import { createInstallationToken } from "../github/app";
import type { CheckSummaryRecord, PullRequestFileRecord } from "../types";
import { repoParts } from "../utils/json";
import {
  buildGrounding,
  type FileFetcher,
  fetchFullFileContents,
  formatGroundingSections,
  type GroundingFlags,
  groundingSystemSuffix,
  type PullRequestFile,
} from "./review-grounding";

/** True when grounding is enabled. Flag-OFF (default) → no grounding is gathered and the prompt is unchanged. */
export function isGroundingEnabled(env: { GITTENSORY_REVIEW_GROUNDING?: string | undefined }): boolean {
  return /^(1|true|yes|on)$/i.test(env.GITTENSORY_REVIEW_GROUNDING ?? "");
}

/** When ON, both grounding inputs (CI + full files) are gathered; OFF gathers neither. One switch keeps the
 *  flag-OFF path provably byte-identical (no partial grounding). */
function groundingFlags(env: { GITTENSORY_REVIEW_GROUNDING?: string | undefined }): GroundingFlags {
  const on = isGroundingEnabled(env);
  return { ciGrounding: on, fullFileContext: on };
}

// A check is FAILING when its conclusion (or status, if not yet concluded) is one of these (matches the
// classification local-branch.ts already uses for GitHubBranchStatus, so grounding agrees with the gate).
const FAILING_CONCLUSIONS = new Set(["failure", "failed", "timed_out", "cancelled", "action_required", "startup_failure"]);
// A concluded check that did not fail and is one of these is treated as PASSING (success/neutral/skipped).
const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/** Pull a one-line failure reason from a check-run payload (output.title/summary) or a commit-status
 *  description — the same fields the unified comment surfaces, so the reviewer sees WHY a check failed
 *  ("60% of diff hit (target 97%)") not just "codecov/patch failed". "" when none present. Exported so the
 *  unified-comment call site populates MergeReadiness.failingDetails from the SAME extraction (FIX D3),
 *  keeping the reviewer's grounding and the public comment consistent on each check's failure reason. */
export function checkSummaryText(check: CheckSummaryRecord): string {
  const payload = check.payload as { output?: { title?: unknown; summary?: unknown }; description?: unknown } | undefined;
  const output = payload?.output;
  const candidates = [output?.title, output?.summary, payload?.description];
  for (const value of candidates) {
    if (typeof value === "string") {
      const trimmed = value.trim().replace(/\s+/g, " ");
      if (trimmed) return trimmed.slice(0, 200);
    }
  }
  return "";
}

/** Shape the grounding engine's `toCiSummary` consumes (mirrors reviewbot's getAllChecksState aggregate). */
type CheckAggregate = { state: "passed" | "failed" | "pending"; passing: string[]; failingDetails: Array<{ name: string; summary?: string }> };

/**
 * Fold gittensory's cached CI check summaries into the compact aggregate the grounding engine renders.
 * `state` is failed if ANY check failed, else pending if ANY check is still running, else passed. A check
 * with no rows at all (`undefined`) means we have no CI signal → the caller passes `undefined` so CI grounding
 * is simply omitted (never asserts a green/red state we can't verify).
 */
export function buildCheckAggregate(checks: CheckSummaryRecord[]): CheckAggregate | undefined {
  if (checks.length === 0) return undefined;
  const passing: string[] = [];
  const failingDetails: Array<{ name: string; summary?: string }> = [];
  let anyPending = false;
  for (const check of checks) {
    const conclusion = (check.conclusion ?? "").toLowerCase();
    const status = check.status.toLowerCase();
    if (conclusion ? FAILING_CONCLUSIONS.has(conclusion) : FAILING_CONCLUSIONS.has(status)) {
      const summary = checkSummaryText(check);
      failingDetails.push({ name: check.name, ...(summary ? { summary } : {}) });
      continue;
    }
    // Concluded and not failing → passing. Otherwise (not yet concluded / non-terminal status) → pending.
    if (conclusion ? PASSING_CONCLUSIONS.has(conclusion) || status === "completed" : status === "success") {
      passing.push(check.name);
    } else {
      anyPending = true;
    }
  }
  const state: CheckAggregate["state"] = failingDetails.length > 0 ? "failed" : anyPending ? "pending" : "passed";
  return { state, passing, failingDetails };
}

/** Map gittensory's PR file records to the subset the grounding engine reads (filename + status). */
function toGroundingFiles(files: PullRequestFileRecord[]): PullRequestFile[] {
  return files.map((file) => ({ filename: file.path, ...(file.status ? { status: file.status } : {}) }));
}

/**
 * A {@link FileFetcher} backed by the GitHub Contents API. Authenticates with an installation token (so it
 * reads private repos), falling back to the public token, then to unauthenticated. Returns the raw file text,
 * or null on any non-OK / binary / oversized / error response. NEVER throws — the grounding engine already
 * treats null as "skip this file" and degrades to no-grounding when nothing is readable.
 */
export async function makeGithubFileFetcher(env: Env, repoFullName: string, installationId: number | null | undefined): Promise<FileFetcher> {
  // Resolve the token once (best-effort): installation token > public token > none.
  let token: string | undefined;
  if (installationId) {
    token = await createInstallationToken(env, installationId).catch(() => undefined);
  }
  token = token ?? env.GITHUB_PUBLIC_TOKEN;
  const { owner, name } = repoParts(repoFullName);
  return {
    async getFileContent(path: string, ref: string, maxChars = 24_001): Promise<string | null> {
      try {
        const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${path
          .split("/")
          .map(encodeURIComponent)
          .join("/")}?ref=${encodeURIComponent(ref)}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        try {
          const response = await fetch(url, {
            signal: controller.signal,
            headers: {
              // raw media type returns the file body directly (no base64 envelope to decode).
              accept: "application/vnd.github.raw+json",
              "user-agent": "gittensory/0.1",
              "x-github-api-version": "2022-11-28",
              ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
          });
          if (!response.ok) return null;
          const contentLength = response.headers.get("content-length");
          if (contentLength && Number(contentLength) > maxChars) return " ".repeat(maxChars + 1);
          return await readTextWithLimit(response, maxChars);
        } finally {
          clearTimeout(timeout);
        }
      } catch {
        return null; // network / decode failure → skip this file (fail-safe)
      }
    },
  };
}

async function readTextWithLimit(response: Response, maxChars: number): Promise<string | null> {
  if (!response.body) {
    const text = await response.text();
    return text.length > maxChars ? text.slice(0, maxChars + 1) : text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.length > maxChars) {
      await reader.cancel().catch(() => undefined);
      return text.slice(0, maxChars + 1);
    }
  }
  text += decoder.decode();
  return text.length > maxChars ? text.slice(0, maxChars + 1) : text;
}

/** The grounding text spliced into the reviewer prompts. Both fields are "" when grounding is OFF or empty,
 *  so the caller's prompt is byte-identical to today. */
export type ReviewGroundingText = {
  /** Appended to the reviewer's SYSTEM prompt — the non-gameable grounding discipline. "" when off/empty. */
  systemSuffix: string;
  /** Appended to the USER prompt — the CI STATUS + FULL FILE CONTENT sections. "" when off/empty. */
  promptSection: string;
};

const EMPTY_GROUNDING: ReviewGroundingText = { systemSuffix: "", promptSection: "" };

/**
 * Build the grounding text for a PR (flag-gated, fail-safe). When the flag is OFF this returns EMPTY_GROUNDING
 * immediately — no CI read, no file fetch, no prompt change. When ON, it reuses the already-cached CI check
 * summaries + fetches the full content of the changed files (capped/prioritized by the engine) and renders the
 * prompt sections. Any error degrades to EMPTY_GROUNDING; this NEVER throws.
 */
export async function buildReviewGroundingText(
  env: Env,
  args: {
    repoFullName: string;
    headSha: string | null | undefined;
    files: PullRequestFileRecord[];
    checks: CheckSummaryRecord[];
    installationId: number | null | undefined;
  },
): Promise<ReviewGroundingText> {
  const flags = groundingFlags(env);
  if (!flags.ciGrounding && !flags.fullFileContext) return EMPTY_GROUNDING;
  try {
    const aggregate = buildCheckAggregate(args.checks);
    const fetcher = await makeGithubFileFetcher(env, args.repoFullName, args.installationId);
    const fileContents = await fetchFullFileContents(flags, args.headSha ?? undefined, toGroundingFiles(args.files), fetcher);
    const grounding = buildGrounding(flags, aggregate, fileContents);
    const promptSection = formatGroundingSections(grounding);
    // Only attach the grounding-discipline system suffix when we actually produced grounding to verify
    // against; otherwise the prompt stays unchanged (no point telling the model to "check the file" with
    // no file attached).
    const systemSuffix = promptSection ? groundingSystemSuffix(flags) : "";
    return { systemSuffix, promptSection };
  } catch {
    return EMPTY_GROUNDING; // any error → review proceeds on the diff alone
  }
}
