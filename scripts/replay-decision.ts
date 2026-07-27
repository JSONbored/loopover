#!/usr/bin/env node
// Decision replay CLI (#8838) — re-derive a gate decision from its persisted record + replay input and
// prove it bit-exactly, or exit non-zero with the first divergent stage.
//
//   node --experimental-strip-types scripts/replay-decision.ts <bundle.json>
//   ... | node --experimental-strip-types scripts/replay-decision.ts -
//   node --experimental-strip-types scripts/replay-decision.ts <bundle.json> --at <epoch ms>
//
// #9028: `--at` names the instant to replay AT. Omit it to replay at the instant the decision itself recorded
// (`replayInput.clock.nowMs`) — the bit-exact case. Passing a DIFFERENT instant exits 1 with a `clock`
// divergence rather than reporting a match: time is a decision INPUT, and a clock-dependent rule
// (`gate.requireFreshRebaseWindow`) can flip purely because the wall clock moved.
//
// The bundle is one JSON object: { record: {...decision_records row}, replayInput: {...replay_json} }.
// EXTRACT (operator, against the instance DB):
//   SELECT json_build_object(
//            -- #9135: `|| dr.record_json::jsonb` overlays every field the PUBLIC record carries (including
//            -- camelCase fields that live only inside record_json, e.g. `divertedByHoldout`) on top of the
//            -- raw snake_case row columns, so a field added to the record schema needs no matching change
//            -- here to reach the CLI.
//            'record', to_jsonb(dr) || dr.record_json::jsonb,
//            'replayInput', dri.replay_json::jsonb
//          )
//     FROM decision_records dr JOIN decision_replay_inputs dri ON dri.record_id = dr.id
//    WHERE dr.id = 'record:<owner/repo>#<pr>@<head sha>';
//
// Exit codes: 0 = replayed, same verdict ("here is the clause"); 1 = DIVERGENCE — a bug by definition,
// file it with the printed stage diff; 2 = unusable input. Replay mode cannot re-query the model or touch
// any network/DB by construction: replayDecision is a pure function of the two JSON values.
import { readFileSync } from "node:fs";
import { replayDecision, type DecisionReplayInput, type ReplayableRecord } from "../src/review/decision-replay";

/** Parse + normalize a bundle (snake_case SQL rows accepted) and replay it. Exported for tests.
 *
 *  #9028: `atMs` names the instant to replay AT. Omitted (the default) replays at the instant the decision
 *  recorded, which is the bit-exact case. Supplying a DIFFERENT instant is reported as a `clock` divergence,
 *  never silently accepted — a clock-dependent rule can legitimately flip its answer as the wall clock moves,
 *  so "it still matches at a different instant" is not a re-derivation of the original decision. */
export function runReplayBundle(raw: string, atMs?: number): { outcome: ReturnType<typeof replayDecision> | null; error?: string } {
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
          // #9135: absent for a pre-#9135 record — normalizes to false, matching DecisionRecord's own default.
          divertedByHoldout: Boolean(rawRecord.divertedByHoldout ?? rawRecord.diverted_by_holdout ?? false),
        }
      : null;
  if (!record || !replayInput || !Array.isArray(replayInput.findings) || typeof replayInput.evaluated !== "object") {
    return { outcome: null, error: "bundle must carry {record: {id, reason_code|reasonCode, action}, replayInput: {findings, policy, evaluated}}" };
  }
  return { outcome: replayDecision(record, replayInput, atMs === undefined ? {} : { nowMs: atMs }) };
}

const invokedDirectly = process.argv[1]?.endsWith("replay-decision.ts") === true;
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const atIndex = argv.indexOf("--at");
  const atRaw = atIndex === -1 ? undefined : argv[atIndex + 1];
  if (atIndex !== -1 && (atRaw === undefined || !Number.isFinite(Number(atRaw)))) {
    console.error("replay-decision: --at requires a Unix-epoch-milliseconds value");
    process.exit(2);
  }
  const source = argv.filter((arg, index) => index !== atIndex && index !== atIndex + 1)[0];
  if (!source) {
    console.error("usage: replay-decision.ts <bundle.json | -> [--at <epoch ms>]");
    process.exit(2);
  }
  const raw = source === "-" ? readFileSync(0, "utf8") : readFileSync(source, "utf8");
  const { outcome, error } = runReplayBundle(raw, atRaw === undefined ? undefined : Number(atRaw));
  if (!outcome) {
    console.error(`replay-decision: ${error}`);
    process.exit(2);
  }
  console.log(JSON.stringify(outcome, null, 2));
  process.exit(outcome.verdict === "match" ? 0 : 1);
}
