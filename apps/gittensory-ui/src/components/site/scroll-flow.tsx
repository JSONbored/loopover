import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface FlowStep {
  k: string;
  title: string;
  body: string;
  code?: string;
  icon?: ReactNode;
}

/**
 * Vertical scroll-linked flow: as the user scrolls, the step closest to the
 * viewport midline becomes the highlighted one. Static-export safe.
 */
export function ScrollFlow({ steps, className }: { steps: FlowStep[]; className?: string }) {
  const [active, setActive] = useState(0);
  const refs = useRef<Array<HTMLLIElement | null>>([]);

  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible) {
          const idx = refs.current.findIndex((el) => el === visible.target);
          if (idx >= 0) setActive(idx);
        }
      },
      { rootMargin: "-40% 0px -40% 0px", threshold: [0.25, 0.5, 0.75] },
    );
    refs.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, [steps.length]);

  return (
    <div className={cn("grid gap-10 lg:grid-cols-[1fr_1fr] lg:items-start", className)}>
      <ol className="relative space-y-12 border-l border-border pl-8">
        {steps.map((s, i) => (
          <li
            key={s.k}
            ref={(el) => {
              refs.current[i] = el;
            }}
            className="relative"
          >
            <span
              className={cn(
                "absolute -left-[37px] top-1.5 flex size-6 items-center justify-center rounded-full border font-mono text-token-2xs transition-all",
                active === i
                  ? "border-mint bg-mint text-primary-foreground"
                  : "border-border bg-card text-muted-foreground",
              )}
            >
              {i + 1}
            </span>
            <h3
              className={cn(
                "font-display text-token-lg font-semibold tracking-tight transition-colors",
                active === i ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {s.title}
            </h3>
            <p className="mt-1.5 text-token-sm text-muted-foreground">{s.body}</p>
          </li>
        ))}
      </ol>

      <div className="sticky top-24 hidden lg:block">
        <div className="overflow-hidden rounded-token border border-border bg-transparent p-2">
          <div className="rounded-token bg-[oklch(0.13_0.02_260)] p-4 font-mono text-[12px] text-foreground/90">
            <div className="mb-2 flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-mint" />
              <span className="text-token-2xs uppercase tracking-wider text-muted-foreground">
                step {active + 1} / {steps.length}
              </span>
            </div>
            <motion.pre
              key={active}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35 }}
              className="whitespace-pre-wrap"
            >
              {steps[active].code ?? steps[active].body}
            </motion.pre>
          </div>
        </div>
      </div>
    </div>
  );
}
