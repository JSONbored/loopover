import type { AgentActionBlockerCategory, AgentActionExplanationCard, AgentActionRecord } from "../types";
import { PUBLIC_LOCAL_PATH_INLINE } from "../signals/redaction";

type AgentActionExplanationInput = Pick<
  AgentActionRecord,
  "actionType" | "status" | "why" | "scoreabilityImpact" | "riskImpact" | "maintainerImpact" | "blockedBy" | "rerunWhen" | "publicSafeSummary" | "safetyClass"
>;

const BLOCKER_CATEGORY_ORDER: AgentActionBlockerCategory[] = ["branch", "account", "queue", "scoreability", "risk", "maintainer", "unknown"];
const PUBLIC_FORBIDDEN_PATTERN =
  /\b(wallets?|hotkeys?|coldkeys?|seed phrases?|mnemonics?|raw[-_\s]?trust scores?|trust scores?|private reviewability|reviewability internals?|private scoreability|scoreability|projected scores?|score(?:d|s|ability)?|public score estimates?|estimated scores?|score estimates?|score previews?|reward estimates?|payouts?|farming|reward optimization|private rankings?)\b/gi;
const PUBLIC_SCORE_DELTA_PATTERN = /\b(?:projected\s+)?score\w*(?:\s+\w+){0,4}\s+[-+]?\d+(?:\.\d+)?\s*->\s*[-+]?\d+(?:\.\d+)?\b/gi;
// Token alternatives stay local; the local-path alternatives compose from the canonical PUBLIC_LOCAL_PATH_INLINE
// in redaction.ts (adds the previously-missed /root/ and /var/, plus the forward-slash Windows form C:/Users/).
const TOKEN_OR_PATH_PATTERN = new RegExp(`\\bgithub_pat_[A-Za-z0-9_]+|\\bgh[pousr]_[A-Za-z0-9_]+|(?:${PUBLIC_LOCAL_PATH_INLINE})\\S+`, "gi");

export function withAgentActionExplanationCard(action: AgentActionRecord): AgentActionRecord {
  return { ...action, explanationCard: buildAgentActionExplanationCard(action) };
}

export function buildAgentActionExplanationCard(action: AgentActionExplanationInput): AgentActionExplanationCard {
  const whyNow = compactText(whyNowForAction(action));
  const rerunWhen = compactText(action.rerunWhen ?? "Rerun when the referenced repo, branch, queue, or validation signal changes.");
  return {
    summary: compactText(summaryForAction(action)),
    whyNow,
    scoreabilityBlocker: compactText(scoreabilityBlockerForAction(action)),
    risk: compactText(action.riskImpact ?? riskForAction(action)),
    maintainerFriction: compactText(action.maintainerImpact ?? maintainerFrictionForAction(action)),
    expectedImpact: compactText(expectedImpactForAction(action)),
    blockerGroups: groupBlockers(action.blockedBy),
    rerunWhen,
    publicSafe: {
      summary: sanitizePublicCardText(action.publicSafeSummary || summaryForAction(action)),
      whyNow: sanitizePublicCardText(publicWhyNowForAction(action, whyNow)),
      rerunWhen: sanitizePublicCardText(rerunWhen),
    },
  };
}

function summaryForAction(action: AgentActionExplanationInput): string {
  if (action.actionType === "cleanup_existing_prs") return "Cleanup first: reduce existing PR pressure before starting new work.";
  if (action.actionType === "monitor_existing_pr") return "Wait on existing work: land, update, or close the current PR before adding more.";
  if (action.actionType === "preflight_branch") return "Preflight the branch: fix branch-level readiness before posting maintainer-facing context.";
  if (action.actionType === "explain_score_blockers") return "Resolve blockers: separate private scoreability context from public PR copy.";
  if (action.actionType === "prepare_pr_packet") return "Prepare public-safe PR text: turn private analysis into maintainer-friendly evidence.";
  if (action.actionType === "explain_repo_fit") return action.status === "watch" ? "Watch this repo: current signals argue against acting now." : "Explain repo fit: verify this lane before choosing work.";
  if (action.status === "watch") return "Avoid for now: wait for better repo, queue, or account signals.";
  return "Pursue now: this action is the current ranked next step.";
}

function whyNowForAction(action: AgentActionExplanationInput): string {
  if (action.actionType === "cleanup_existing_prs") return "Open PR pressure is the most actionable signal before new submissions.";
  if (action.actionType === "monitor_existing_pr") return "Existing work can affect scoreability and maintainer load before another action is useful.";
  if (action.actionType === "preflight_branch") return "Branch findings are directly actionable and should be fixed before public PR copy.";
  if (action.actionType === "explain_score_blockers") return "Blockers are gating the next useful step, so they should be handled before new work.";
  if (action.actionType === "prepare_pr_packet") return "A concise packet keeps public context focused on linked work, validation, and next steps.";
  if (action.status === "watch") return "The safer action is to wait until the blockers or queue signals improve.";
  return action.why.find((line) => line.trim().length > 0) ?? "Current deterministic planning signals rank this action ahead of other available next steps.";
}

function publicWhyNowForAction(action: AgentActionExplanationInput, whyNow: string): string {
  if (action.safetyClass === "public_safe") return whyNow;
  return action.publicSafeSummary || "Use the private card for planning and keep public output focused on review hygiene.";
}

function scoreabilityBlockerForAction(action: AgentActionExplanationInput): string {
  if (action.scoreabilityImpact) return action.scoreabilityImpact;
  const blockers = action.blockedBy.filter((blocker) => categorizeBlocker(blocker) === "scoreability");
  if (blockers.length > 0) return `Scoreability blockers: ${blockers.join(", ")}.`;
  if (action.status === "blocked") return "Blocked action; inspect the grouped blockers before proceeding.";
  return "No hard scoreability blocker is visible in current signals.";
}

function riskForAction(action: AgentActionExplanationInput): string {
  if (action.status === "watch") return "Acting now may add review load or collide with stronger repo signals.";
  if (action.actionType === "cleanup_existing_prs") return "Leaving existing PRs unresolved can increase stale or duplicate review pressure.";
  if (action.actionType === "prepare_pr_packet") return "Public copy should avoid private planning, scoring, or identity context.";
  return "No major action-specific risk is visible in the current card.";
}

function maintainerFrictionForAction(action: AgentActionExplanationInput): string {
  if (action.actionType === "cleanup_existing_prs") return "Cleanup reduces queue noise before asking maintainers to review new work.";
  if (action.actionType === "preflight_branch" || action.actionType === "prepare_pr_packet") return "Focused branch evidence makes review faster and less ambiguous.";
  if (action.status === "watch") return "Waiting avoids adding low-confidence work to the maintainer queue.";
  return "Narrow, validated work is easier for maintainers to review.";
}

function expectedImpactForAction(action: AgentActionExplanationInput): string {
  if (action.actionType === "cleanup_existing_prs") return "Lower active review pressure and make future work easier to score and review.";
  if (action.actionType === "monitor_existing_pr") return "Convert current open work into a clearer merged, closed, or updated state.";
  if (action.actionType === "preflight_branch") return "Move branch metadata toward a ready public-safe PR packet.";
  if (action.actionType === "explain_score_blockers") return "Turn blocker details into a concrete cleanup or wait condition.";
  if (action.actionType === "prepare_pr_packet") return "Produce maintainer-facing copy that excludes private planning context.";
  if (action.status === "watch") return "Avoid low-confidence effort until rerun conditions improve.";
  return "Advance toward one narrow, validated contribution path.";
}

function groupBlockers(blockers: string[]): AgentActionExplanationCard["blockerGroups"] {
  const grouped = new Map<AgentActionBlockerCategory, string[]>();
  for (const blocker of blockers.map((value) => compactText(value)).filter(Boolean)) {
    const category = categorizeBlocker(blocker);
    grouped.set(category, [...(grouped.get(category) ?? []), blocker]);
  }
  return BLOCKER_CATEGORY_ORDER.flatMap((category) => {
    const items = [...new Set(grouped.get(category) ?? [])].slice(0, 6);
    return items.length > 0 ? [{ category, items }] : [];
  });
}

function categorizeBlocker(blocker: string): AgentActionBlockerCategory {
  const value = blocker.toLowerCase();
  if (/branch|preflight|linked|issue|validation|test|draft|diff|file|metadata|eligib/.test(value)) return "branch";
  if (/account|credibility|contributor|official|miner|profile|role|author/.test(value)) return "account";
  if (/queue|open[_\s-]?pr|review|duplicate|collision|stale|approved|pending|merge|close/.test(value)) return "queue";
  if (/score|scoreability|inactive[_\s-]?allocation|allocation|gate|blocker/.test(value)) return "scoreability";
  if (/risk|reward|payout|farming|uncertain/.test(value)) return "risk";
  if (/maintainer|friction|intake|label|policy/.test(value)) return "maintainer";
  return "unknown";
}

function sanitizePublicCardText(value: string): string {
  return compactText(value)
    .replace(TOKEN_OR_PATH_PATTERN, "<redacted>")
    .replace(PUBLIC_SCORE_DELTA_PATTERN, "private context")
    .replace(PUBLIC_FORBIDDEN_PATTERN, "private context")
    .replace(/private context(?:[,\s]+private context)+/gi, "private context")
    .replace(/\s+([,.])/g, "$1")
    .trim();
}

function compactText(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim().slice(0, 300);
  // `slice(0, 300)` counts UTF-16 code units, so the 300-unit cap can fall between the high and low
  // halves of an astral character (an emoji) and leave a lone, unpaired high surrogate — invalid UTF-16
  // that renders as the replacement character and can break strict JSON/UTF-8 consumers of the API and
  // public-safe card text. Drop a dangling high surrogate so truncation never splits a pair.
  return /[\uD800-\uDBFF]$/.test(compact) ? compact.slice(0, -1) : compact;
}
