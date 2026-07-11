import { AnalyticsCardShell } from "@/components/site/app-panels/analytics-card-shell";
import { StatusPill, type Status } from "@/components/site/control-primitives";
import { cn } from "@/lib/utils";

/** Slop-band calibration (#2196): per-band merge/close rates over resolved PRs that carry a persisted slop band —
 *  is the deterministic slop score predictive (do higher-slop bands merge less)? Display slice over the
 *  operator-dashboard's `slopCalibration` payload. Bands only, never raw scores (public/private boundary). */
export type SlopBand = "clean" | "low" | "elevated" | "high";

export type SlopBandCalibration = {
  band: SlopBand;
  sampleSize: number;
  merged: number;
  closed: number;
  mergeRate: number;
};

export type SlopOutcomeCalibration = {
  totalResolved: number;
  bands: SlopBandCalibration[];
  overallMergeRate: number | null;
  discriminates: boolean | null;
};

/** clean → high reads low-to-high severity; the bar color tracks band severity. */
const BAND_BAR: Record<SlopBand, string> = {
  clean: "bg-success",
  low: "bg-mint",
  elevated: "bg-warning",
  high: "bg-danger",
};

function discriminationPill(discriminates: boolean | null): { status: Status; label: string } {
  if (discriminates === true) return { status: "ready", label: "predictive" };
  if (discriminates === false) return { status: "degraded", label: "inverted" };
  return { status: "info", label: "insufficient data" };
}

function BandRow({ row }: { row: SlopBandCalibration }) {
  const hasSamples = row.sampleSize > 0;
  const pct = hasSamples ? Math.round(row.mergeRate * 100) : null;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3 text-token-sm">
        <span className="font-medium capitalize text-foreground">{row.band}</span>
        <span className="font-mono text-token-xs text-muted-foreground">
          {pct === null ? "— no samples" : `${pct}% merged`}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-border" aria-hidden>
        {hasSamples ? (
          <div className={cn("h-full", BAND_BAR[row.band])} style={{ width: `${pct}%` }} />
        ) : null}
      </div>
      <div className="font-mono text-token-2xs text-muted-foreground">
        {row.sampleSize} resolved · {row.merged} merged · {row.closed} closed
      </div>
    </div>
  );
}

export function SlopBandCalibrationCard({ calibration }: { calibration?: SlopOutcomeCalibration }) {
  const hasData =
    calibration != null && calibration.totalResolved > 0 && calibration.bands.length > 0;

  if (!hasData) {
    return (
      <AnalyticsCardShell
        title="Slop-band calibration"
        description="Predicted slop band vs realized merge/close outcome, across resolved PRs."
        state="empty"
        emptyTitle={calibration ? "No resolved PRs with a slop band" : "Not yet available"}
        emptyHint={
          calibration
            ? "Calibration appears once resolved PRs carry a persisted slop band in the window."
            : "Slop-band calibration appears once the payload includes resolved-PR slop bands."
        }
      />
    );
  }

  const pill = discriminationPill(calibration.discriminates);
  const overall =
    calibration.overallMergeRate === null ? null : Math.round(calibration.overallMergeRate * 100);

  return (
    <AnalyticsCardShell
      title="Slop-band calibration"
      description="Predicted slop band vs realized merge/close outcome, across resolved PRs."
      state="ready"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-token-2xs text-muted-foreground">
          {calibration.totalResolved} resolved
          {overall === null ? "" : ` · ${overall}% merged overall`}
        </span>
        <StatusPill status={pill.status}>{pill.label}</StatusPill>
      </div>
      <div className="mt-3 space-y-4">
        {calibration.bands.map((row) => (
          <BandRow key={row.band} row={row} />
        ))}
      </div>
    </AnalyticsCardShell>
  );
}
