// Centralized moderation-rules engine (generic self-host feature, #selfhost-mod-engine). A single modular
// layer over the three EXISTING anti-abuse mechanisms (contributor cap, blacklist, review-nag) that already
// short-circuit a PR's disposition: every time one of them fires against a non-exempt contributor, it counts
// toward that login's install-wide violation tally (the shared `audit_events` ledger, keyed by actor). At
// >=1 lifetime violation the contributor is labeled with `warningLabel`; at >=`banThreshold` they are labeled
// `bannedLabel` and (when `autoBlacklistOnBan`) auto-added to the existing global contributor blacklist --
// the SAME "permanent two-strikes" enforcement an already-banned login gets.
//
// Config-as-code, layered the same as every other setting: a global default (the whole layer can be off,
// which rules count, the label text, the threshold, whether a ban auto-enforces) with a PER-REPO override
// that can turn the layer off/on for just that repo and override which rules feed IT specifically. NEVER
// hard-coded for any one repo -- a self-hoster's own `.gittensory.yml`/dashboard settings choose everything.

/** The three EXISTING anti-abuse mechanisms this engine can count violations from. Kept as a closed union
 *  (not an open string) so an unrecognized value is always a normalization error, never silently accepted. */
export type ModerationRuleType = "contributor_cap" | "blacklist" | "review_nag";

const ALL_MODERATION_RULE_TYPES: readonly ModerationRuleType[] = ["contributor_cap", "blacklist", "review_nag"];

/** The `audit_events.event_type` recorded for each rule's violation -- namespaced under `moderation.violation.*`
 *  so a cross-eventType, cross-repo count query (see `db/repositories.ts`) can scope to exactly this family. */
export const MODERATION_VIOLATION_EVENT_TYPE: Record<ModerationRuleType, string> = {
  contributor_cap: "moderation.violation.contributor_cap",
  blacklist: "moderation.violation.blacklist",
  review_nag: "moderation.violation.review_nag",
};

export const DEFAULT_MODERATION_WARNING_LABEL = "mod:warning";
export const DEFAULT_MODERATION_BANNED_LABEL = "mod:banned";
export const DEFAULT_MODERATION_BAN_THRESHOLD = 5;
// Keep the decay lookback operationally bounded, mirroring MAX_REVIEW_NAG_COOLDOWN_DAYS -- repo-controlled
// config cannot overflow Date arithmetic.
export const MAX_MODERATION_VIOLATION_DECAY_DAYS = 3650;

const MAX_LABEL_CHARS = 100;

export type GlobalModerationConfig = {
  enabled: boolean;
  rules: ModerationRuleType[];
  warningLabel: string;
  bannedLabel: string;
  banThreshold: number;
  // null = permanent/lifetime tally (never decays), matching the existing global-blacklist's permanent-ban
  // philosophy. A positive integer = only violations within that many days count toward the threshold.
  violationDecayDays: number | null;
  autoBlacklistOnBan: boolean;
};

export const DEFAULT_GLOBAL_MODERATION_CONFIG: GlobalModerationConfig = {
  enabled: false,
  rules: [...ALL_MODERATION_RULE_TYPES],
  warningLabel: DEFAULT_MODERATION_WARNING_LABEL,
  bannedLabel: DEFAULT_MODERATION_BANNED_LABEL,
  banThreshold: DEFAULT_MODERATION_BAN_THRESHOLD,
  violationDecayDays: null,
  autoBlacklistOnBan: true,
};

/** Normalize a raw moderation-rules list (DB JSON or `.gittensory.yml`) into a validated, de-duplicated list
 *  of known rule types. Never throws: an unknown/malformed entry is dropped with a warning, matching the
 *  normalize-with-warnings shape every other settings list in this codebase already uses. */
export function normalizeModerationRules(input: unknown): { rules: ModerationRuleType[]; warnings: string[] } {
  const warnings: string[] = [];
  if (input === undefined || input === null) return { rules: [], warnings };
  if (!Array.isArray(input)) {
    warnings.push("moderationRules must be a list of rule type strings; ignoring it.");
    return { rules: [], warnings };
  }
  const rules: ModerationRuleType[] = [];
  const seen = new Set<ModerationRuleType>();
  for (const [index, raw] of input.entries()) {
    if (typeof raw !== "string" || !(ALL_MODERATION_RULE_TYPES as readonly string[]).includes(raw)) {
      warnings.push(`moderationRules[${index}] is not a recognized rule type (expected one of ${ALL_MODERATION_RULE_TYPES.join(", ")}); ignoring it.`);
      continue;
    }
    const rule = raw as ModerationRuleType;
    if (seen.has(rule)) continue;
    seen.add(rule);
    rules.push(rule);
  }
  return { rules, warnings };
}

/** Normalize a raw moderation label value: empty/whitespace-only collapses to undefined (falls back to the
 *  caller's default), overlong is truncated. Never throws. Mirrors blacklistLabel/contributorCapLabel's
 *  shape, minus the explicit-null-means-"no label" case those close-coupled labels use -- a moderation label
 *  is always applied when the tier is reached, never suppressible to "no label at all". */
export function normalizeModerationLabel(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const trimmed = input.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, MAX_LABEL_CHARS);
}

/** Effective rule set for one repo: an explicit per-repo override REPLACES the global list entirely (not a
 *  union) -- a repo opting out of counting review-nag toward the shared tally, for example, must be able to
 *  do so without also losing the ability to opt out of the others. Absent/undefined override ⇒ inherit the
 *  global list unchanged. */
export function resolveEffectiveModerationRules(globalRules: readonly ModerationRuleType[], perRepoOverride: readonly ModerationRuleType[] | null | undefined): ModerationRuleType[] {
  return perRepoOverride ? [...perRepoOverride] : [...globalRules];
}

export type ModerationGateMode = "inherit" | "off" | "enabled";

/** Whether the WHOLE moderation layer runs for one repo: the global master switch is authoritative;
 *  `off` lets a repo opt out while the global layer is enabled, and `enabled`/`inherit` both require the
 *  global switch to be on. */
export function resolveModerationGateEnabled(globalEnabled: boolean, gateMode: ModerationGateMode): boolean {
  if (!globalEnabled) return false;
  if (gateMode === "off") return false;
  return true;
}

export type ModerationTier = "none" | "warning" | "banned";

/** Pure escalation decision: given the actor's TOTAL violation count (including the one that just fired,
 *  already recorded by the caller) and the configured ban threshold, which tier applies. A non-positive
 *  threshold (malformed config) can never be reached by a real count, so it degrades to "always banned once
 *  any violation exists" rather than throwing -- still a safe, non-silent failure mode for a misconfigured
 *  threshold, not a crash. */
export function moderationTierForViolationCount(count: number, banThreshold: number): ModerationTier {
  if (count <= 0) return "none";
  if (count >= banThreshold) return "banned";
  return "warning";
}
