import { BoundaryBadge, Stat, StatusPill } from "@/components/site/control-primitives";
import {
  calibrationBandRows,
  calibrationVerdictLabel,
  calibrationVerdictTone,
  type FleetOutcomeCalibration,
} from "@/components/site/calibration-card-model";

/**
 * Confidence-calibration card (#2192, part of #1967): predicted slop-severity band vs. realized merge
 * rate per bucket, plus the recommendation-outcome split, over the existing FleetOutcomeCalibration
 * payload. Renders nothing when there's no resolved-PR or recommendation signal yet (keeps the analytics
 * page clean until calibration data exists), matching GatePrecisionCard's convention on this same page.
 */
export function CalibrationCard({ calibration }: { calibration: FleetOutcomeCalibration }) {
  if (calibration.slop.totalResolved === 0 && calibration.recommendations.total === 0) return null;
  const rows = calibrationBandRows(calibration.slop);
  const resolvedRecommendations =
    calibration.recommendations.positive + calibration.recommendations.negative;

  return (
    <section className="rounded-token border border-border bg-transparent p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-token-lg font-semibold">Confidence calibration</h2>
          <p className="mt-1 text-token-xs text-muted-foreground">
            Predicted slop severity vs. realized merge rate per band — public-safe counts only.
          </p>
        </div>
        <BoundaryBadge boundary="private-api" />
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Stat
          label="Calibration signal"
          value={calibrationVerdictLabel(calibration.slop.discriminates)}
          hint={
            <StatusPill status={calibrationVerdictTone(calibration.slop.discriminates)}>
              {calibration.slop.totalResolved} resolved
            </StatusPill>
          }
        />
        <Stat
          label="Recommendation outcomes"
          value={
            calibration.recommendations.positiveRate !== null
              ? `${Math.round(calibration.recommendations.positiveRate * 100)}%`
              : "—"
          }
          hint={
            <span className="text-muted-foreground">
              {calibration.recommendations.positive}/{resolvedRecommendations} positive ·{" "}
              {calibration.recommendations.pending} pending
            </span>
          }
        />
      </div>

      <div className="mt-4 space-y-2">
        {rows.map((row) => (
          <div key={row.band} className="flex items-center gap-3">
            <span className="w-20 shrink-0 font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
              {row.label}
            </span>
            <div className="h-2 flex-1 overflow-hidden rounded-token bg-background/40">
              {row.mergeRatePercent !== null ? (
                <div
                  className="h-full rounded-token bg-mint/60"
                  style={{ width: `${row.mergeRatePercent}%` }}
                />
              ) : null}
            </div>
            <span className="w-24 shrink-0 text-right font-mono text-token-2xs text-muted-foreground">
              {row.mergeRatePercent !== null
                ? `${row.mergeRatePercent}% · n=${row.sampleSize}`
                : "no data"}
            </span>
          </div>
        ))}
      </div>

      {calibration.signals.length > 0 ? (
        <ul className="mt-4 space-y-1 text-token-xs text-muted-foreground">
          {calibration.signals.map((signal) => (
            <li key={signal}>{signal}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
