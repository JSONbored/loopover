// loopover_predict_gate (#9517 pilot).
//
// The remote server's output schema declared blockers/warnings/funnel as bare `z.unknown()`, which
// is precisely the information a caller needs most: a predicted FAIL is only actionable if the
// client can read the blocker list. Modelled here from `PredictedGateVerdict`
// (packages/loopover-engine/src/predicted-gate.ts).
import { z } from "zod";
import { defineTool } from "../tool-definition.js";
import { PREDICT_GATE_MAX_CHANGED_PATH_CHARS, PREDICT_GATE_MAX_CHANGED_PATHS } from "../limits.js";

/** A predicted blocker or warning. Identical shape for both, per the engine type. */
export const gateFindingSchema = z.looseObject({
  code: z.string(),
  title: z.string(),
  detail: z.string(),
  action: z.string().optional(),
});

export const PredictGateInput = z.object({
  login: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
  title: z.string().min(1),
  body: z.string().optional(),
  labels: z.array(z.string()).optional(),
  linkedIssues: z.array(z.number().int().positive()).optional(),
  // Changed file PATHS only -- metadata, never source content. Supplying them lets the predictor
  // also evaluate the focus-manifest path policy and path-gated pre-merge checks.
  // 400, not PREFLIGHT_LIMITS.changedFileChars (300): the remote server bounded paths at 300 while
  // the stdio server bounded them at 400, and a shared contract may only widen an input, never
  // tighten one -- picking 300 would start rejecting paths the stdio server accepts today. The
  // engine bounds these again on the way in regardless.
  changedPaths: z.array(z.string().min(1).max(PREDICT_GATE_MAX_CHANGED_PATH_CHARS)).max(PREDICT_GATE_MAX_CHANGED_PATHS).optional(),
});

export const PredictGateOutput = z.looseObject({
  predicted: z.boolean(),
  basis: z.string(),
  pack: z.enum(["gittensor", "oss-anti-slop"]),
  conclusion: z.string(),
  title: z.string(),
  summary: z.string(),
  // Null when the pack does not compute a readiness score, distinct from an absent field.
  readinessScore: z.number().nullable(),
  confirmedContributor: z.boolean().optional(),
  blockers: z.array(gateFindingSchema),
  warnings: z.array(gateFindingSchema),
  // Present only under the `oss-anti-slop` pack; explicitly null under `gittensor`, where the
  // contributor is already registered and has no conversion path to offer.
  funnel: z.looseObject({ message: z.string(), registerUrl: z.string() }).nullable(),
  note: z.string(),
});

export type PredictGateInput = z.infer<typeof PredictGateInput>;
export type PredictGateOutput = z.infer<typeof PredictGateOutput>;

export const predictGateTool = defineTool({
  name: "loopover_predict_gate",
  title: "Predict gate disposition",
  description:
    "Predict how the LoopOver gate would dispose of a planned pull request, from the repo's public .loopover.yml config plus safe defaults: the conclusion, readiness score, and the specific blockers and warnings it would raise. Metadata-only — never receives diff content, so the slop score is not evaluated.",
  category: "review",
  auth: "token",
  locality: "remote",
  availability: "both",
  input: PredictGateInput,
  output: PredictGateOutput,
});
