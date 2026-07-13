import { Callout } from "@/components/site/primitives";

// Cross-reference callout (#5191) pointing a dual-role self-hoster -- one running BOTH the ORB review
// service and the AMS miner on a single box -- from the operational/quickstart/workflow docs to the miner's
// own observability material, which otherwise has no in-app pointer from these three pages. Kept as one
// shared component (rendered by each route) so the wording and both link targets stay byte-identical across
// all three routes instead of relying on three hand-copied callouts staying in sync.

/** GitHub source link to the miner's "Observing your miner" observability guide (the C38 doc section, #5190). */
export const AMS_OBSERVABILITY_DOC_URL =
  "https://github.com/JSONbored/gittensory/blob/main/packages/gittensory-miner/docs/observability.md";

/** GitHub source link to the miner-usage Grafana dashboard JSON (the C37 dashboard, #5185). */
export const MINER_USAGE_DASHBOARD_URL =
  "https://github.com/JSONbored/gittensory/blob/main/grafana/dashboards/miner-usage.json";

/** Additive "see also" note that cross-links a dual-role operator to AMS observability setup + its dashboard. */
export function AmsObservabilityCallout() {
  return (
    <Callout variant="note" title="Also running the miner (AMS) on this box?">
      A dual-role self-hoster running both the ORB review service and the AMS miner can watch miner
      activity too: see{" "}
      <a href={AMS_OBSERVABILITY_DOC_URL} target="_blank" rel="noreferrer">
        Observing your miner
      </a>{" "}
      to point Grafana at redacted miner reporting exports, then load the{" "}
      <a href={MINER_USAGE_DASHBOARD_URL} target="_blank" rel="noreferrer">
        miner-usage.json dashboard
      </a>{" "}
      for attempt and prediction panels.
    </Callout>
  );
}
