import { useEffect, useRef, useState } from "react";

const STEPS = [
  {
    label: "Current (gated)",
    value: 0.42,
    caption:
      "What the subnet would score right now. Blockers like unsquashed commits and a missing linked issue gate the upside.",
  },
  {
    label: "Underlying potential",
    value: 0.58,
    caption:
      "What the diff is actually worth on signal alone — once the gates are removed. Estimated only, never a guarantee.",
  },
  {
    label: "After clean-gate",
    value: 0.71,
    caption:
      "Project the score after the branch is squashed, rebased, and the open-PR queue is cleared. The biggest single move for most miners.",
  },
  {
    label: "After linked-issue fix",
    value: 0.83,
    caption:
      "Add a linked issue from the upstream backlog. Best reasonable case — every other signal stays where it is today.",
  },
];

export function ScoreabilityStory() {
  const [active, setActive] = useState(0);
  const refs = useRef<Array<HTMLLIElement | null>>([]);

  useEffect(() => {
    const observers = refs.current.map((el, idx) => {
      if (!el) return null;
      const io = new IntersectionObserver(
        ([e]) => {
          if (e.isIntersecting) setActive(idx);
        },
        { rootMargin: "-45% 0px -45% 0px", threshold: 0 },
      );
      io.observe(el);
      return io;
    });
    return () => observers.forEach((o) => o?.disconnect());
  }, []);

  const v = STEPS[active].value;

  return (
    <div className="grid gap-10 sm:grid-cols-[1fr_1.1fr] sm:gap-16">
      <div className="sm:sticky sm:top-14 sm:self-start sm:h-[calc(100vh-3.5rem)] sm:flex sm:flex-col sm:items-center sm:justify-center">
        <Gauge value={v} label={STEPS[active].label} />
        <p className="mt-3 max-w-[14rem] text-center text-token-xs text-muted-foreground leading-token-relaxed">
          Estimates only. LoopOver never shows raw trust scores or promises payouts.
        </p>
      </div>
      <ol className="space-y-24 sm:space-y-40">
        {STEPS.map((s, i) => (
          <li
            key={s.label}
            ref={(el) => {
              refs.current[i] = el;
            }}
            className="min-h-[40vh]"
          >
            <div className="font-mono text-token-2xs text-muted-foreground">
              0{i + 1} · {s.label}
            </div>
            <p className="mt-3 text-token-md text-foreground/90">{s.caption}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Gauge({ value, label }: { value: number; label: string }) {
  const pct = Math.max(0, Math.min(1, value));
  const r = 70;
  const c = 2 * Math.PI * r;
  const dash = c * pct;
  return (
    <div className="relative grid place-items-center">
      <svg viewBox="0 0 200 200" className="h-52 w-52">
        <defs>
          <linearGradient id="gauge-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--mint)" stopOpacity="0.95" />
            <stop offset="100%" stopColor="var(--mint)" stopOpacity="0.6" />
          </linearGradient>
          <filter id="gauge-glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="3" />
          </filter>
        </defs>
        <circle
          cx="100"
          cy="100"
          r={r}
          fill="none"
          stroke="color-mix(in oklab, var(--foreground) 10%, transparent)"
          strokeWidth="6"
        />
        <circle
          cx="100"
          cy="100"
          r={r}
          fill="none"
          stroke="url(#gauge-grad)"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c - dash}`}
          transform="rotate(-90 100 100)"
          style={{ transition: "stroke-dasharray 600ms cubic-bezier(.2,.7,.2,1)" }}
        />
      </svg>
      <div className="absolute text-center">
        <div className="font-mono text-token-2xs text-muted-foreground">scoreability</div>
        <div className="mt-1 font-display text-token-2xl tabular-nums text-foreground motion-reduce:transition-none">
          {pct.toFixed(2)}
        </div>
        <div className="mt-1 text-token-xs text-mint">{label}</div>
      </div>
    </div>
  );
}
