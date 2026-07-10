import { MiniSparkbar, Stat, StatusPill } from "@/components/site/control-primitives";
import {
  formatMergeRate,
  formatSlopBandLabel,
  type SlopBandCalibration,
} from "@/components/site/app-panels/slop-band-calibration-card-model";

/** Analytics card (#2196): slop-band predicted severity vs realized merge/close outcomes from the stats feed.
 *  Renders band labels and aggregate rates only — never raw slop scores. */
export function SlopBandCalibrationCard({ calibration }: { calibration: SlopBandCalibration }) {
  const hasSamples = calibration.totalResolved > 0;
  const statusTone =
    calibration.discriminates === true
      ? "ready"
      : calibration.discriminates === false
        ? "warn"
        : "info";
  const statusLabel =
    calibration.discriminates === true
      ? "predictive"
      : calibration.discriminates === false
        ? "not discriminating"
        : hasSamples
          ? "insufficient per-band sample"
          : "no samples yet";

  return (
    <section className="rounded-token border border-border bg-transparent p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-token-lg font-semibold">Slop-band calibration</h2>
          <p className="mt-1 text-token-xs text-muted-foreground">
            Predicted slop band vs realized merge/close outcomes for resolved pull requests.
            Public-safe band counts only.
          </p>
        </div>
        <StatusPill status={statusTone}>{statusLabel}</StatusPill>
      </div>

      {hasSamples ? (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {calibration.bands.map((band) => (
              <Stat
                key={band.band}
                label={formatSlopBandLabel(band.band)}
                value={formatMergeRate(band.mergeRate, band.sampleSize)}
                hint={
                  <span className="text-muted-foreground">
                    {band.sampleSize} assessed · {band.merged} merged · {band.closed} closed
                  </span>
                }
                trend={
                  band.sampleSize > 0 ? (
                    <MiniSparkbar values={[band.merged, band.closed]} className="w-12" />
                  ) : undefined
                }
              />
            ))}
          </div>
          {calibration.overallMergeRate !== null ? (
            <p className="mt-3 text-token-xs text-muted-foreground">
              Overall merge rate across assessed bands:{" "}
              {Math.round(calibration.overallMergeRate * 100)}%
            </p>
          ) : null}
        </>
      ) : (
        <p className="mt-4 text-token-sm text-muted-foreground">
          Resolved pull requests with a persisted slop band will appear here once the gate has
          enough outcome history in the analytics window.
        </p>
      )}
    </section>
  );
}
