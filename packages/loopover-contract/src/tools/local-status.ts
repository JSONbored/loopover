// loopover_local_status_structured (#9517 pilot).
//
// stdio-only, and the one tool that already had a real zod outputSchema before this package existed
// -- it was declared inline in packages/loopover-mcp/bin/loopover-mcp.ts. Relocated here verbatim in
// shape so the migration is provably behavior-preserving for the one tool where a before/after
// comparison is possible.
//
// `locality: "local-git"` is the load-bearing metadata: this reads the caller's own checkout and
// local config, which no hosted Worker can see. It is the reason a gateway cannot simply proxy
// everything to the remote server.
import { z } from "zod";
import { defineTool } from "../tool-definition.js";

export const LocalStatusStructuredInput = z.object({
  cwd: z.string().optional(),
  baseRef: z.string().optional(),
  repoFullName: z.string().min(3).optional(),
});

export const LocalStatusStructuredOutput = z.looseObject({
  apiUrl: z.string(),
  package: z.looseObject({ name: z.string(), version: z.string() }),
  hasToken: z.boolean(),
  // Left as an open record, matching the shape shipped today. The concrete payload
  // (profilePublicState) has a known set of keys, but tightening an OUTPUT schema is the direction
  // that breaks clients, so it stays as-is until a deliberate widening pass.
  profile: z.record(z.string(), z.unknown()),
  authLogin: z.string().nullable(),
  sessionExpiresAt: z.string().nullable(),
  sourceUploadDefault: z.boolean(),
  sourceUploadSupported: z.boolean(),
  // Either collectLocalBranchMetadata's result or { error } when git inspection failed -- the
  // handler catches and reports rather than throwing, so both shapes are legitimate.
  git: z.record(z.string(), z.unknown()),
});

export type LocalStatusStructuredInput = z.infer<typeof LocalStatusStructuredInput>;
export type LocalStatusStructuredOutput = z.infer<typeof LocalStatusStructuredOutput>;

export const localStatusStructuredTool = defineTool({
  name: "loopover_local_status_structured",
  title: "Local MCP status (structured)",
  description: "Return local LoopOver MCP status with a validated structured output schema.",
  category: "utility",
  auth: "public",
  locality: "local-git",
  availability: "both",
  input: LocalStatusStructuredInput,
  output: LocalStatusStructuredOutput,
});
