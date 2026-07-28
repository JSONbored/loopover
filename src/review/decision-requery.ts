// #9028 (Replay v2): re-query action matching — the honest metric for the one irreducibly nondeterministic
// stage of a gate decision.
//
// Everything downstream of the model is a pure function pinned bit-exactly by the replay harness (#8838,
// including time via the #9028 clock capture). The model call itself is NOT: hosted inference is not
// bit-deterministic even at temperature 0 (batching, kernel scheduling, and silent model revisions all move
// tokens). So this mode NEVER reports "reproducibility" — it re-runs the model against the exact persisted
// prompt and reports an ACTION-MATCH RATE: across N fresh runs, how often did the model's verdict land in the
// same class that drove the recorded decision?
//
// Class, not text: two runs that phrase the same blocker differently are the same ACTION; a run that flips
// defect ⇄ clean is a different action regardless of phrasing. The class boundary is the exact one the live
// pipeline acts on (`ai_consensus_defect` / `ai_review_split` block; their absence does not).
import { parseModelReview } from "../services/ai-review";
import type { DecisionReplayInput } from "./decision-replay";

/** The verdict classes the gate can ACT on. `unusable` is a run whose output the live parser would reject —
 *  it can never match an action, because the live pipeline routes it to fail-closed inconclusive handling
 *  rather than either verdict. */
export type RequeryVerdictClass = "defect" | "clean" | "unusable";

/** The finding codes that carry an AI judgment into the gate — the same set the decision-record path keys on
 *  (`AI_JUDGMENT_BLOCKER_CODES` in processors.ts). Duplicated as a literal here so this module stays
 *  importable by the offline CLI without dragging the queue module graph along. */
const AI_JUDGMENT_FINDING_CODES = new Set(["ai_consensus_defect", "ai_review_split"]);

/** Classify one fresh model response through the SAME parser the live pipeline uses. */
export function classifyModelResponse(text: string): RequeryVerdictClass {
  const parsed = parseModelReview(text);
  if (parsed === null) return "unusable";
  return parsed.blockers.length > 0 ? "defect" : "clean";
}

/** The class the RECORDED decision acted on, read from the persisted replay input's findings. */
export function recordedJudgmentClass(replayInput: Pick<DecisionReplayInput, "findings">): "defect" | "clean" {
  return replayInput.findings.some((finding) => AI_JUDGMENT_FINDING_CODES.has(finding.code)) ? "defect" : "clean";
}

export interface RequeryReport {
  mode: "requery";
  /** What this number is and is not, restated in the artifact itself so a pasted report cannot shed the
   *  caveat: hosted inference is not bit-deterministic even at temperature 0. */
  metric: "action-match-rate (NOT reproducibility)";
  recordedClass: "defect" | "clean";
  runs: number;
  matches: number;
  actionMatchRate: number;
  perRun: RequeryVerdictClass[];
}

/**
 * Re-run the model `runs` times against the exact persisted prompt and report the action-match rate.
 *
 * The model call is injected (`callModel`), so this stays a pure orchestration over an IO seam — the CLI
 * binds it to a real provider client; tests bind it to a script.
 */
export async function runRequery(args: {
  systemPrompt: string;
  /** The user turn -- the diff/title/body. The decision inputs SPLIT across the two turns (the system prompt
   *  is rubric + config), so re-querying with the system prompt alone would ask the model to review nothing. */
  userPrompt: string;
  runs: number;
  recordedClass: "defect" | "clean";
  callModel: (systemPrompt: string, userPrompt: string) => Promise<string>;
}): Promise<RequeryReport> {
  const perRun: RequeryVerdictClass[] = [];
  for (let i = 0; i < args.runs; i += 1) {
    let text = "";
    try {
      text = await args.callModel(args.systemPrompt, args.userPrompt);
    } catch {
      // A transport failure is an UNUSABLE run, not a skipped one: the operator asked for N runs, and
      // silently shrinking the denominator would inflate the rate exactly when the provider is flakiest.
      perRun.push("unusable");
      continue;
    }
    perRun.push(classifyModelResponse(text));
  }
  const matches = perRun.filter((cls) => cls === args.recordedClass).length;
  return {
    mode: "requery",
    metric: "action-match-rate (NOT reproducibility)",
    recordedClass: args.recordedClass,
    runs: args.runs,
    matches,
    actionMatchRate: args.runs === 0 ? 0 : Number((matches / args.runs).toFixed(3)),
    perRun,
  };
}
