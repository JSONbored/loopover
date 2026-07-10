// Check-run details-page readiness table model (#2216). Pure helpers + types for the Context check
// details slice — mirrors the public-safe band shape from buildExtensionPrStatus (src/signals/
// extension-contributor-context.ts) so the UI never renders raw readiness scores.

export type CheckRunDetailLevel = "minimal" | "standard" | "deep";

export type ReadinessComponentBand = "met" | "partial" | "unmet";

export type ContributorReadinessBand = "strong" | "developing" | "early";

export type CheckRunReadinessRow = {
  key: string;
  label: string;
  band: ReadinessComponentBand;
  evidence: string;
  action: string;
};

export type CheckRunReadinessTableData = {
  readinessBand: ContributorReadinessBand;
  components: CheckRunReadinessRow[];
};

/** Context check details publish the readiness table only at standard/deep detail levels. */
export function shouldShowCheckRunReadinessTable(detailLevel: CheckRunDetailLevel): boolean {
  return detailLevel !== "minimal";
}

/** Gate the table on detail level AND the presence of readiness rows (empty set → hide). */
export function resolveCheckRunReadinessView(args: {
  detailLevel: CheckRunDetailLevel | null | undefined;
  readiness: CheckRunReadinessTableData | null | undefined;
}): CheckRunReadinessTableData | null {
  if (!args.detailLevel || !shouldShowCheckRunReadinessTable(args.detailLevel)) return null;
  if (!args.readiness || args.readiness.components.length === 0) return null;
  return args.readiness;
}

export const READINESS_BAND_LABEL: Record<ContributorReadinessBand, string> = {
  strong: "Strong",
  developing: "Developing",
  early: "Early",
};

export const COMPONENT_BAND_LABEL: Record<ReadinessComponentBand, string> = {
  met: "Met",
  partial: "Partial",
  unmet: "Unmet",
};
