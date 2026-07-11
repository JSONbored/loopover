import {
  BoundaryBadge,
  MiniSparkbar,
  Stat,
  StatusPill,
} from "@/components/site/control-primitives";
import { TrendChart } from "@/components/site/trend-chart";
import {
  calibrationHasSamples,
  calibrationStatus,
  calibrationTrendValues,
  formatConfidencePct,
  type GateCalibration,
} from "@/components/site/app-panels/calibration-card-model";

/** Analytics card (#2192): confidence-vs-outcome calibration curve from computeCalibration — predicted merge
 *  confidence bands vs realized kept-rate, plus the recommended confidence floor. Read-only. */
export function CalibrationCard({ calibration }: { calibration: GateCalibration }) {
  const status = calibrationStatus(calibration);
  const hasSamples = calibrationHasSamples(calibration);
  const trendValues = calibrationTrendValues(calibration.bins);

  return (
    <section className="rounded-token border border-border bg-transparent p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-token-lg font-semibold">Confidence calibration</h2>
          <p className="mt-1 text-token-xs text-muted-foreground">
            Predicted merge confidence vs realized kept-rate per bucket. Public-safe aggregate
            counts only.
          </p>
        </div>
        <StatusPill status={status.tone}>{status.label}</StatusPill>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Current floor"
          value={formatConfidencePct(calibration.currentFloor)}
          hint={<span className="text-muted-foreground">configured confidenceFloor</span>}
        />
        <Stat
          label="Recommended floor"
          value={formatConfidencePct(calibration.recommendedFloor)}
          hint={
            <span className="inline-flex items-center gap-2 text-muted-foreground">
              from reverted merges
              <BoundaryBadge boundary="private-api" />
            </span>
          }
        />
        <Stat
          label="Auto-merges"
          value={String(calibration.mergedCount)}
          hint={<span className="text-muted-foreground">terminal merged targets</span>}
        />
        <Stat
          label="Reverted merges"
          value={String(calibration.revertedCount)}
          hint={<span className="text-muted-foreground">human-reverted bot merges</span>}
        />
      </div>

      {hasSamples ? (
        <>
          <div className="mt-4 rounded-token border border-border bg-background/40 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-token-xs text-muted-foreground">
              <span>Kept-rate curve by confidence band</span>
              <span className="font-mono text-mint">
                avg kept {formatConfidencePct(calibration.keptAvgConfidence)}
              </span>
            </div>
            <div className="mt-3 h-24 w-full">
              <TrendChart values={trendValues} height={96} showAxis />
            </div>
          </div>

          <div className="mt-4 space-y-2">
            {calibration.bins.map((bin) => (
              <div
                key={bin.label}
                className="flex flex-wrap items-center justify-between gap-3 rounded-token border border-border bg-background/40 px-3 py-2 text-token-sm"
              >
                <div className="min-w-0">
                  <div className="font-mono text-token-xs text-foreground">{bin.label}</div>
                  <div className="text-token-2xs text-muted-foreground">
                    predicted band · {bin.sampleSize} sample{bin.sampleSize === 1 ? "" : "s"}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <div className="font-mono text-token-xs text-mint">
                      {formatConfidencePct(bin.keptRate)}
                    </div>
                    <div className="text-token-2xs text-muted-foreground">actual kept</div>
                  </div>
                  {bin.sampleSize > 0 ? (
                    <MiniSparkbar values={[bin.keptCount, bin.revertedCount]} className="w-10" />
                  ) : (
                    <span className="text-token-xs text-muted-foreground">—</span>
                  )}
                </div>
              </div>
            ))}
          </div>

          <p className="mt-3 text-token-xs text-muted-foreground">{calibration.note}</p>
        </>
      ) : (
        <p className="mt-4 text-token-sm text-muted-foreground">
          Merge-confidence calibration bins appear once the gate has auto-merged pull requests with
          persisted confidence scores.
        </p>
      )}
    </section>
  );
}
