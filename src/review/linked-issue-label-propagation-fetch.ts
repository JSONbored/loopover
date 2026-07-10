import { fetchLinkedIssueFacts, type LinkedIssueFactsFetch, type LinkedIssueFactsResult } from "../github/backfill";
import { createInstallationToken, getRepositoryCollaboratorPermission } from "../github/app";
import { githubRateLimitAdmissionKeyForToken } from "../github/client";
import { parseGitHubLoginList } from "../auth/security";
import type { LinkedIssueLabelPropagationMapping } from "../types";

// The GitHub-fetch orchestrator for linked-issue label propagation (#priority-linked-issue-gate), kept
// deliberately OUT of `linked-issue-label-propagation.ts` (the pure config types + normalizer, imported by
// `focus-manifest.ts`'s YAML parser and transitively by the gittensory-ui workspace's isolated typecheck via
// `apps/gittensory-ui/src/lib/registration-workspace.ts`). This file's GitHub/fetch imports resolve the
// Worker's ambient `Env` type, which the UI workspace's tsconfig has no visibility into -- importing them
// from the pure config file broke `ui:typecheck` by pulling the whole github/app.ts + github/backfill.ts
// module graph into that isolated compile. Only `src/queue/processors.ts` (backend-only) imports this file.

// `pr.linkedIssues` is already hard-capped to `MAX_LINKED_ISSUE_NUMBERS` (50, `src/db/repositories.ts`) at
// extraction time, so this Promise.all can never actually fan out unbounded in production. This local cap
// is a second, self-contained line of defense (matching this value so it never bites before the real
// extraction cap does) so the function stays safe even if a future caller ever passes an unbounded array
// directly, without needing to trust every call site to have gone through the capped extractor first.
const MAX_LINKED_ISSUES_TO_FETCH = 50;

/** Whether `login` holds a maintainer-equivalent permission on `repoFullName` -- the literal repo owner,
 *  a fleet-operator in the global `ADMIN_GITHUB_LOGINS` allowlist, or a live GitHub collaborator with
 *  admin/maintain/write access (#priority-linked-issue-gate-ownership). Mirrors
 *  `hasMaintainerOrOwnerPermission` in `src/queue/processors.ts` (kept as its own copy here rather than
 *  imported, since that one is private to a file this module's header comment explicitly must NOT pull
 *  into its import graph -- see the file-level comment above). Fail-CLOSED: a collaborator-permission
 *  fetch error resolves to `null` inside `getRepositoryCollaboratorPermission` itself, which this treats
 *  the same as "not a maintainer" -- consistent with this whole file's bias toward denying an
 *  unverifiable trust claim rather than granting one. */
async function isRepoMaintainerLogin(env: Env, installationId: number, repoFullName: string, login: string): Promise<boolean> {
  // The ": \"\"" fallback is unreachable via the real webhook path: repoFullName is always the
  // "owner/repo"-formatted payload.repository.full_name, and the surrounding pipeline already requires a
  // repository match on that exact format before this function's caller runs (mirrors the identical
  // pattern + rationale in `hasMaintainerOrOwnerPermission`, `src/queue/processors.ts`).
  /* v8 ignore next */
  const repoOwner = repoFullName.includes("/") ? repoFullName.slice(0, repoFullName.indexOf("/")).toLowerCase() : "";
  if (login === repoOwner || parseGitHubLoginList(env.ADMIN_GITHUB_LOGINS).has(login)) return true;
  const permission = await getRepositoryCollaboratorPermission(env, installationId, repoFullName, login).catch(() => null);
  return permission != null && new Set(["admin", "maintain", "write"]).has(permission);
}

/** True when the linked issue's authority for propagation can be trusted (#4528): it's still OPEN, or it
 *  was closed no earlier than THIS PR's own merge. Merging a PR whose body says "Closes #N" auto-closes
 *  issue #N as an immediate side effect of that same merge -- so `closedAt >= prMergedAt` is exactly the
 *  signature of "this merge is what closed it," the single most authoritative moment for propagation to
 *  fire, not a weaker one. An issue closed BEFORE this PR ever merged (`closedAt < prMergedAt`) is the
 *  gaming case the OPEN-only check originally existed to block -- a PR opportunistically referencing some
 *  unrelated, already-resolved issue to borrow its label -- and stays blocked, unchanged. `prMergedAt`
 *  absent (PR not yet merged) never trusts a closed issue, also unchanged. */
function isLinkedIssueTrustworthy(facts: LinkedIssueFactsResult, prMergedAt: string | null): boolean {
  if (facts.state === "open") return true;
  return prMergedAt !== null && facts.closedAt !== null && facts.closedAt >= prMergedAt;
}

/** Per-issue label resolution for {@link fetchLinkedIssueLabelsForPropagation}: a direct PR-author-is-
 *  issue-author-or-assignee match unlocks EVERY label the issue carries (today's original behavior,
 *  unchanged). Failing that, a mapping explicitly opted into `trustMaintainerAuthoredIssue` OR
 *  `trustMaintainerAuthoredIssueForReward` (#priority-linked-issue-gate-ownership, #priority-reward-
 *  maintainer-trust) unlocks JUST that mapping's `issueLabel` when the issue's author independently
 *  checks out as a repo maintainer/operator via {@link isRepoMaintainerLogin} -- built so routine
 *  bug/feature mirroring doesn't require formal GitHub issue assignment (our own repos rarely assign
 *  issues). A reward mapping (e.g. `gittensor:priority`) opting into the SAME relaxation via the
 *  `...ForReward` flag is a deliberate, per-repo operator choice (see that flag's own doc comment in
 *  types.ts for why the assignee-only bar is often unsatisfiable in practice); a reward mapping that has
 *  NOT opted in still requires the contributor to be the actual author/assignee, unchanged.
 *  `relaxableLabels` is empty whenever the caller passed no mappings or none opted in, which skips the
 *  maintainer-permission check (and its GitHub API call) entirely -- byte-identical to the pre-fix
 *  behavior for any caller that hasn't opted in. Logs once per issue when the returned set is smaller
 *  than what the issue actually carries, so a future "why didn't my PR inherit the label" report is
 *  diagnosable from structured logs instead of a source read. */
async function resolveIssueLabelsForPropagation(
  args: { env: Env; repoFullName: string; installationId: number },
  result: LinkedIssueFactsFetch,
  prAuthorLogin: string | undefined,
  relaxableLabels: ReadonlySet<string>,
  prMergedAt: string | null,
): Promise<string[]> {
  if (result.status !== "found" || !isLinkedIssueTrustworthy(result.facts, prMergedAt) || !prAuthorLogin) return [];
  const allLabels = result.facts.labels;
  const issueAuthorLogin = result.facts.authorLogin?.toLowerCase();
  const assignees = result.facts.assignees.map((login) => login.toLowerCase());
  if (issueAuthorLogin === prAuthorLogin || assignees.includes(prAuthorLogin)) return allLabels;

  const maintainerAuthored =
    relaxableLabels.size > 0 &&
    !!issueAuthorLogin &&
    (await isRepoMaintainerLogin(args.env, args.installationId, args.repoFullName, issueAuthorLogin));
  const kept = maintainerAuthored ? allLabels.filter((label) => relaxableLabels.has(label.toLowerCase())) : [];

  if (kept.length < allLabels.length && allLabels.length > 0) {
    console.log(
      JSON.stringify({
        event: "linked_issue_label_propagation_filtered",
        repoFullName: args.repoFullName,
        issueNumber: result.facts.number,
        reason: maintainerAuthored ? "strict_label_requires_direct_ownership" : "no_direct_ownership_match",
        droppedCount: allLabels.length - kept.length,
      }),
    );
  }
  return kept;
}

/** FETCH every linked issue's labels (fail-open) and flatten into one label list for
 *  `resolvePrTypeLabel` (`src/settings/pr-type-label.ts`) to match against. Only an OPEN issue, or one
 *  closed no earlier than THIS PR's own merge (#4528, {@link isLinkedIssueTrustworthy}), can contribute
 *  labels; closing-keyword text in a PR body is author-controlled and is not authority by itself. Mirrors
 *  `resolveLinkedIssueHardRule`'s own fetch idiom (`src/review/linked-issue-hard-rules.ts`): a per-issue
 *  fetch failure contributes no labels rather than throwing, so if EVERY linked issue fails, the result is
 *  `[]` — which can never match a mapping, meaning a sensitive label like `gittensor:priority` never applies
 *  when its authority (the linked issue) cannot be verified. The bare `Promise.all` below is safe without a
 *  per-item `.catch` because `fetchLinkedIssueFacts` (`src/github/backfill.ts`) never throws for a network,
 *  5xx, or 404 failure -- it already wraps its own fetch in try/catch and resolves to
 *  `{status: "fetch_error"}` / `{status: "not_found"}` instead (verified by reading its implementation, not
 *  assumed); a genuinely unexpected throw there would still propagate up to this function's own caller,
 *  which is a single try/catch in `src/queue/processors.ts`'s type-label block (`type_label_error`).
 *  Callers should gate this behind `config.enabled` themselves before calling (mirrors
 *  `shouldCollectLinkedIssueEvidence`'s cheap-check-before-fetch precedent) — this function only
 *  short-circuits the zero-linked-issues case, since it has no visibility into the caller's enabled flag.
 *
 *  `mappings` (optional, #priority-linked-issue-gate-ownership) is the propagation config's own mapping
 *  list, used ONLY to know which `issueLabel`s are allowed to unlock via `resolveIssueLabelsForPropagation`'s
 *  relaxed maintainer-authored-issue path (either trust flag) -- omitting it (or a mapping never setting
 *  either flag) reproduces today's strict author-or-assignee-only behavior exactly.
 *
 *  `prMergedAt` (#4528) is this PR's own `merged_at`, or `null` while unmerged -- the caller's `pr.mergedAt`
 *  straight from the DB row, no extra fetch. */
export async function fetchLinkedIssueLabelsForPropagation(args: {
  env: Env;
  repoFullName: string;
  linkedIssues: number[];
  installationId: number;
  prAuthorLogin: string | null | undefined;
  mappings?: readonly LinkedIssueLabelPropagationMapping[] | undefined;
  prMergedAt?: string | null | undefined;
}): Promise<string[]> {
  if (args.linkedIssues.length === 0) return [];
  const linkedIssues = args.linkedIssues.slice(0, MAX_LINKED_ISSUES_TO_FETCH);
  const token =
    (await createInstallationToken(args.env, args.installationId).catch(
      () => undefined,
    )) ?? args.env.GITHUB_PUBLIC_TOKEN;
  const admissionKey = githubRateLimitAdmissionKeyForToken(
    args.env,
    token,
    args.installationId,
  );
  const prAuthorLogin = args.prAuthorLogin?.toLowerCase();
  const prMergedAt = args.prMergedAt ?? null;
  const relaxableLabels = new Set(
    (args.mappings ?? [])
      .filter((mapping) => mapping.trustMaintainerAuthoredIssue === true || mapping.trustMaintainerAuthoredIssueForReward === true)
      .map((mapping) => mapping.issueLabel.toLowerCase()),
  );
  const results = await Promise.all(
    linkedIssues.map((issueNumber) =>
      fetchLinkedIssueFacts(
        args.env,
        args.repoFullName,
        issueNumber,
        token,
        admissionKey,
      ),
    ),
  );
  const perIssueLabels = await Promise.all(
    results.map((result) =>
      resolveIssueLabelsForPropagation(
        { env: args.env, repoFullName: args.repoFullName, installationId: args.installationId },
        result,
        prAuthorLogin,
        relaxableLabels,
        prMergedAt,
      ),
    ),
  );
  return perIssueLabels.flat();
}
