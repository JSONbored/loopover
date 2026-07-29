import { useMemo } from "react";

import { cn } from "@/lib/utils";

/**
 * Lightweight SVG line+area chart. No deps. Pure presentation.
 */
export function TrendChart({
  values,
  className,
  height = 80,
  stroke = "var(--mint)",
  fill = "color-mix(in oklab, var(--mint) 18%, transparent)",
  showAxis = false,
  label,
}: {
  values: ReadonlyArray<number | null>;
  className?: string;
  height?: number;
  stroke?: string;
  fill?: string;
  showAxis?: boolean;
  label: string;
}) {
  const { d, area, w } = useMemo(() => {
    const w = Math.max(values.length * 14, 120);
    const numeric = values.filter((v): v is number => v !== null);
    if (!numeric.length) return { d: "", area: "", w };
    const max = Math.max(...numeric, 1);
    const min = Math.min(...numeric, 0);
    const range = Math.max(max - min, 1);
    const step = w / Math.max(values.length - 1, 1);
    // A null breaks the polyline into a fresh sub-path (a new `M`) instead of connecting through it
    // -- a fabricated straight line would misrepresent a below-sample-floor gap as real data.
    const runs: Array<Array<readonly [number, number]>> = [];
    let prevIndex = -1;
    values.forEach((v, i) => {
      if (v === null) return;
      const x = i * step;
      const y = height - ((v - min) / range) * (height - 8) - 4;
      if (prevIndex === i - 1 && runs.length) {
        runs[runs.length - 1]?.push([x, y]);
      } else {
        runs.push([[x, y]]);
      }
      prevIndex = i;
    });
    const runPath = (pts: Array<readonly [number, number]>) =>
      pts
        .map(([x, y], i) =>
          i === 0 ? `M ${x.toFixed(1)} ${y.toFixed(1)}` : `L ${x.toFixed(1)} ${y.toFixed(1)}`,
        )
        .join(" ");
    const d = runs.map(runPath).join(" ");
    // Each contiguous run closes its own filled region -- a single area across the whole series
    // would draw a fill panel spanning the gap the line correctly leaves open.
    const area = runs
      .map((pts) => {
        const first = pts[0];
        const last = pts[pts.length - 1];
        if (!first || !last) return "";
        return `${runPath(pts)} L ${last[0].toFixed(1)} ${height} L ${first[0].toFixed(1)} ${height} Z`;
      })
      .join(" ");
    return { d, area, w };
  }, [values, height]);

  return (
    <svg
      viewBox={`0 0 ${w} ${height}`}
      preserveAspectRatio="none"
      className={cn("h-full w-full", className)}
      style={{ height }}
      role="img"
      aria-label={label}
    >
      {showAxis && (
        <line x1={0} x2={w} y1={height - 0.5} y2={height - 0.5} stroke="var(--border)" />
      )}
      <path d={area} fill={fill} />
      <path
        d={d}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
