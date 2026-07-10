// E2E test-generation commit delivery (#4197, part of the #4189 epic). Pushes an AI-generated test file as a
// real commit onto an EXISTING PR's own head branch — reusing the SAME installation-token write chokepoint
// (`makeInstallationOctokit`) and git/trees -> git/commits pattern as `repo-doc-pr.ts`, but updating an
// existing ref (`PATCH git/refs/{ref}`) instead of creating a new branch/PR.
//
// Deliberately narrower in scope than repo-doc-pr.ts: this writes to SOMEONE ELSE'S branch (the PR author's),
// not a branch gittensory itself owns, so it carries a materially bigger blast radius — see #4195's
// maintainer-only authorization tier and the miner-scoring safeguard below, both required before this is ever
// invoked for real.
//
// SCORING-INTEGRITY SAFEGUARD (#4201): gittensory does not compute the authoritative Gittensor score itself —
// it is computed by external validators reading the merged PR directly from GitHub. A commit this module
// pushes onto a CONFIRMED MINER's PR branch would be indistinguishable, to that external validator, from a
// line the miner wrote themselves, inflating their apparent contribution. `isMinerAuthoredBranch` must be
// checked by the CALLER before invoking `commitE2eTestToPrBranch` for a confirmed-miner PR — this module does
// not re-check it itself (the caller already resolved miner status while authorizing the command, so
// re-deriving it here would be a redundant, easy-to-drift second source of truth).
import { githubErrorStatus, withInstallationTokenRetry } from "./app";
import { githubRateLimitAdmissionKeyForInstallation, makeInstallationOctokit } from "./client";
import { errorMessage, repoParts } from "../utils/json";
import type { AgentActionMode } from "../settings/agent-execution";

export type E2eTestCommitResult =
  | { status: "committed"; commitSha: string; htmlUrl: string }
  | { status: "declined"; reason: string }
  | { status: "error"; reason: string };

/** Default path for a generated test file — clearly labeled and namespaced by PR number so repeat
 *  invocations on the same PR overwrite the same file rather than accumulating duplicates. A maintainer who
 *  wants a different location can move the file after it lands; this module has no per-repo convention to
 *  read (that is a possible future enhancement, not required for this first delivery mode). */
export function defaultE2eTestFilePath(prNumber: number): string {
  return `e2e/gittensory-pr-${prNumber}.spec.ts`;
}

/**
 * Push a generated test file as a new commit onto an EXISTING PR's head branch. Fail-safe on every expected
 * failure mode (never a `"live"` mode, no write access / fork without "Allow edits by maintainers", the
 * branch moved since this pass started) — those all return `{ status: "declined", reason }`, not a thrown
 * error. A genuinely unexpected failure (network, auth) returns `{ status: "error", reason }` instead, so a
 * caller can tell "this could never have worked" apart from "something broke and should be retried/reported".
 */
export async function commitE2eTestToPrBranch(
  env: Env,
  args: {
    installationId: number;
    repoFullName: string;
    prNumber: number;
    headRef: string;
    headSha: string;
    testSource: string;
    actor: string;
    mode: AgentActionMode;
    testFilePath?: string | undefined;
  },
): Promise<E2eTestCommitResult> {
  if (args.mode !== "live") return { status: "declined", reason: `commit not pushed: action mode is "${args.mode}"` };
  const { owner, name: repo } = repoParts(args.repoFullName);
  const path = args.testFilePath?.trim() || defaultE2eTestFilePath(args.prNumber);
  const message = `test: add AI-generated E2E test\n\nGenerated-by: gittensory (invoked by @${args.actor})`;
  try {
    return await withInstallationTokenRetry(env, args.installationId, async (token) => {
      const octokit = makeInstallationOctokit(env, token, args.mode, githubRateLimitAdmissionKeyForInstallation(args.installationId));

      const livePr = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo, pull_number: args.prNumber });
      const liveHead = (livePr.data as { head?: { ref?: string | null; sha?: string | null; repo?: { full_name?: string | null } | null } }).head;
      if (liveHead?.repo?.full_name !== args.repoFullName) {
        return { status: "declined", reason: "commit delivery is only supported for same-repository PR branches" };
      }
      if (liveHead.ref !== args.headRef || liveHead.sha !== args.headSha) {
        return { status: "declined", reason: "the live PR head no longer matches the cached branch/commit — try the command again" };
      }

      const headCommit = await octokit.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", { owner, repo, commit_sha: args.headSha });
      const baseTreeSha = (headCommit.data as { tree: { sha: string } }).tree.sha;

      const tree = await octokit.request("POST /repos/{owner}/{repo}/git/trees", {
        owner,
        repo,
        base_tree: baseTreeSha,
        tree: [{ path, mode: "100644", type: "blob", content: args.testSource }],
      });
      const treeSha = (tree.data as { sha: string }).sha;

      const commit = await octokit.request("POST /repos/{owner}/{repo}/git/commits", {
        owner,
        repo,
        message,
        tree: treeSha,
        parents: [args.headSha],
      });
      const commitSha = (commit.data as { sha: string }).sha;

      // A ref UPDATE (not create) against the PR's own existing head branch — the one structural difference
      // from repo-doc-pr.ts's new-branch flow. `force: false` (the default) so a genuinely concurrent push to
      // the same branch surfaces as a 422/409 (handled below) rather than silently discarding it.
      await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", { owner, repo, ref: `heads/${args.headRef}`, sha: commitSha });

      return { status: "committed", commitSha, htmlUrl: `https://github.com/${args.repoFullName}/commit/${commitSha}` };
    });
  } catch (error) {
    const status = githubErrorStatus(error);
    if (status === 403 || status === 404) {
      return { status: "declined", reason: 'no write access to the PR branch (a fork PR needs "Allow edits by maintainers" enabled, or the installation lacks contents:write)' };
    }
    if (status === 422 || status === 409) {
      return { status: "declined", reason: "the PR branch moved since this pass started (ref update rejected) — try the command again" };
    }
    return { status: "error", reason: errorMessage(error, "unknown error committing the generated test") };
  }
}
