import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { StateActionButton } from "@/components/site/state-views";
import { cn, relativeTimeFromNow } from "@/lib/utils";

/**
 * Shared "last refresh Xm ago" label + manual refresh button for dashboard headers (#2219).
 * Renders nothing until the resource has loaded once (`loadedAt` is null while loading/error —
 * those states already have their own retry/refresh affordances in StateBoundary).
 */
export function RefreshMeta({
  loadedAt,
  onRefresh,
  refreshing = false,
  className,
}: {
  loadedAt: number | null;
  onRefresh: () => void;
  refreshing?: boolean;
  className?: string;
}) {
  // Re-render on a coarse tick so the relative label stays honest without a per-second timer.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  if (loadedAt === null) return null;

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <span className="font-mono text-token-2xs text-muted-foreground">
        last refresh {relativeTimeFromNow(loadedAt, now)}
      </span>
      <StateActionButton
        onClick={onRefresh}
        disabled={refreshing}
        icon={<RefreshCw className="size-3 shrink-0" aria-hidden />}
      >
        Refresh
      </StateActionButton>
    </div>
  );
}
