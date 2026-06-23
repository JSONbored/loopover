import type { JsonValue } from "../types";

// Linked-issue HARD-RULE auto-close (#linked-issue-hard-rules). A DETERMINISTIC rule about the issue(s) a
// contributor PR links — not an AI verdict. When a contributor links an issue that violates one of the
// operator's hard rules, the PR is one-shot CLOSED with the SPECIFIC rule cited, so the contributor knows
// exactly why (and which issue). The three rules (close when ANY linked OPEN issue trips one):
//   1. owner-assigned    — the issue is assigned to the repo owner (reserved for the maintainer).
//   2. missing-point     — a default-label repo AND the issue carries NONE of the point-bearing labels
//                          (gittensor:bug / gittensor:feature / gittensor:priority) → not a scored contribution.
//   3. maintainer-only   — the issue is labeled `maintainer-only` → not open for community PRs.
//
// Each rule is independently `"block"` (enforce) or `"off"` (ignore). Because this is deterministic (no
// hallucination risk), the close fires REGARDLESS of a hard-guardrail path hit — but NEVER for the owner or
// an automation bot (the planner's `isContributor` guard owns that exemption).

export type LinkedIssueHardRulesMode = "block" | "off";

export type LinkedIssueHardRulesConfig = {
  ownerAssignedClose: LinkedIssueHardRulesMode;
  missingPointLabelClose: LinkedIssueHardRulesMode;
  maintainerOnlyLabelClose: LinkedIssueHardRulesMode;
  // The point-bearing labels that make an issue eligible for a scored contribution.
  pointBearingLabels: string[];
  // The labels that mark an issue as maintainer-only (not open for community PRs).
  maintainerOnlyLabels: string[];
  // True when the repo uses the default gittensor labels, which is the precondition for the missing-point rule
  // (a repo that does NOT use point labels must never auto-close for "missing point label").
  defaultLabelRepo: boolean;
  // Flag-then-close double-check (#linked-issue-verify-before-close). When TRUE (default), a hard-rule
  // violation does NOT close on first detection: the planner FLAGS the PR (adds the pending-closure label + a
  // warning comment) and only CLOSES on the NEXT gate evaluation if the violation STILL holds AND the label is
  // already present (a label-based two-pass state machine — the second pass is the verification). When FALSE,
  // the close fires immediately on first detection (the original GAP-5 behavior).
  verifyBeforeClose: boolean;
  // How long (seconds) until the verification pass — surfaced in the flag comment, and used to delay the
  // optional re-review re-enqueue so Pass 2 doesn't wait for the slow sweep. Clamped to [0, 300].
  closeDelaySeconds: number;
};

// Fail-SAFE default: every mode OFF, empty label lists, NOT a default-label repo. An unconfigured (or
// KV-unbound, or KV-faulting) repo must never auto-close a contributor PR for a linked-issue rule. The default
// point/maintainer label lists are only used when a repo turns the corresponding rule ON without listing its
// own; an OFF rule never reads them.
const DEFAULT_POINT_BEARING_LABELS = ["gittensor:bug", "gittensor:feature", "gittensor:priority"];
const DEFAULT_MAINTAINER_ONLY_LABELS = ["maintainer-only"];

// The namespaced label that marks a PR as flagged-for-closure by the linked-issue hard rule (Pass 1). Its
// presence + a persisting violation on the next evaluation is the verification trigger (Pass 2 → close). Cleared
// when the violation resolves. Namespaced so it never collides with project labels (mirrors AGENT_LABEL_*).
export const AGENT_LABEL_PENDING_CLOSURE = "gittensory:pending-closure";

// Default verification delay (seconds) — how long until the second-pass close. Clamped to this range on load.
const DEFAULT_CLOSE_DELAY_SECONDS = 30;
const MIN_CLOSE_DELAY_SECONDS = 0;
const MAX_CLOSE_DELAY_SECONDS = 300;

export const DEFAULT_LINKED_ISSUE_HARD_RULES: LinkedIssueHardRulesConfig = {
  ownerAssignedClose: "off",
  missingPointLabelClose: "off",
  maintainerOnlyLabelClose: "off",
  pointBearingLabels: [],
  maintainerOnlyLabels: [],
  defaultLabelRepo: false,
  // Default ON: a hard-rule violation flags first, then closes on re-verification (the operator's double-check).
  verifyBeforeClose: true,
  closeDelaySeconds: DEFAULT_CLOSE_DELAY_SECONDS,
};

/** Clamp a KV-provided close delay to a sane range, falling back to the default for a non-finite / absent value. */
function clampCloseDelaySeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_CLOSE_DELAY_SECONDS;
  return Math.min(MAX_CLOSE_DELAY_SECONDS, Math.max(MIN_CLOSE_DELAY_SECONDS, Math.trunc(value)));
}

function asMode(value: unknown): LinkedIssueHardRulesMode | null {
  return value === "block" || value === "off" ? value : null;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  return out.length > 0 ? out : null;
}

type LinkedIssueHardRulesKvShape = {
  ownerAssignedClose?: JsonValue;
  missingPointLabelClose?: JsonValue;
  maintainerOnlyLabelClose?: JsonValue;
  pointBearingLabels?: JsonValue;
  maintainerOnlyLabels?: JsonValue;
  defaultLabelRepo?: JsonValue;
  verifyBeforeClose?: JsonValue;
  closeDelaySeconds?: JsonValue;
};

/**
 * Resolve a repo's linked-issue hard-rule config from the shared REVIEW_CONFIG KV (key = repo slug, owner
 * stripped — same convention as loadHardGuardrailGlobs). Reads the `linkedIssueHardRules` field. NEVER throws
 * (the auto-maintain trigger is best-effort) and ALWAYS fail-SAFE: an absent binding / key / field, a partial
 * config, OR a THROWN KV read (outage) all resolve to the all-OFF default so a deterministic close can never
 * fire on an unconfigured repo or a KV fault. Partial KV objects are merged OVER the default (any field a repo
 * omits keeps its safe default).
 */
export async function loadLinkedIssueHardRules(env: Env, repoFullName: string): Promise<LinkedIssueHardRulesConfig> {
  if (!env.REVIEW_CONFIG) return DEFAULT_LINKED_ISSUE_HARD_RULES;
  const slug = repoFullName.includes("/") ? repoFullName.slice(repoFullName.indexOf("/") + 1) : repoFullName;
  try {
    const config = (await env.REVIEW_CONFIG.get(slug, "json")) as { linkedIssueHardRules?: LinkedIssueHardRulesKvShape } | null;
    const raw = config?.linkedIssueHardRules;
    if (!raw || typeof raw !== "object") return DEFAULT_LINKED_ISSUE_HARD_RULES;
    return {
      ownerAssignedClose: asMode(raw.ownerAssignedClose) ?? DEFAULT_LINKED_ISSUE_HARD_RULES.ownerAssignedClose,
      missingPointLabelClose: asMode(raw.missingPointLabelClose) ?? DEFAULT_LINKED_ISSUE_HARD_RULES.missingPointLabelClose,
      maintainerOnlyLabelClose: asMode(raw.maintainerOnlyLabelClose) ?? DEFAULT_LINKED_ISSUE_HARD_RULES.maintainerOnlyLabelClose,
      pointBearingLabels: asStringArray(raw.pointBearingLabels) ?? DEFAULT_POINT_BEARING_LABELS,
      maintainerOnlyLabels: asStringArray(raw.maintainerOnlyLabels) ?? DEFAULT_MAINTAINER_ONLY_LABELS,
      defaultLabelRepo: raw.defaultLabelRepo === true,
      // Default ON: only an explicit `false` disables the flag-then-close double-check.
      verifyBeforeClose: raw.verifyBeforeClose !== false,
      closeDelaySeconds: clampCloseDelaySeconds(raw.closeDelaySeconds),
    };
  } catch {
    // A KV outage must NEVER let a deterministic close fire — fail safe to all-off (the opposite of the
    // guardrail loader, which fails CLOSED: there a fault widens the manual-hold surface, here a fault must
    // not manufacture a close).
    return DEFAULT_LINKED_ISSUE_HARD_RULES;
  }
}

export type LinkedIssueFacts = {
  number: number;
  labels: string[];
  assignees: string[];
  state: string;
};

export type LinkedIssueHardRuleResult = {
  violated: boolean;
  reason: string | null;
};

const NO_VIOLATION: LinkedIssueHardRuleResult = { violated: false, reason: null };

function labelMatches(labels: string[], candidates: string[]): boolean {
  const wanted = new Set(candidates.map((c) => c.toLowerCase()));
  return labels.some((label) => wanted.has(label.toLowerCase()));
}

/**
 * PURE evaluator. Walks the linked OPEN issues (closed issues are ignored — a stale close-link never blocks a
 * PR) and returns on the FIRST hard-rule violation with a specific, cited reason naming the offending issue.
 * Only rules in `"block"` mode are evaluated; the missing-point-label rule additionally requires the repo to be
 * a default-label repo. Returns `{ violated: false, reason: null }` when nothing trips.
 */
export function evaluateLinkedIssueHardRules(input: {
  issues: LinkedIssueFacts[];
  config: LinkedIssueHardRulesConfig;
  repoOwner: string;
}): LinkedIssueHardRuleResult {
  const { config, repoOwner } = input;
  const ownerLower = repoOwner.toLowerCase();
  const anyRuleOn = config.ownerAssignedClose === "block" || config.missingPointLabelClose === "block" || config.maintainerOnlyLabelClose === "block";
  if (!anyRuleOn) return NO_VIOLATION;

  for (const issue of input.issues) {
    if (issue.state !== "open") continue;

    // Rule 1 — owner-assigned. The maintainer reserved this issue; a contributor PR for it can't be auto-accepted.
    if (config.ownerAssignedClose === "block" && ownerLower.length > 0 && issue.assignees.some((assignee) => assignee.toLowerCase() === ownerLower)) {
      return {
        violated: true,
        reason: `Linked issue #${issue.number} is assigned to the maintainer (@${repoOwner}) — that work is reserved for the maintainer, so this PR cannot be auto-accepted.`,
      };
    }

    // Rule 3 — maintainer-only label. Not open for community PRs.
    if (config.maintainerOnlyLabelClose === "block" && labelMatches(issue.labels, config.maintainerOnlyLabels)) {
      return {
        violated: true,
        reason: `Linked issue #${issue.number} is labeled \`maintainer-only\` — it is not open for community PRs.`,
      };
    }

    // Rule 2 — missing point-bearing label (default-label repos only). Not eligible for a scored contribution.
    if (config.missingPointLabelClose === "block" && config.defaultLabelRepo && !labelMatches(issue.labels, config.pointBearingLabels)) {
      return {
        violated: true,
        reason: `Linked issue #${issue.number} has no point-bearing label (needs one of gittensor:bug, gittensor:feature, gittensor:priority) — it is not eligible for a scored contribution.`,
      };
    }
  }

  return NO_VIOLATION;
}
