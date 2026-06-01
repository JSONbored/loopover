import { useEffect } from "react";
import { toast } from "sonner";

import { describeApiStatus, pingHealth, startHealthPolling, useApiStatus } from "@/lib/api/status";

function colorFor(status: string) {
  if (status === "ok") return "bg-mint";
  if (status === "degraded" || status === "timeout") return "bg-warning";
  if (status === "unreachable") return "bg-danger";
  return "bg-muted-foreground";
}

function shortLabel(status: string) {
  if (status === "ok") return "API healthy";
  if (status === "degraded") return "Degraded";
  if (status === "timeout") return "Timing out";
  if (status === "unreachable") return "Unreachable";
  if (status === "loading") return "Checking…";
  return "Status unknown";
}

export function HealthDot() {
  const { status, lastCheckedAt } = useApiStatus();

  useEffect(() => {
    const stop = startHealthPolling();
    return stop;
  }, []);

  const lastStr = lastCheckedAt
    ? new Date(lastCheckedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "never";

  return (
    <button
      type="button"
      onClick={() => {
        toast("Rechecking API…", { description: "Pinging /health now." });
        void pingHealth(true);
      }}
      title={`${describeApiStatus(status)} · last checked ${lastStr} · click to recheck`}
      aria-label={`${describeApiStatus(status)}, last checked ${lastStr}. Click to recheck.`}
      className="inline-flex items-center gap-2 rounded-full border border-border px-2.5 py-1 font-mono text-token-2xs text-muted-foreground transition-colors duration-150 hover:border-strong hover:text-foreground focus-ring motion-reduce:transition-none"
    >
      <span className={`size-1.5 rounded-full ${colorFor(status)}`} aria-hidden />
      {shortLabel(status)}
    </button>
  );
}
