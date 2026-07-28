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
//
// #9028: `--requery <n>` is the ONE deliberately-networked mode, for the one stage pure replay cannot cover.
// It re-runs the model n times against the EXACT persisted prompt and reports an ACTION-MATCH RATE — never
// "reproducibility": hosted inference is not bit-deterministic even at temperature 0 (batching, kernel
// scheduling, silent model revisions), so bit-comparing outputs would measure the provider's scheduler, not
// the decision. What CAN be honestly measured is whether fresh runs land in the same verdict CLASS the
// recorded decision acted on (defect vs clean, through the same parseModelReview the live pipeline uses).
//
// The bundle gains an optional `prompt` for this mode. EXTRACT (joins the private prompts sibling by the
// BASE record id, so a supersession's `:rev<N>` row still finds its head's prompt):
//   SELECT json_build_object(
//            'record', to_jsonb(dr) || dr.record_json::jsonb,
//            'replayInput', dri.replay_json::jsonb,
//            'prompt', drp.prompt_json::jsonb
//          )
//     FROM decision_records dr
//     JOIN decision_replay_inputs dri ON dri.record_id = dr.id
//     LEFT JOIN decision_replay_prompts drp
//            ON drp.record_id = 'record:' || dr.repo_full_name || '#' || dr.pull_number || '@' || dr.head_sha
//    WHERE dr.id = 'record:<owner/repo>#<pr>@<head sha>';
//
// Provider config (explicit env, no defaults — this is a debugging tool, not a service):
//   REPLAY_AI_BASE_URL + REPLAY_AI_MODEL [+ REPLAY_AI_API_KEY]   -> any OpenAI-compatible endpoint (Ollama etc.)
//   ANTHROPIC_API_KEY + REPLAY_AI_MODEL                          -> Anthropic
//
// Requery exit codes: 0 = report produced (a low rate is a FINDING, not a failure); 2 = unusable input or
// missing provider config. Prompts above the persistence cap were skipped at capture time, never truncated —
// a truncated prompt re-queried would report a rate for a prompt that was never sent.
import { readFileSync } from "node:fs";
import { replayDecision, type DecisionReplayInput, type ReplayableRecord } from "../src/review/decision-replay";
import { recordedJudgmentClass, runRequery } from "../src/review/decision-requery";
import { createAnthropicAi, createOpenAiCompatibleAi, type SelfHostAi } from "../src/selfhost/ai";

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

/** Parse the bundle's optional prompt + replay input for requery. Exported for tests. */
export function parseRequeryBundle(raw: string): { systemPrompt: string; userPrompt: string; recordedClass: "defect" | "clean" } | { error: string } {
  let bundle: { replayInput?: DecisionReplayInput; prompt?: { systemPrompt?: unknown; userPrompt?: unknown } };
  try {
    bundle = JSON.parse(raw) as never;
  } catch (error) {
    return { error: `unparseable bundle JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const systemPrompt = bundle.prompt?.systemPrompt;
  const userPrompt = bundle.prompt?.userPrompt;
  if (typeof systemPrompt !== "string" || systemPrompt.length === 0 || typeof userPrompt !== "string" || userPrompt.length === 0) {
    return { error: "requery needs bundle.prompt.{systemPrompt,userPrompt} — extract with the prompts LEFT JOIN in this file's header (rows age out after 30 days; older decisions cannot be re-queried, only replayed)" };
  }
  if (!bundle.replayInput || !Array.isArray(bundle.replayInput.findings)) {
    return { error: "requery needs bundle.replayInput.findings to derive the recorded verdict class" };
  }
  return { systemPrompt, userPrompt, recordedClass: recordedJudgmentClass(bundle.replayInput) };
}

/** Build the provider client from explicit env. Exported for tests; returns an error string when unconfigured. */
export function requeryClientFromEnv(env: Record<string, string | undefined>): { ai: SelfHostAi; model: string } | { error: string } {
  const model = env.REPLAY_AI_MODEL;
  if (!model) return { error: "requery needs REPLAY_AI_MODEL (explicit — this tool never guesses which model to spend against)" };
  if (env.REPLAY_AI_BASE_URL) {
    return { ai: createOpenAiCompatibleAi({ baseUrl: env.REPLAY_AI_BASE_URL, apiKey: env.REPLAY_AI_API_KEY, model }), model };
  }
  if (env.ANTHROPIC_API_KEY) {
    return { ai: createAnthropicAi({ apiKey: env.ANTHROPIC_API_KEY, model }), model };
  }
  return { error: "requery needs REPLAY_AI_BASE_URL (OpenAI-compatible) or ANTHROPIC_API_KEY" };
}

const invokedDirectly = process.argv[1]?.endsWith("replay-decision.ts") === true;
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const requeryIndex = argv.indexOf("--requery");
  if (requeryIndex !== -1) {
    const runsRaw = argv[requeryIndex + 1];
    const runs = Number(runsRaw);
    if (!Number.isInteger(runs) || runs < 1 || runs > 25) {
      console.error("replay-decision: --requery requires a run count between 1 and 25");
      process.exit(2);
    }
    const requerySource = argv.filter((_arg, index) => index !== requeryIndex && index !== requeryIndex + 1)[0];
    if (!requerySource) {
      console.error("usage: replay-decision.ts <bundle.json | -> --requery <n>");
      process.exit(2);
    }
    const rawBundle = requerySource === "-" ? readFileSync(0, "utf8") : readFileSync(requerySource, "utf8");
    const parsed = parseRequeryBundle(rawBundle);
    if ("error" in parsed) {
      console.error(`replay-decision: ${parsed.error}`);
      process.exit(2);
    }
    const client = requeryClientFromEnv(process.env);
    if ("error" in client) {
      console.error(`replay-decision: ${client.error}`);
      process.exit(2);
    }
    const report = await runRequery({
      systemPrompt: parsed.systemPrompt,
      userPrompt: parsed.userPrompt,
      runs,
      recordedClass: parsed.recordedClass,
      // The live call's own shape (ai-review.ts): a system turn plus a user turn, temperature 0. Matching it
      // is what makes the rate a statement about the DECISION and not about a different way of asking.
      callModel: async (systemPrompt, userPrompt) => {
        const result = await client.ai.run(client.model, {
          temperature: 0,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        });
        return result.response ?? "";
      },
    });
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }
  const atIndex = argv.indexOf("--at");
  const atRaw = atIndex === -1 ? undefined : argv[atIndex + 1];
  if (atIndex !== -1 && (atRaw === undefined || !Number.isFinite(Number(atRaw)))) {
    console.error("replay-decision: --at requires a Unix-epoch-milliseconds value");
    process.exit(2);
  }
  const source = argv.filter((_arg, index) => index !== atIndex && index !== atIndex + 1)[0];
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
