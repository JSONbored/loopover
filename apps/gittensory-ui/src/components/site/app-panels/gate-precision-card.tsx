import { cn } from "@/lib/utils";
import { Stat, StatusPill } from "@/components/site/control-primitives";
import { aggregateGateEval, type GateEvalReport } from "./gate-precision-card-model";

// Documented sample-size floor: below this many decided predictions the confusion matrix is too noisy to read,
// so the card flags it via the StatusPill. Mirrors parity.ts's MIN_DECIDED_FOR_SIGNAL (which sets `hasSignal`).
const MIN_DECIDED_FLOOR = 10;

/** Self-host maintainer analytics card (#2191): gate merge-precision + the TP/FP/FN/TN confusion matrix from
 *  computeGateEval, read-only over the operator-dashboard payload. Renders nothing when there are no evaluated
 *  projects at all (keeps the analytics page clean until the gate has produced eval rows). */
export function GatePrecisionCard({ report }: { report: GateEvalReport }) {
  if (report.rows.length === 0) return null;
  const matrix = aggregateGateEval(report);
  return (
    <section className="rounded-token border border-border bg-transparent p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-token-lg font-semibold">Gate precision</h2>
          <p className="mt-1 text-token-xs text-muted-foreground">
            The gate's merge/close predictions scored against realized PR outcomes. Public-safe
            counts only.
          </p>
        </div>
        <StatusPill status={report.hasSignal ? "ready" : "warn"}>
          {report.hasSignal
            ? `${matrix.decided} decided`
            : `below ${MIN_DECIDED_FLOOR}-sample floor`}
        </StatusPill>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Stat
          label="Merge precision"
          value={
            matrix.mergePrecision !== null ? `${Math.round(matrix.mergePrecision * 100)}%` : "—"
          }
          hint={<span className="text-muted-foreground">P(merged | gate predicted merge)</span>}
        />
        <Stat
          label="Decided predictions"
          value={String(matrix.decided)}
          hint={<span className="text-muted-foreground">predictions with a known outcome</span>}
        />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <ConfusionCell
          label="True positive"
          detail="predicted merge → merged"
          value={matrix.truePositive}
          tone="text-success"
        />
        <ConfusionCell
          label="False positive"
          detail="predicted merge → closed"
          value={matrix.falsePositive}
          tone="text-danger"
        />
        <ConfusionCell
          label="False negative"
          detail="predicted close → merged"
          value={matrix.falseNegative}
          tone="text-warning"
        />
        <ConfusionCell
          label="True negative"
          detail="predicted close → closed"
          value={matrix.trueNegative}
          tone="text-success"
        />
      </div>
    </section>
  );
}

function ConfusionCell({
  label,
  detail,
  value,
  tone,
}: {
  label: string;
  detail: string;
  value: number;
  tone: string;
}) {
  return (
    <div className="rounded-token border border-border p-3">
      <div className={cn("font-mono text-token-lg font-medium", tone)}>{value}</div>
      <div className="text-token-xs text-foreground">{label}</div>
      <div className="text-token-2xs text-muted-foreground">{detail}</div>
    </div>
  );
}
