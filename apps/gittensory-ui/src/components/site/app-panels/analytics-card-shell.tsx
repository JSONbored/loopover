import type { ReactNode } from "react";

import { EmptyState } from "@/components/site/state-views";
import { Skeleton } from "@/components/ui/skeleton";

/** Shared analytics-card treatment (#2200): a titled card that renders one of three states — a skeleton
 *  shimmer while the metric loads, an EmptyState with a hint when it has no data, or its ready content — so
 *  every analytics card shares one loading/empty look instead of each re-inventing it. Presentational only:
 *  the caller decides the state from its own data. */
export type AnalyticsCardState = "loading" | "empty" | "ready";

export function AnalyticsCardShell({
  title,
  description,
  state,
  emptyTitle = "No data yet",
  emptyHint,
  children,
}: {
  title: string;
  description?: ReactNode;
  state: AnalyticsCardState;
  emptyTitle?: string;
  emptyHint?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="rounded-token border border-border bg-transparent p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-token-lg font-semibold">{title}</h2>
          {description ? (
            <p className="mt-1 text-token-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
      </div>

      {state === "loading" ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-3" aria-hidden>
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : state === "empty" ? (
        <EmptyState className="mt-4" title={emptyTitle} description={emptyHint} />
      ) : (
        <div className="mt-4">{children}</div>
      )}
    </section>
  );
}
