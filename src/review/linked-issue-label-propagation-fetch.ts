import { fetchLinkedIssueFacts } from "../github/backfill";
import { createInstallationToken } from "../github/app";
import { githubRateLimitAdmissionKeyForToken } from "../github/client";

// The GitHub-fetch orchestrator for linked-issue label propagation (#priority-linked-issue-gate), kept
// deliberately OUT of `linked-issue-label-propagation.ts` (the pure config types + normalizer, imported by
// `focus-manifest.ts`'s YAML parser and transitively by the gittensory-ui workspace's isolated typecheck via
// `apps/gittensory-ui/src/lib/registration-workspace.ts`). This file's GitHub/fetch imports resolve the
// Worker's ambient `Env` type, which the UI workspace's tsconfig has no visibility into -- importing them
// from the pure config file broke `ui:typecheck` by pulling the whole github/app.ts + github/backfill.ts
// module graph into that isolated compile. Only `src/queue/processors.ts` (backend-only) imports this file.

/** FETCH every linked issue's labels (fail-open) and flatten into one label list for
 *  `resolvePrTypeLabel` (`src/settings/pr-type-label.ts`) to match against. Mirrors
 *  `resolveLinkedIssueHardRule`'s own fetch idiom (`src/review/linked-issue-hard-rules.ts`): a per-issue
 *  fetch failure contributes no labels rather than throwing, so if EVERY linked issue fails, the result is
 *  `[]` — which can never match a mapping, meaning a sensitive label like `gittensor:priority` never applies
 *  when its authority (the linked issue) cannot be verified. Callers should gate this behind
 *  `config.enabled` themselves before calling (mirrors `shouldCollectLinkedIssueEvidence`'s cheap-check-
 *  before-fetch precedent) — this function only short-circuits the zero-linked-issues case, since it has no
 *  visibility into the caller's enabled flag. */
export async function fetchLinkedIssueLabelsForPropagation(args: {
  env: Env;
  repoFullName: string;
  linkedIssues: number[];
  installationId: number;
}): Promise<string[]> {
  if (args.linkedIssues.length === 0) return [];
  const token = (await createInstallationToken(args.env, args.installationId).catch(() => undefined)) ?? args.env.GITHUB_PUBLIC_TOKEN;
  const admissionKey = githubRateLimitAdmissionKeyForToken(args.env, token, args.installationId);
  const results = await Promise.all(args.linkedIssues.map((issueNumber) => fetchLinkedIssueFacts(args.env, args.repoFullName, issueNumber, token, admissionKey)));
  return results.flatMap((result) => (result.status === "found" ? result.facts.labels : []));
}
