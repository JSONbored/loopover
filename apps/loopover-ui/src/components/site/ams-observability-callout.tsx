import { Link } from "@tanstack/react-router";

import { Callout } from "@/components/site/primitives";

// AMS (loopover-miner) observability cross-reference (#5191). A dual-role self-hoster running both ORB (the
// review service) and AMS (the miner) on one box otherwise has no in-app pointer from the operations / quickstart /
// workflow docs to the miner's observability setup. Keeping the callout — and its link target — in one place keeps
// the wording byte-identical across all three routes instead of relying on three hand-copied copies staying in sync.
//
// The target is the "Observing your miner" guide: the single AMS observability entry point, which covers pointing
// Grafana at the redacted AMS ledger datasources AND loading an AMS dashboard from grafana/dashboards/. It now has
// its own in-app /docs/ams-observability route (#6024, ported from the source packages/loopover-miner/docs/observability.md
// this constant used to point at directly) -- an in-app Link keeps the reader on the docs site instead of bouncing
// to GitHub.
export const AMS_OBSERVABILITY_DOC_SLUG = "ams-observability";

/** A `note` callout pointing a dual-role ORB+AMS operator at the "Observing your miner" observability guide. */
export function AmsObservabilityCallout() {
  return (
    <Callout variant="note" title="Running the miner on this box too?">
      If you also run <strong>AMS</strong> (the <code>loopover-miner</code>) on this host, see{" "}
      <Link to="/docs/$slug" params={{ slug: AMS_OBSERVABILITY_DOC_SLUG }}>
        Observing your miner
      </Link>{" "}
      to point Grafana at the redacted AMS ledger datasources and load its Grafana dashboard —
      separate from the ORB review-service observability above.
    </Callout>
  );
}
