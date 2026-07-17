import { StatusPill, type Status } from "@/components/site/control-primitives";
import { TableScroll } from "@/components/site/data-table";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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

      <TableScroll
        className="rounded-token border-hairline"
        label="Context check readiness signals"
      >
        <Table className="text-left text-token-xs">
          <TableCaption className="sr-only">
            Readiness signals with their band, evidence, and recommended action.
          </TableCaption>
          <TableHeader className="border-b-hairline font-mono uppercase tracking-wider text-muted-foreground">
            <TableRow>
              <TableHead scope="col" className="px-3 py-2 font-normal">
                Signal
              </TableHead>
              <TableHead scope="col" className="px-3 py-2 font-normal">
                Band
              </TableHead>
              <TableHead scope="col" className="px-3 py-2 font-normal">
                Evidence
              </TableHead>
              <TableHead scope="col" className="hidden px-3 py-2 font-normal lg:table-cell">
                Action
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.components.map((row) => (
              <TableRow key={row.key} className="border-b-hairline last:border-b-0 align-top">
                <TableCell className="px-3 py-2 font-medium text-foreground">{row.label}</TableCell>
                <TableCell className="px-3 py-2">
                  <StatusPill status={COMPONENT_BAND_TONE[row.band]}>
                    {COMPONENT_BAND_LABEL[row.band]}
                  </StatusPill>
                </TableCell>
                <TableCell className="px-3 py-2 text-muted-foreground">{row.evidence}</TableCell>
                <TableCell className="hidden px-3 py-2 text-muted-foreground lg:table-cell">
                  {row.action}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableScroll>
    </section>
  );
}
