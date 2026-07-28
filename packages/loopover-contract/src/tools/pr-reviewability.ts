// loopover_get_pr_reviewability (#9517 pilot).
//
// KNOWN DIVERGENCE, modelled deliberately (same class as get_repo_context's):
//
//  - The remote server wraps the report in a freshness envelope --
//    { status, source, repoFullName, generatedAt, report } -- and can answer with
//    status "forbidden" or "not_found" and no report at all.
//  - The stdio server proxies GET /v1/repos/:owner/:repo/pulls/:number/reviewability, which returns
//    the BARE PullRequestReviewability object with no envelope around it.
//
// The union below therefore makes every envelope field optional and allows the report's own fields
// to appear at the top level. Converging the two is #9518's work for this category; this schema is
// what keeps the divergence visible and validated rather than hidden behind an unknown.
//
// One drift found while writing this and worth fixing separately: the remote's shared
// `freshnessResponseOutputSchema` advertises a `freshness` field that this handler never emits.
import { z } from "zod";
import { defineTool } from "../tool-definition.js";
import { ownerRepoPullInput } from "../shared.js";

/** `PullRequestReviewability` (packages/loopover-engine/src/reward-risk.ts). All ten fields are
 *  required and non-nullable on the type when freshly computed; `PullRequestReviewabilitySchema` in
 *  src/openapi/schemas.ts is a field-for-field match there, so REST and a fresh MCP computation
 *  genuinely agree on this shape. `generatedAt` is optional here specifically because the cached
 *  path can serve an older persisted snapshot row: the remote handler's own fallback chain
 *  (`cached.generatedAt || payload.generatedAt || new Date().toISOString()`) only exists because a
 *  stored payload's `generatedAt` is not guaranteed -- the schema has to describe that real,
 *  defended-against case, not just the freshly-computed one. */
export const pullRequestReviewabilitySchema = z.looseObject({
  repoFullName: z.string(),
  pullNumber: z.number(),
  generatedAt: z.string().optional(),
  score: z.number(),
  action: z.enum(["review_now", "needs_author", "likely_duplicate", "close_or_redirect", "watch", "maintainer_lane"]),
  noiseSources: z.array(z.string()),
  whyThisHelps: z.array(z.string()),
  maintainerNextSteps: z.array(z.string()),
  privateSummary: z.string(),
});

export const GetPrReviewabilityInput = ownerRepoPullInput;

export const GetPrReviewabilityOutput = z.looseObject({
  // Envelope (remote only). `status` also carries the two no-report answers: "forbidden" when the
  // caller cannot see the repo, "not_found" when the repo or PR is unknown.
  status: z.enum(["ready", "forbidden", "not_found"]).optional(),
  source: z.enum(["snapshot", "computed"]).optional(),
  repoFullName: z.string().optional(),
  generatedAt: z.string().optional(),
  report: pullRequestReviewabilitySchema.optional(),
  // Bare-report fields (stdio path). Optional because the remote path nests them under `report`.
  pullNumber: z.number().optional(),
  score: z.number().optional(),
  action: z
    .enum(["review_now", "needs_author", "likely_duplicate", "close_or_redirect", "watch", "maintainer_lane"])
    .optional(),
  noiseSources: z.array(z.string()).optional(),
  whyThisHelps: z.array(z.string()).optional(),
  maintainerNextSteps: z.array(z.string()).optional(),
  privateSummary: z.string().optional(),
});

export type GetPrReviewabilityInput = z.infer<typeof GetPrReviewabilityInput>;
export type GetPrReviewabilityOutput = z.infer<typeof GetPrReviewabilityOutput>;

export const getPrReviewabilityTool = defineTool({
  name: "loopover_get_pr_reviewability",
  title: "Get pull-request reviewability",
  description:
    "Return the cached or freshly-computed reviewability report for an open PR: how ready it is to review/merge, the blocking or advisory signals against it, and its lane/duplicate/linked-issue context. Metadata-only, repo-scoped, no GitHub writes.",
  category: "review",
  auth: "maintainer",
  locality: "remote",
  availability: "both",
  input: GetPrReviewabilityInput,
  output: GetPrReviewabilityOutput,
});
