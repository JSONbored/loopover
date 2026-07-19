// PreToolUse-style deny-hook primitives (#2295). Now a thin re-export of the engine's pure, deterministic deny
// evaluator: the whole implementation moved into `@loopover/engine` (packages/loopover-engine/src/miner/
// deny-hooks.ts) by #5667 so the review stack and the miner share one copy. No behavior change — the evaluator is
// pure (no IO, no globals, no Date/random).
export { DEFAULT_DENY_RULES, evaluateDenyHooks } from "@loopover/engine";
export type { DenyRule, DenyVerdict, ProposedToolCall } from "@loopover/engine";
