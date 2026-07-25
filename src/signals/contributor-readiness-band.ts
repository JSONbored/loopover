import type { PublicReadinessScore } from "./engine";

// Public-safe, banded PR-readiness payload for a contributor-facing surface (originally built for the
// browser-extension overlay, #556; now the Context-check-details page's readiness table, #2216, is the
// live consumer via settings-preview.ts's buildSampleCheckRunReadiness). Every payload here is PUBLIC-SAFE:
// numeric private scores are returned as BANDS never raw numbers, and all free-form text is re-checked
// against the forbidden-private-term list before it leaves the server.

/** Public-safe band for a contributor's own-PR readiness — the raw 0-100 readiness score is private; the
 *  overlay only ever sees the band. Mirrors the fit ("good"/"caution"/"hold") and slop band ideas. */
export type ContributorReadinessBand = "strong" | "developing" | "early";

export function contributorReadinessBand(total: number): ContributorReadinessBand {
  if (total >= 70) return "strong";
  if (total >= 45) return "developing";
  return "early";
}

// Defense-in-depth public-safe redaction for any free-form text that reaches a contributor-facing surface.
// The upstream builders are already contributor-facing, but every string is re-checked here and any
// forbidden private term (reward/wallet/key material/raw trust score/etc.) is redacted rather than
// leaked. Kept local (no import) so this module stays cycle-free and never 500s on a stray term.
// The bare `cohort`/`ranking`/`miner-originated`/`human-originated`/`reviewability` alternatives (and the
// `[-_\s]?` separator on the originated pair) mirror src/signals/redaction.ts's canonical PUBLIC_UNSAFE_TERMS
// so this overlay stops leaking economic-identity terms that surface drifted away from (#5840). The compound
// `reviewability` terms stay ordered before the bare word so "reviewability internals"/"private reviewability"
// still match as a whole. Kept hand-synced (no import) so this module stays cycle-free; a drift-guard test
// (contributor-readiness-band.test.ts) fails if these diverge from PUBLIC_UNSAFE_TERMS again.
const FORBIDDEN_PRIVATE_TERMS =
  /\b(?:rewards?|payouts?|farming|wallets?|hotkeys?|coldkeys?|seed[-\s]?phrases?|mnemonics?|private[-\s]?keys?|raw[-\s]?trust(?:[-\s]?scores?)?|trust[-\s]?scores?|score[-\s]?(?:estimate|preview|prediction)s?|estimated[-\s]?scores?|scoreability|cohort\w*|ranking\w*|miner[-_\s]?originated|human[-_\s]?originated|private[-\s]?reviewability|reviewability[-\s]?internals?|reviewability|private[-\s]?rankings?)\b/gi;

export function redactContributorText(text: string): string {
  return text.replace(FORBIDDEN_PRIVATE_TERMS, "[redacted]").replace(/\s+/g, " ").trim();
}

// ── own-PR preflight + review status ──────────────────────────────────────────────────────────────

/** Per-readiness-component band, so the overlay can render a checklist without seeing component scores. */
export type ReadinessComponentBand = "met" | "partial" | "unmet";

export type ContributorPrStatusComponent = {
  key: PublicReadinessScore["components"][number]["key"];
  label: string;
  band: ReadinessComponentBand;
  evidence: string;
  action: string;
};

export type ContributorPrStatus = {
  repoFullName: string;
  pullNumber: number;
  /** Overall readiness band — the raw total is never exposed. */
  readinessBand: ContributorReadinessBand;
  reviewStatus: "ready_for_review" | "in_progress" | "needs_attention";
  components: ContributorPrStatusComponent[];
};

function componentBand(score: number, max: number): ReadinessComponentBand {
  if (max <= 0) return "unmet";
  const ratio = score / max;
  if (ratio >= 0.85) return "met";
  // Mirror the readiness rubric's ⚠️ cutoff (scoreResultIcon in engine.ts: ratio >= 0.45). A stricter 0.5 here
  // showed a component scored in [0.45, 0.5) as fully "unmet" in the overlay while the maintainer-facing
  // readiness table rendered the same component as ⚠️ (partial) — the two surfaces must agree on the same score.
  if (ratio >= 0.45) return "partial";
  return "unmet";
}

export function buildContributorPrStatus(args: { repoFullName: string; pullNumber: number; readiness: PublicReadinessScore }): ContributorPrStatus {
  const band = contributorReadinessBand(args.readiness.total);
  const reviewStatus = band === "strong" ? "ready_for_review" : band === "developing" ? "in_progress" : "needs_attention";
  return {
    repoFullName: args.repoFullName,
    pullNumber: args.pullNumber,
    readinessBand: band,
    reviewStatus,
    components: args.readiness.components.map((component) => ({
      key: component.key,
      label: redactContributorText(component.label),
      band: componentBand(component.score, component.max),
      evidence: redactContributorText(component.evidence),
      action: redactContributorText(component.action),
    })),
  };
}
