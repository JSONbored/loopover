// Shared deterministic-rule signal tracking (#7982) -- the deployment-agnostic primitive both ORB's gate
// blockers and AMS's eligibility/policy heuristics record through, so a systematically-wrong rule can be
// detected the same way in both subsystems instead of ORB alone having a self-correction story.
//
// SELF-CONTAINED, STORAGE-AGNOSTIC: every type + function here is pure -- no DB, no env, no host-specific
// event vocabulary. Mirrors src/review/auto-tune.ts's own FlagStore-injection precedent (see that file's
// header comment): the pure calibration math lives here, and each host (ORB, AMS) supplies its own
// `SignalStore` implementation wired to whatever it already uses for durable storage (ORB: audit_events over
// D1/Postgres; AMS: the local append-only event ledger). This module does NOT replace either of those --
// see outcomes-wire.ts (ORB) and event-ledger.ts (AMS), which this wraps.
//
// DEFERRED (out of scope here -- foundation only, no behavior change for either consumer until #7983/#7984/
// #7986 actually consume it):
//   • the live SignalStore implementations (the ORB and AMS adapters, wired at the host layer).
//   • any circuit-breaker / alerting action taken FROM a RulePrecisionReport or repeat count -- this module
//     only computes the numbers, exactly like auto-tune.ts's GateEvalReport is computed elsewhere and only
//     READ by the breaker logic.

/** A single instance of a deterministic rule firing against a target -- the shared "the system made a call"
 *  primitive. `ruleId` is host-defined (an ORB gate-blocker code like `missing_linked_issue`, or an AMS
 *  eligibility-exclusion reason like `missing_eligibility_label`); `targetKey` is host-defined too (ORB:
 *  `owner/repo#123`; AMS: `owner/repo#issue-456`) -- this module never parses or interprets either string. */
export type RuleFiredEvent = {
  ruleId: string;
  targetKey: string;
  outcome: string;
  occurredAt: string;
  metadata?: Record<string, unknown>;
};

/** A human's later, explicit judgment on a specific prior rule firing: `"reversed"` means the target should
 *  NOT have been blocked/excluded (the rule was wrong this time); `"confirmed"` means it should have been
 *  (the rule was right). Absence of an override is NOT itself a signal either way -- most fired rules never
 *  get an explicit human judgment, and {@link computeRulePrecision} only scores the ones that do (mirrors
 *  auto-tune.ts's GateEvalRow: `decided` is always <= `fired`/`wouldMerge`, never assumed equal to it). */
export type HumanOverrideEvent = {
  ruleId: string;
  targetKey: string;
  verdict: "reversed" | "confirmed";
  occurredAt: string;
  metadata?: Record<string, unknown>;
};

/** The minimal storage seam a host implements. Every method is async so a real implementation can hit a DB;
 *  a pure in-memory test double satisfies this trivially. Mirrors FlagStore's shape (auto-tune.ts): a small,
 *  named set of operations, not a generic read/write-anything interface. */
export interface SignalStore {
  recordRuleFired(event: RuleFiredEvent): Promise<void>;
  recordHumanOverride(event: HumanOverrideEvent): Promise<void>;
  /** Every fired + override event for `ruleId` at or after `sinceMs` (epoch millis), oldest first. A host MAY
   *  scope this further (e.g. to one repo) internally; the interface itself is unscoped beyond `ruleId`. */
  /**
   * Read one rule's history since `sinceMs`.
   *
   * `limit` bounds EACH of the two reads (#9805). It is part of the interface rather than an implementation
   * detail because a caller that publishes the result has to know whether it saw the whole window --
   * /v1/public/eval-corpus reported `truncated: false` over a read it could not have completed, precisely
   * because the bound was invisible from here.
   *
   * `saturated` is true when either read came back AT its bound, i.e. rows were almost certainly left behind.
   */
  queryRuleHistory(
    ruleId: string,
    sinceMs: number,
    limit?: number,
  ): Promise<{ fired: RuleFiredEvent[]; overrides: HumanOverrideEvent[]; saturated: boolean }>;
}

/** Per-rule confusion-style report over a window: how many times it fired, how many of those got an explicit
 *  human verdict, and the resulting precision. Mirrors auto-tune.ts's GateEvalRow shape (fired ~ wouldMerge/
 *  wouldClose, reversed ~ mergeFalse/closeFalse) at a per-RULE grain instead of per-project -- the same
 *  "confirmed / decided, decided <= fired" relationship, just keyed differently. */
export type RulePrecisionReport = {
  ruleId: string;
  fired: number;
  reversed: number;
  confirmed: number;
  decided: number;
  /** confirmed / decided, or null when decided === 0 (no human verdict yet -- never coerced to 0 or 1, same
   *  "unknown stays unknown" discipline as GateEvalRow's null precision fields). */
  precision: number | null;
};

/** True for a override event that targets the same rule as `ruleId` -- the shared filter both
 *  {@link computeRulePrecision} and any future per-target lookup would need. */
function overrideMatchesRule(event: HumanOverrideEvent, ruleId: string): boolean {
  return event.ruleId === ruleId;
}

/**
 * Compute a {@link RulePrecisionReport} for `ruleId` from its fired + override events. Only overrides whose
 * `ruleId` matches are counted (a caller MAY pass a mixed-rule event list without filtering first); a
 * `targetKey` that never fired but has an override is impossible by construction upstream and is simply
 * counted as a decided verdict with no matching fire (does not affect `fired`, only `reversed`/`confirmed`/
 * `decided`) -- this function does not attempt to cross-validate the two lists against each other, mirroring
 * computeGateEval's own "trust the caller's already-joined rows" posture.
 */
export function computeRulePrecision(ruleId: string, fired: readonly RuleFiredEvent[], overrides: readonly HumanOverrideEvent[]): RulePrecisionReport {
  const firedCount = fired.reduce((count, event) => (event.ruleId === ruleId ? count + 1 : count), 0);
  let reversed = 0;
  let confirmed = 0;
  for (const event of overrides) {
    if (!overrideMatchesRule(event, ruleId)) continue;
    if (event.verdict === "reversed") reversed += 1;
    else confirmed += 1;
  }
  const decided = reversed + confirmed;
  return {
    ruleId,
    fired: firedCount,
    reversed,
    confirmed,
    decided,
    precision: decided > 0 ? confirmed / decided : null,
  };
}

/**
 * Count how many times `ruleId` fired against the exact same `targetKey` within `fired` (a rule re-firing
 * against a target it already fired against once -- e.g. an unresolved contributor PR re-triggering the same
 * blocker on every push -- is a different signal than a fresh one-off fire, independent of whether either fire
 * has been overridden yet). Pure counting, no time-windowing here -- a caller windows `fired` itself before
 * calling this (e.g. via `queryRuleHistory`'s own `sinceMs`), matching how this whole module leaves all
 * storage/scoping to the host. See {@link evaluateRuleRepeatAlarm} for the DIFFERENT #7983 signal: the same
 * rule firing against several DIFFERENT targets, not the same one repeatedly.
 */
export function computeRuleRepeatCount(ruleId: string, targetKey: string, fired: readonly RuleFiredEvent[]): number {
  return fired.reduce((count, event) => (event.ruleId === ruleId && event.targetKey === targetKey ? count + 1 : count), 0);
}

/** A same-rule repeat-alarm verdict (#7983): whether `ruleId` has fired against enough DISTINCT targets within
 *  the caller's already-windowed `fired` list to be a "something is systematically broken" signal --
 *  independent of whether any of those firings has been confirmed or reversed by a human yet (unlike
 *  {@link computeRulePrecision}, this needs no ground truth at all, which is exactly why it can fire fast: the
 *  2026-07-21/22 metagraphed incident mis-closed 4 DISTINCT PRs within ~3 hours on the same rule, far faster
 *  than a precision-over-time breaker's `AUTOTUNE_MIN_DECIDED` sample could ever accumulate real outcomes). */
export type RuleRepeatAlarmVerdict = {
  ruleId: string;
  /** Every distinct targetKey `ruleId` fired against, in first-seen order. */
  affectedTargets: string[];
  threshold: number;
  triggered: boolean;
};

/**
 * Evaluate the #7983 same-rule repeat alarm for `ruleId` over an already-windowed `fired` list: `triggered` is
 * true once the rule has fired against at least `threshold` DISTINCT targets. Deliberately returns a
 * detection-only verdict -- no action, no severity beyond the boolean -- mirroring `src/orb/analytics.ts`'s
 * `gamingPatternFlags` precedent ("Detection only — never an automatic action") and this module's own
 * "no autonomous behavior" boundary; the host decides how (or whether) to surface a triggered verdict.
 */
export function evaluateRuleRepeatAlarm(ruleId: string, fired: readonly RuleFiredEvent[], threshold: number): RuleRepeatAlarmVerdict {
  const affectedTargets: string[] = [];
  const seen = new Set<string>();
  for (const event of fired) {
    if (event.ruleId !== ruleId || seen.has(event.targetKey)) continue;
    seen.add(event.targetKey);
    affectedTargets.push(event.targetKey);
  }
  return { ruleId, affectedTargets, threshold, triggered: affectedTargets.length >= threshold };
}
