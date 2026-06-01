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
}: {
  values: number[];
  className?: string;
  height?: number;
  stroke?: string;
  fill?: string;
  showAxis?: boolean;
}) {
  const { d, area, w } = useMemo(() => {
    const w = Math.max(values.length * 14, 120);
    if (!values.length) return { d: "", area: "", w };
    const max = Math.max(...values, 1);
    const min = Math.min(...values, 0);
    const range = Math.max(max - min, 1);
    const step = w / Math.max(values.length - 1, 1);
    const pts = values.map((v, i) => {
      const x = i * step;
      const y = height - ((v - min) / range) * (height - 8) - 4;
      return [x, y] as const;
    });
    const d = pts
      .map(([x, y], i) =>
        i === 0 ? `M ${x.toFixed(1)} ${y.toFixed(1)}` : `L ${x.toFixed(1)} ${y.toFixed(1)}`,
      )
      .join(" ");
    const last = pts[pts.length - 1];
    const first = pts[0];
    const area = `${d} L ${last[0].toFixed(1)} ${height} L ${first[0].toFixed(1)} ${height} Z`;
    return { d, area, w };
  }, [values, height]);

  return (
    <svg
      viewBox={`0 0 ${w} ${height}`}
      preserveAspectRatio="none"
      className={cn("h-full w-full", className)}
      style={{ height }}
      role="img"
      aria-label="Trend chart"
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
