#!/usr/bin/env node
// Decision replay CLI (#8838) — re-derive a gate decision from its persisted record + replay input and
// prove it bit-exactly, or exit non-zero with the first divergent stage.
//
//   node --experimental-strip-types scripts/replay-decision.ts <bundle.json>
//   ... | node --experimental-strip-types scripts/replay-decision.ts -
//
// The bundle is one JSON object: { record: {...decision_records row}, replayInput: {...replay_json} }.
// EXTRACT (operator, against the instance DB):
//   SELECT json_build_object('record', to_jsonb(dr), 'replayInput', dri.replay_json::jsonb)
//     FROM decision_records dr JOIN decision_replay_inputs dri ON dri.record_id = dr.id
//    WHERE dr.id = 'record:<owner/repo>#<pr>@<head sha>';
//
// Exit codes: 0 = replayed, same verdict ("here is the clause"); 1 = DIVERGENCE — a bug by definition,
// file it with the printed stage diff; 2 = unusable input. Replay mode cannot re-query the model or touch
// any network/DB by construction: replayDecision is a pure function of the two JSON values.
import { readFileSync } from "node:fs";
import { replayDecision, type DecisionReplayInput, type ReplayableRecord } from "../src/review/decision-replay";

/** Parse + normalize a bundle (snake_case SQL rows accepted) and replay it. Exported for tests. */
export function runReplayBundle(raw: string): { outcome: ReturnType<typeof replayDecision> | null; error?: string } {
  let bundle: { record?: Record<string, unknown>; replayInput?: unknown };
  try {
    bundle = JSON.parse(raw) as never;
  } catch (error) {
    return { outcome: null, error: `unparseable bundle JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const rawRecord = bundle.record;
  const replayInput = bundle.replayInput as DecisionReplayInput | undefined;
  const record: ReplayableRecord | null =
    rawRecord && typeof rawRecord.id === "string"
      ? {
          id: rawRecord.id,
          reasonCode: String(rawRecord.reasonCode ?? rawRecord.reason_code ?? ""),
          action: String(rawRecord.action ?? ""),
        }
      : null;
  if (!record || !replayInput || !Array.isArray(replayInput.findings) || typeof replayInput.evaluated !== "object") {
    return { outcome: null, error: "bundle must carry {record: {id, reason_code|reasonCode, action}, replayInput: {findings, policy, evaluated}}" };
  }
  return { outcome: replayDecision(record, replayInput) };
}

const invokedDirectly = process.argv[1]?.endsWith("replay-decision.ts") === true;
if (invokedDirectly) {
  const source = process.argv[2];
  if (!source) {
    console.error("usage: replay-decision.ts <bundle.json | ->");
    process.exit(2);
  }
  const raw = source === "-" ? readFileSync(0, "utf8") : readFileSync(source, "utf8");
  const { outcome, error } = runReplayBundle(raw);
  if (!outcome) {
    console.error(`replay-decision: ${error}`);
    process.exit(2);
  }
  console.log(JSON.stringify(outcome, null, 2));
  process.exit(outcome.verdict === "match" ? 0 : 1);
}
