import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { cn } from "@/lib/utils";
import { getApiOrigin } from "@/lib/api/origin";
import { apiFetch } from "@/lib/api/request";
import { Stat } from "@/components/site/control-primitives";
import {
  formatStatsAgo,
  formatTimeSaved,
  type PublicStats,
} from "@/components/site/proof-of-power-stats-model";

// Proof of Power (#1059): the above-the-fold homepage stats band. Polls the public, unauthenticated
// /v1/public/stats endpoint every 60s. The endpoint 404s until GITTENSORY_PUBLIC_STATS is enabled, so until then
// (or on any failure) this renders NOTHING — the homepage is byte-identical to today. Counts only; no PR content.

const intFmt = new Intl.NumberFormat("en");

async function fetchPublicStats(): Promise<PublicStats | null> {
  const result = await apiFetch<PublicStats>(`${getApiOrigin()}/v1/public/stats`, {
    label: "Gittensory stats",
    timeoutMs: 6000,
    silentStatus: true, // a disabled/missing public-stats endpoint must not poison the API status pill
  });
  // 404 (flag off) or any failure → render nothing rather than an error or misleading zeros.
  if (!result.ok || !result.data) return null;
  return result.data;
}

/** Count up to `target` once on mount (and on later increases), honoring prefers-reduced-motion. */
function useCountUp(target: number, durationMs = 900): number {
  const [value, setValue] = useState(0);
  const fromRef = useRef(0);
  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    const canAnimate =
      typeof requestAnimationFrame !== "undefined" &&
      (typeof document === "undefined" || document.visibilityState === "visible");
    if (reduce || target <= 0 || !canAnimate) {
      fromRef.current = target;
      setValue(target);
      return;
    }
    const from = fromRef.current;
    const start = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / durationMs);
      const eased = 1 - Math.pow(1 - p, 3);
      setValue(Math.round(from + (target - from) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = target;
    };
    raf = requestAnimationFrame(tick);
    // Safety net: rAF is throttled/never fires in a background tab, which would freeze the count at 0. Guarantee
    // the real number lands regardless after the animation window.
    const settle = window.setTimeout(() => {
      fromRef.current = target;
      setValue(target);
    }, durationMs + 250);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(settle);
    };
  }, [target, durationMs]);
  return value;
}

function Num({ value }: { value: number }) {
  const n = useCountUp(value);
  return <span className="font-mono tabular-nums">{intFmt.format(n)}</span>;
}

export function ProofOfPowerStats({ className }: { className?: string }) {
  const { data } = useQuery({
    queryKey: ["public-stats"],
    queryFn: fetchPublicStats,
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: false,
  });

  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  // Nothing to show until the endpoint is live with real data (keeps the homepage unchanged pre-launch).
  if (!data || data.totals.handled <= 0) return null;

  const { totals, weekly, byProject } = data;
  const repoCount = byProject.length;
  const timeSaved = formatTimeSaved(totals.minutesSaved);
  return (
    <section
      className={cn("mx-auto w-full max-w-6xl px-4 pb-2 sm:px-6", className)}
      aria-label="Live Gittensory stats"
    >
      <div className="mb-3 flex items-center gap-2 text-token-xs text-muted-foreground">
        <span aria-hidden className="size-1.5 rounded-full bg-coral motion-safe:animate-pulse" />
        Live — every PR Gittensory has handled
        <span className="ml-auto font-mono text-token-2xs uppercase tracking-wider">
          updated {formatStatsAgo(data.updatedAt, now)}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="PRs reviewed"
          value={<Num value={totals.reviewed} />}
          hint={`${intFmt.format(totals.merged)} merged across ${repoCount} repo${repoCount === 1 ? "" : "s"}${weekly.reviewed > 0 ? ` · +${intFmt.format(weekly.reviewed)} this week` : ""}`}
        />
        <Stat
          label="Filtered without merge"
          value={totals.filteredPct == null ? "—" : `${totals.filteredPct}%`}
          hint={`${intFmt.format(totals.reviewed - totals.merged)} closed, advised, or escalated`}
        />
        <Stat
          label="Maintainer time saved"
          value={
            <>
              <Num value={timeSaved.value} /> {timeSaved.unit}
            </>
          }
          hint="est. review time at ~20 min/PR"
        />
        <Stat
          label="Decision accuracy"
          value={totals.accuracyPct == null ? "—" : `${totals.accuracyPct}%`}
          hint={
            totals.reversed > 0
              ? `${intFmt.format(totals.reversed)} human-reversed`
              : "reversal-grounded"
          }
        />
      </div>
    </section>
  );
}
