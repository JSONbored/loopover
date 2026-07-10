import { Line, LineChart, ResponsiveContainer } from "recharts";

import type { TrendPoint } from "./proof-of-power-stats-model";

// Stat-tile sparkline (dataviz skill's "Figures" contract: "trend — optional; 12-point sparkline in the
// de-emphasis hue, current period in the accent"). No axes, gridlines, or tooltip -- a sparkline is the
// glanceable figure that rides beside a stat tile's own value, not a standalone chart; the exact numbers stay
// reachable from the value it sits next to and (for these two metrics) the public API response. A gap in the
// line (a null point, e.g. a week below its own minimum-sample floor) is the correct rendering for "not enough
// data yet" -- recharts breaks the segment there rather than drawing a fabricated straight line through it.

const SPARKLINE_WIDTH = 64;
const SPARKLINE_HEIGHT = 28;

export function Sparkline({
  points,
  color,
  className,
}: {
  points: TrendPoint[];
  color: string;
  className?: string;
}) {
  const hasAnyValue = points.some((point) => point.value !== null);
  if (!hasAnyValue) return null;
  const data = points.map((point, index) => ({ index, value: point.value }));
  const lastValueIndex = points.reduce(
    (last, point, index) => (point.value !== null ? index : last),
    -1,
  );
  return (
    <div
      className={className}
      style={{ width: SPARKLINE_WIDTH, height: SPARKLINE_HEIGHT }}
      role="img"
      aria-label={`Trend over the last ${points.length} weeks`}
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 2, right: 3, bottom: 2, left: 3 }}>
          <Line
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            dot={(props: { index?: number; cx?: number; cy?: number; key?: string }) => {
              const { index, cx, cy, key } = props;
              if (index !== lastValueIndex || cx === undefined || cy === undefined) {
                return <g key={key} />;
              }
              return (
                <circle
                  key={key}
                  cx={cx}
                  cy={cy}
                  r={2.5}
                  fill={color}
                  stroke="var(--background)"
                  strokeWidth={1}
                />
              );
            }}
            isAnimationActive={false}
            connectNulls={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
