import type { ContributorOpportunity, PublicReadinessScore } from "./engine";

// ─── Contributor-context payloads for the browser extension (#556) ───────────────────────────────
// The contributor (miner) side of the extension overlay. Every payload here is PUBLIC-SAFE and self-
// scoped: a miner token reads only its OWN data (enforced at the route via requireContributorAccess),
// numeric private scores are returned as BANDS never raw numbers, and all free-form text is re-checked
// against the forbidden-private-term list before it leaves the server. No UI — just the data shapes the
// rebuilt extension (and any client) renders.

/** Public-safe band for a contributor's own-PR readiness — the raw 0-100 readiness score is private; the
 *  overlay only ever sees the band. Mirrors the fit ("good"/"caution"/"hold") and slop band ideas. */
export type ContributorReadinessBand = "strong" | "developing" | "early";

export function contributorReadinessBand(total: number): ContributorReadinessBand {
  if (total >= 70) return "strong";
  if (total >= 45) return "developing";
  return "early";
}

// Defense-in-depth public-safe redaction for any free-form text that reaches the contributor overlay.
// The upstream builders are already contributor-facing, but every string is re-checked here and any
// forbidden private term (reward/wallet/key material/raw trust score/etc.) is redacted rather than
// leaked. Kept local (no import) so this module stays cycle-free and the API never 500s on a stray term.
const FORBIDDEN_EXTENSION_TERMS =
  /\b(?:rewards?|payouts?|farming|wallets?|hotkeys?|coldkeys?|seed[-\s]?phrases?|mnemonics?|private[-\s]?keys?|raw[-\s]?trust(?:[-\s]?scores?)?|trust[-\s]?scores?|score[-\s]?(?:estimate|preview|prediction)s?|estimated[-\s]?scores?|scoreability|private[-\s]?reviewability|reviewability[-\s]?internals?|private[-\s]?rankings?)\b/gi;

export function redactExtensionText(text: string): string {
  return text.replace(FORBIDDEN_EXTENSION_TERMS, "[redacted]").replace(/\s+/g, " ").trim();
}

// ── issue-fit: "is this issue a good one for me to pick up?" ──────────────────────────────────────

export type ExtensionIssueFit = {
  repoFullName: string;
  issueNumber: number;
  title: string;
  /** Fit band — already a band on the opportunity, never a raw score. */
  fit: ContributorOpportunity["fit"];
  multiplierTier: ContributorOpportunity["multiplierTier"];
  availability: ContributorOpportunity["availability"];
  lane: ContributorOpportunity["lane"];
  reasons: string[];
  warnings: string[];
};

export function buildExtensionIssueFit(opportunity: ContributorOpportunity): ExtensionIssueFit {
  return {
    repoFullName: opportunity.repoFullName,
    issueNumber: opportunity.issueNumber ?? 0,
    title: redactExtensionText(opportunity.title),
    fit: opportunity.fit,
    multiplierTier: opportunity.multiplierTier,
    availability: opportunity.availability,
    lane: opportunity.lane,
    reasons: opportunity.reasons.map(redactExtensionText),
    warnings: opportunity.warnings.map(redactExtensionText),
  };
}

// ── issue-list badges: per-issue fit badges for an issue-list overlay ─────────────────────────────

export type ExtensionIssueBadge = {
  issueNumber: number;
  title: string;
  fit: ContributorOpportunity["fit"];
  multiplierTier: ContributorOpportunity["multiplierTier"];
  availability: ContributorOpportunity["availability"];
};

export function buildExtensionIssueBadges(opportunities: ContributorOpportunity[], repoFullName: string): ExtensionIssueBadge[] {
  return opportunities
    .filter((opportunity) => opportunity.repoFullName.toLowerCase() === repoFullName.toLowerCase() && opportunity.issueNumber !== undefined)
    .map((opportunity) => ({
      issueNumber: opportunity.issueNumber as number,
      title: redactExtensionText(opportunity.title),
      fit: opportunity.fit,
      multiplierTier: opportunity.multiplierTier,
      availability: opportunity.availability,
    }));
}

// ── own-PR preflight + review status ──────────────────────────────────────────────────────────────

/** Per-readiness-component band, so the overlay can render a checklist without seeing component scores. */
export type ExtensionReadinessComponentBand = "met" | "partial" | "unmet";

export type ExtensionPrStatusComponent = {
  key: PublicReadinessScore["components"][number]["key"];
  label: string;
  band: ExtensionReadinessComponentBand;
  evidence: string;
  action: string;
};

export type ExtensionPrStatus = {
  repoFullName: string;
  pullNumber: number;
  /** Overall readiness band — the raw total is never exposed. */
  readinessBand: ContributorReadinessBand;
  reviewStatus: "ready_for_review" | "in_progress" | "needs_attention";
  components: ExtensionPrStatusComponent[];
};

function componentBand(score: number, max: number): ExtensionReadinessComponentBand {
  if (max <= 0) return "unmet";
  const ratio = score / max;
  if (ratio >= 0.85) return "met";
  if (ratio >= 0.5) return "partial";
  return "unmet";
}

export function buildExtensionPrStatus(args: { repoFullName: string; pullNumber: number; readiness: PublicReadinessScore }): ExtensionPrStatus {
  const band = contributorReadinessBand(args.readiness.total);
  const reviewStatus = band === "strong" ? "ready_for_review" : band === "developing" ? "in_progress" : "needs_attention";
  return {
    repoFullName: args.repoFullName,
    pullNumber: args.pullNumber,
    readinessBand: band,
    reviewStatus,
    components: args.readiness.components.map((component) => ({
      key: component.key,
      label: redactExtensionText(component.label),
      band: componentBand(component.score, component.max),
      evidence: redactExtensionText(component.evidence),
      action: redactExtensionText(component.action),
    })),
  };
}
