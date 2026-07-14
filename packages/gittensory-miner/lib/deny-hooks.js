// PreToolUse-style deny-hook primitives (#2295). Now a thin re-export of the engine's pure, deterministic deny
// evaluator: the whole implementation moved into `@loopover/engine` (packages/gittensory-engine/src/miner/
// deny-hooks.ts) by #5667 so the review stack and the miner share one copy. No behavior change — the evaluator is
// pure (no IO, no globals, no Date/random). See deny-hooks.d.ts for the type contract (DenyRule/DenyVerdict/
// ProposedToolCall), which still declares the same shapes the engine module now implements.
export { DEFAULT_DENY_RULES, evaluateDenyHooks } from "@loopover/engine";
