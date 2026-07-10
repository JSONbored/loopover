import { StatusPill, type Status } from "@/components/site/control-primitives";
import {
  COMPONENT_BAND_LABEL,
  READINESS_BAND_LABEL,
  resolveCheckRunReadinessView,
  type CheckRunDetailLevel,
  type CheckRunReadinessTableData,
  type ContributorReadinessBand,
  type ReadinessComponentBand,
} from "@/components/site/check-run-readiness-model";
import { cn } from "@/lib/utils";

const READINESS_BAND_TONE: Record<ContributorReadinessBand, Status> = {
  strong: "ready",
  developing: "warn",
  early: "info",
};

const COMPONENT_BAND_TONE: Record<ReadinessComponentBand, Status> = {
  met: "ready",
  partial: "warn",
  unmet: "blocked",
};

/**
 * Scannable readiness table for the Context check details page (#2216). Consumes the public-safe
 * band payload from settings-preview (`checkRunReadiness`); hidden below `standard` detail level.
 */
export function CheckRunReadinessTable({
  detailLevel,
  readiness,
  className,
}: {
  detailLevel: CheckRunDetailLevel | null | undefined;
  readiness: CheckRunReadinessTableData | null | undefined;
  className?: string;
}) {
  const view = resolveCheckRunReadinessView({ detailLevel, readiness });
  if (!view) return null;

  return (
    <section className={cn("space-y-3", className)} aria-labelledby="check-run-readiness-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3
            id="check-run-readiness-title"
            className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground"
          >
            Context check readiness
          </h3>
          <p className="mt-1 text-token-xs text-muted-foreground">
            Public-safe bands from the same readiness rubric as the PR panel — no raw scores.
          </p>
        </div>
        <StatusPill status={READINESS_BAND_TONE[view.readinessBand]}>
          {READINESS_BAND_LABEL[view.readinessBand]}
        </StatusPill>
      </div>

      <div className="overflow-hidden rounded-token border-hairline">
        <table className="w-full text-left text-token-xs">
          <thead className="border-b-hairline font-mono uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-normal">Signal</th>
              <th className="px-3 py-2 font-normal">Band</th>
              <th className="px-3 py-2 font-normal">Evidence</th>
              <th className="hidden px-3 py-2 font-normal lg:table-cell">Action</th>
            </tr>
          </thead>
          <tbody>
            {view.components.map((row) => (
              <tr key={row.key} className="border-b-hairline last:border-b-0 align-top">
                <td className="px-3 py-2 font-medium text-foreground">{row.label}</td>
                <td className="px-3 py-2">
                  <StatusPill status={COMPONENT_BAND_TONE[row.band]}>
                    {COMPONENT_BAND_LABEL[row.band]}
                  </StatusPill>
                </td>
                <td className="px-3 py-2 text-muted-foreground">{row.evidence}</td>
                <td className="hidden px-3 py-2 text-muted-foreground lg:table-cell">{row.action}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
