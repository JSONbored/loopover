import { Link } from "@tanstack/react-router";
import { AlertCircle, AlertTriangle, RefreshCw, WifiOff, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { describeApiStatus, pingHealth, useApiStatus } from "@/lib/api/status";

type Severity = "warning" | "danger" | null;

function severityFor(status: string, connection: string): Severity {
  if (connection === "offline") return "danger";
  if (status === "unreachable") return "danger";
  if (status === "timeout" || status === "degraded" || status === "loading") return "warning";
  return null;
}

function labelFor(status: string, connection: string): string {
  if (connection === "offline") return "You're offline";
  if (status === "unreachable") return "API unreachable";
  if (status === "timeout") return "API timing out";
  if (status === "degraded") return "API degraded — some requests slow";
  if (status === "loading") return "Checking API status…";
  return describeApiStatus(status as never);
}

function IconFor({ severity, connection }: { severity: Severity; connection: string }) {
  if (connection === "offline") return <WifiOff className="size-4" aria-hidden />;
  if (severity === "danger") return <AlertCircle className="size-4" aria-hidden />;
  return <AlertTriangle className="size-4" aria-hidden />;
}

/**
 * Sticky API status banner that shows under the header when the Gittensory API
 * is anything other than fully healthy, or when the browser is offline.
 */
export function ApiStatusBanner() {
  const { status, connection, lastCheckedAt } = useApiStatus();
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [rechecking, setRechecking] = useState(false);

  const severity = severityFor(status, connection);
  const visibleKey = severity ? `${connection}:${status}` : null;
  const dismissed = visibleKey !== null && dismissedKey === visibleKey;

  // If status changes to a new failure mode, un-dismiss.
  useEffect(() => {
    if (visibleKey && dismissedKey && dismissedKey !== visibleKey) {
      setDismissedKey(null);
    }
  }, [visibleKey, dismissedKey]);

  if (!severity || dismissed) return null;

  const last = lastCheckedAt
    ? new Date(lastCheckedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "never";

  const tone =
    severity === "danger"
      ? "border-danger/40 bg-danger/10 text-danger"
      : "border-warning/40 bg-warning/10 text-warning-foreground";

  const linkTone = severity === "danger" ? "hover:text-danger" : "hover:text-foreground";

  const recheck = async () => {
    if (rechecking) return;
    setRechecking(true);
    toast("Rechecking API…", { id: "api:recheck", description: "Pinging /health now." });
    await pingHealth(true);
    setRechecking(false);
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "sticky top-14 z-30 border-b backdrop-blur transition-colors duration-150 motion-reduce:transition-none",
        tone,
      )}
    >
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 sm:px-6">
        <div className="flex min-w-0 items-center gap-2 text-token-xs font-medium">
          <IconFor severity={severity} connection={connection} />
          <span className="truncate">{labelFor(status, connection)}</span>
          {connection !== "offline" && (
            <span className="hidden text-muted-foreground sm:inline">· last checked {last}</span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-1">
          {connection !== "offline" && (
            <button
              type="button"
              onClick={recheck}
              disabled={rechecking}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-token border border-current/30 px-2 text-token-2xs font-medium transition-all duration-150 hover:bg-current/10 focus-ring motion-reduce:transition-none disabled:opacity-60",
              )}
            >
              <RefreshCw
                className={cn("size-3", rechecking && "animate-spin motion-reduce:animate-none")}
                aria-hidden
              />
              Recheck
            </button>
          )}
          <Link
            to="/docs/troubleshooting"
            hash="api-status"
            className={cn(
              "inline-flex h-7 items-center rounded-token px-2 text-token-2xs font-medium underline-offset-2 hover:underline focus-ring",
              linkTone,
            )}
          >
            Troubleshooting →
          </Link>
          <button
            type="button"
            onClick={() => visibleKey && setDismissedKey(visibleKey)}
            aria-label="Dismiss status banner"
            className="inline-flex h-7 w-7 items-center justify-center rounded-token text-current/80 hover:bg-current/10 hover:text-current focus-ring"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}
