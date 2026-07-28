// loopover_preflight_pr (#9517 pilot).
//
// Both servers return the same payload here -- the engine's `PreflightResult` -- and the REST route
// behind the stdio server already has a field-for-field zod schema for it
// (`PreflightResultSchema`, src/openapi/schemas.ts). That makes this the one pilot tool where the
// MCP output schema and the REST response schema genuinely agree, so the shape below is modelled
// directly on both.
//
// The input bounds are the REST route's (`preflightSchema`, src/api/routes.ts), which the stdio
// server did NOT apply -- it declared every field unbounded. That is not a tightening in any
// meaningful sense: the server rejects an over-long title with a 400 regardless, so the only effect
// is that the caller now gets a clear client-side error instead of a confusing API error two hops
// away. This is the same failure #6153 documented when the stdio autonomy enum drifted looser than
// the server's.
import { z } from "zod";
import { defineTool } from "../tool-definition.js";
import { PREFLIGHT_LIMITS } from "../limits.js";
import { advisoryFindingSchema, laneAdviceSchema, collisionClusterSchema } from "./repo-context.js";

export const PreflightPrInput = z.object({
  repoFullName: z.string().min(3).max(PREFLIGHT_LIMITS.repoFullNameChars),
  contributorLogin: z.string().min(1).max(PREFLIGHT_LIMITS.contributorLoginChars).optional(),
  title: z.string().min(1).max(PREFLIGHT_LIMITS.titleChars),
  body: z.string().max(PREFLIGHT_LIMITS.bodyChars).optional(),
  labels: z.array(z.string().max(PREFLIGHT_LIMITS.labelChars)).max(PREFLIGHT_LIMITS.labels).optional(),
  changedFiles: z.array(z.string().max(PREFLIGHT_LIMITS.changedFileChars)).max(PREFLIGHT_LIMITS.changedFiles).optional(),
  linkedIssues: z.array(z.number().int().positive()).max(PREFLIGHT_LIMITS.linkedIssues).optional(),
  tests: z.array(z.string().max(PREFLIGHT_LIMITS.testChars)).max(PREFLIGHT_LIMITS.tests).optional(),
  authorAssociation: z.string().max(PREFLIGHT_LIMITS.authorAssociationChars).optional(),
});

/** `PreflightResult` (packages/loopover-engine/src/signals/engine.ts). All eight fields are
 *  required and non-nullable on the type, and the builder always populates them. Note `collisions`
 *  is a flat cluster array here, NOT the `CollisionReport` envelope get_repo_context returns. */
export const PreflightPrOutput = z.looseObject({
  repoFullName: z.string(),
  generatedAt: z.string(),
  status: z.enum(["ready", "needs_work", "hold"]),
  lane: laneAdviceSchema,
  reviewBurden: z.enum(["low", "medium", "high"]),
  linkedIssues: z.array(z.number()),
  findings: z.array(advisoryFindingSchema),
  collisions: z.array(collisionClusterSchema),
});

export type PreflightPrInput = z.infer<typeof PreflightPrInput>;
export type PreflightPrOutput = z.infer<typeof PreflightPrOutput>;

export const preflightPrTool = defineTool({
  name: "loopover_preflight_pr",
  title: "Preflight a planned pull request",
  description:
    "Preflight planned pull-request metadata against the repo's lane, duplicate clusters, linked-issue policy, test evidence, and review burden before any code is pushed. Metadata-only: accepts titles, labels, file paths, and test names, never source content.",
  category: "discovery",
  auth: "token",
  locality: "remote",
  availability: "both",
  input: PreflightPrInput,
  output: PreflightPrOutput,
});
