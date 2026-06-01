import { type ReactNode } from "react";

import { cn } from "@/lib/utils";

export type Status = "ready" | "degraded" | "stale" | "blocked" | "ok" | "warn" | "info";

const STATUS_STYLES: Record<Status, string> = {
  ready: "border-success/40 bg-success/10 text-success",
  ok: "border-success/40 bg-success/10 text-success",
  degraded: "border-warning/40 bg-warning/10 text-warning",
  warn: "border-warning/40 bg-warning/10 text-warning",
  stale: "border-warning/30 bg-warning/5 text-warning",
  blocked: "border-danger/40 bg-danger/10 text-danger",
  info: "border-mint/30 bg-mint/10 text-mint",
};

export function StatusPill({
  status,
  children,
  className,
}: {
  status: Status;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-token-2xs uppercase tracking-wider",
        STATUS_STYLES[status],
        className,
      )}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}

export type Boundary = "public" | "private-mcp" | "private-api";

export function BoundaryBadge({ boundary, className }: { boundary: Boundary; className?: string }) {
  const label =
    boundary === "public"
      ? "Public-safe"
      : boundary === "private-mcp"
        ? "Private · MCP"
        : "Private · API";
  const tone =
    boundary === "public"
      ? "border-success/40 bg-success/5 text-success"
      : "border-mint/30 bg-transparent text-mint";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-token border px-2 py-0.5 font-mono text-token-2xs uppercase tracking-wider",
        tone,
        className,
      )}
    >
      <span className="size-1 rounded-full bg-current" />
      {label}
    </span>
  );
}

const METHOD_STYLES: Record<string, string> = {
  GET: "bg-mint/15 text-mint border-mint/30",
  POST: "bg-aurora/15 text-foreground border-aurora/30",
  PUT: "bg-warning/15 text-warning border-warning/30",
  PATCH: "bg-warning/15 text-warning border-warning/30",
  DELETE: "bg-danger/15 text-danger border-danger/30",
};

export function MethodPill({ method, className }: { method: string; className?: string }) {
  const m = method.toUpperCase();
  return (
    <span
      className={cn(
        "inline-flex h-5 min-w-[44px] items-center justify-center rounded-token border px-1.5 font-mono text-token-2xs font-semibold tracking-wider",
        METHOD_STYLES[m] ?? "bg-muted text-muted-foreground border-border",
        className,
      )}
    >
      {m}
    </span>
  );
}

export function KeyValueGrid({
  rows,
  className,
}: {
  rows: Array<{ k: ReactNode; v: ReactNode }>;
  className?: string;
}) {
  return (
    <dl className={cn("grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-token-sm", className)}>
      {rows.map((r, i) => (
        <div key={i} className="contents">
          <dt className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
            {r.k}
          </dt>
          <dd className="text-foreground/90">{r.v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function DiffBlock({
  removed,
  added,
  className,
}: {
  removed: string[];
  added: string[];
  className?: string;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-token border border-border bg-[oklch(0.13_0.005_260)] font-mono text-[12px]",
        className,
      )}
    >
      {removed.map((l, i) => (
        <div
          key={`r${i}`}
          className="flex gap-2 border-l-2 border-danger/60 bg-danger/5 px-3 py-0.5 text-danger"
        >
          <span className="opacity-60">-</span>
          <span className="whitespace-pre">{l}</span>
        </div>
      ))}
      {added.map((l, i) => (
        <div
          key={`a${i}`}
          className="flex gap-2 border-l-2 border-success/60 bg-success/5 px-3 py-0.5 text-success"
        >
          <span className="opacity-60">+</span>
          <span className="whitespace-pre">{l}</span>
        </div>
      ))}
    </div>
  );
}

export function MiniSparkbar({ values, className }: { values: number[]; className?: string }) {
  const max = Math.max(1, ...values);
  return (
    <div className={cn("flex h-8 items-end gap-0.5", className)} aria-hidden>
      {values.map((v, i) => (
        <div
          key={i}
          className="w-1 rounded-token bg-mint/50"
          style={{ height: `${(v / max) * 100}%`, minHeight: 2 }}
        />
      ))}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-token border border-border p-4", className)}>
      <div className="text-token-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-token-xl font-medium tracking-tight text-foreground">{value}</div>
      {hint && <div className="mt-1 text-token-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}
