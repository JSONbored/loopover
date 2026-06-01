import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowRight,
  Activity,
  BarChart3,
  Check,
  Circle,
  FolderGit2,
  PlayCircle,
  RefreshCw,
  Sparkles,
  TerminalSquare,
  Wrench,
  Workflow,
  X,
} from "lucide-react";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

import { StatusPill } from "@/components/site/control-primitives";
import { PageHeader } from "@/components/site/primitives";
import { TrendChart } from "@/components/site/trend-chart";
import { useSession } from "@/lib/api/session";
import { useApiResource } from "@/lib/api/use-api-resource";
import { describeApiStatus, pingHealth, useApiStatus } from "@/lib/api/status";
import { useLocalStorage } from "@/lib/use-local-storage";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/")({
  component: AppOverview,
});

const CARDS = [
  {
    to: "/app/workbench",
    title: "Workbench",
    desc: "Plan next work, preflight branches, preview maintainer commands, and inspect digests.",
    icon: Workflow,
  },
  {
    to: "/app/repos",
    title: "Repositories",
    desc: "Maintainer console, install health, and registration readiness for repo owners.",
    icon: FolderGit2,
  },
  {
    to: "/app/runs",
    title: "Agent runs",
    desc: "Unified feed of MCP, API, and @gittensory runs with evidence and boundary tags.",
    icon: Activity,
  },
  {
    to: "/app/analytics",
    title: "Analytics",
    desc: "Adoption, command usage, and noise-reduction trends across deployments.",
    icon: BarChart3,
  },
  {
    to: "/app/operator",
    title: "Operator dashboard",
    desc: "Active users, installs, noise reduction, and drift incidents.",
    icon: Wrench,
  },
] as const;

type OverviewMetric = {
  label: string;
  total: string | number;
  delta: string;
  values: number[];
};

type RecentRun = {
  id: string;
  kind: string;
  repo: string;
  source: string;
  signal_fidelity: "ready" | "degraded" | "stale" | "blocked";
  created_at: string;
};

type AppOverviewResponse = {
  metrics: OverviewMetric[];
  recentRuns: Array<{
    run: {
      id: string;
      objective: string;
      surface: string;
      status: string;
      dataQualityStatus?: string;
      createdAt?: string | null;
    };
    actions?: Array<{ targetRepoFullName?: string | null; actionType?: string }>;
  }>;
};

function AppOverview() {
  const { session } = useSession();
  const { status, connection } = useApiStatus();
  const overview = useApiResource<AppOverviewResponse>("/v1/app/overview", "App overview");
  if (!session) return null;

  const live = connection === "online" && (status === "ok" || status === "degraded");
  const loading = status === "loading" || status === "idle";
  const series = overview.status === "ready" ? overview.data.metrics.slice(0, 3) : [];
  const recentRuns =
    overview.status === "ready" ? overview.data.recentRuns.slice(0, 4).map(mapOverviewRun) : [];
  const lastRun = recentRuns[0];

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={
          <span className="inline-flex items-center gap-2">
            <span>Overview</span>
            <StatusPill
              status={
                overview.status === "ready"
                  ? "ready"
                  : overview.status === "error"
                    ? "warn"
                    : "info"
              }
            >
              {overview.status === "ready"
                ? "Live"
                : overview.status === "error"
                  ? "API issue"
                  : "Loading"}
            </StatusPill>
            <StatusPill status={live ? "ready" : "warn"}>
              Service · {describeApiStatus(status)}
            </StatusPill>
          </span>
        }
        title={<>Welcome back, {session.login}</>}
        description="Live control-panel metrics from the Gittensory API. Missing backend data renders as empty states instead of demo records."
      />

      <OnboardingChecklist />

      <QuickActions lastRunId={lastRun?.id} />

      <TooltipProvider delayDuration={150}>
        <section
          aria-label="At-a-glance metrics"
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
        >
          {overview.status === "error" && (
            <div className="col-span-full rounded-token border border-warning/30 bg-warning/[0.04] p-4 text-token-sm text-warning">
              App overview is unavailable right now ({overview.error}).
            </div>
          )}
          {series.length === 0 ? (
            <div className="col-span-full rounded-token border border-dashed border-border bg-transparent p-6 text-center text-token-sm text-muted-foreground">
              No metrics available yet. They’ll appear once the API returns data.
            </div>
          ) : (
            series.map((m) => (
              <SparkStat
                key={m.label}
                label={m.label}
                value={String(m.total)}
                hint={m.delta}
                values={m.values}
                live={live}
                loading={loading}
                statusLabel={describeApiStatus(status)}
              />
            ))
          )}
        </section>
      </TooltipProvider>

      <CtaBand status={status} connection={connection} live={live} />

      <RecentActivity runs={recentRuns} />

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {CARDS.map((c) => (
          <Link
            key={c.to}
            to={c.to}
            className="group rounded-token border-hairline bg-card/40 p-5 transition-all duration-150 motion-reduce:transition-none hover:-translate-y-[1px] hover:border-strong hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:translate-y-0"
          >
            <div className="mb-3 inline-flex size-9 items-center justify-center rounded-token border border-mint/30 bg-mint/10 text-mint transition-colors group-hover:bg-mint/20">
              <c.icon className="size-4" />
            </div>
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-display text-token-base font-semibold text-foreground">
                {c.title}
              </h3>
              <ArrowRight className="size-3.5 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none group-hover:translate-x-0.5 group-hover:text-foreground" />
            </div>
            <p className="mt-1 text-token-sm text-muted-foreground leading-token-relaxed">
              {c.desc}
            </p>
          </Link>
        ))}
      </section>
    </div>
  );
}

function mapOverviewRun(bundle: AppOverviewResponse["recentRuns"][number]): RecentRun {
  const status = bundle.run.dataQualityStatus ?? bundle.run.status;
  return {
    id: bundle.run.id,
    kind: bundle.actions?.[0]?.actionType ?? bundle.run.objective,
    repo: bundle.actions?.[0]?.targetRepoFullName ?? "no target",
    source: bundle.run.surface,
    signal_fidelity:
      status === "complete" || status === "completed"
        ? "ready"
        : status === "blocked" || status === "failed"
          ? "blocked"
          : "degraded",
    created_at: bundle.run.createdAt ?? new Date().toISOString(),
  };
}

function QuickActions({ lastRunId }: { lastRunId?: string }) {
  const items: Array<{
    to: string;
    search?: Record<string, string>;
    label: string;
    icon: typeof Sparkles;
  }> = [
    { to: "/app/workbench", search: { tab: "miner" }, label: "Plan next work", icon: Sparkles },
    {
      to: "/app/workbench",
      search: { tab: "playground" },
      label: "Run preflight",
      icon: PlayCircle,
    },
    {
      to: "/app/workbench",
      search: { tab: "commands" },
      label: "@gittensory commands",
      icon: TerminalSquare,
    },
    ...(lastRunId
      ? [
          {
            to: "/app/runs",
            search: { selected: lastRunId },
            label: "Open last run",
            icon: Activity,
          },
        ]
      : []),
  ];
  return (
    <section aria-label="Quick actions" className="flex flex-wrap gap-2">
      {items.map((i) => {
        const Icon = i.icon;
        return (
          <Link
            key={i.label}
            to={i.to}
            search={i.search as never}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card/40 px-3 py-1.5 text-token-xs text-foreground/90 transition-all duration-150 hover:-translate-y-[1px] hover:border-strong hover:bg-card focus-ring motion-reduce:transition-none motion-reduce:hover:translate-y-0"
          >
            <Icon className="size-3.5 text-mint" aria-hidden />
            {i.label}
          </Link>
        );
      })}
    </section>
  );
}

function RecentActivity({ runs }: { runs: RecentRun[] }) {
  if (runs.length === 0) return null;
  const toneFor = (s: string) =>
    s === "ready" ? "bg-mint" : s === "degraded" || s === "stale" ? "bg-warning" : "bg-coral";
  return (
    <section
      aria-label="Recent agent runs"
      className="rounded-token border-hairline bg-card/40 p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
          Recent runs
        </div>
        <Link
          to="/app/runs"
          className="text-token-xs text-muted-foreground transition-colors hover:text-foreground focus-ring rounded"
        >
          View all →
        </Link>
      </div>
      <ul className="mt-3 divide-y divide-border">
        {runs.map((r) => (
          <li key={r.id}>
            <Link
              to="/app/runs"
              search={{ selected: r.id } as never}
              className="flex items-center gap-3 py-2 text-token-sm transition-colors hover:bg-accent/40 focus-ring rounded px-1 -mx-1"
            >
              <span
                aria-hidden
                className={cn("size-2 shrink-0 rounded-full", toneFor(r.signal_fidelity))}
              />
              <span className="min-w-0 flex-1 truncate text-foreground/90">{r.kind}</span>
              <span className="hidden font-mono text-token-2xs text-muted-foreground sm:inline">
                {r.repo}
              </span>
              <span className="font-mono text-token-2xs text-muted-foreground">
                {new Date(r.created_at).toUTCString().slice(5, 16)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

const ONBOARDING_STEPS = [
  { id: "install", label: "Install the MCP package" },
  { id: "doctor", label: "Run gittensory-mcp doctor" },
  { id: "workbench", label: "Explore the Workbench tabs" },
  { id: "run", label: "Open an agent run" },
] as const;

function OnboardingChecklist() {
  const [state, setState, hydrated] = useLocalStorage<{
    dismissed: boolean;
    done: Record<string, boolean>;
  }>("gittensory.onboarding", { dismissed: false, done: {} });
  if (!hydrated || state.dismissed) return null;
  const completed = ONBOARDING_STEPS.filter((s) => state.done[s.id]).length;
  return (
    <section
      aria-label="Onboarding checklist"
      className="rounded-token border border-mint/30 bg-mint/[0.04] p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-mono text-token-2xs uppercase tracking-wider text-mint">
            Get started · {completed}/{ONBOARDING_STEPS.length}
          </div>
          <h2 className="mt-1 font-display text-token-base font-semibold">
            Four steps to a full preview tour
          </h2>
        </div>
        <button
          type="button"
          onClick={() => setState((p) => ({ ...p, dismissed: true }))}
          aria-label="Dismiss onboarding checklist"
          className="rounded-token p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-ring"
        >
          <X className="size-4" />
        </button>
      </div>
      <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
        {ONBOARDING_STEPS.map((s) => {
          const done = !!state.done[s.id];
          return (
            <li key={s.id}>
              <button
                type="button"
                onClick={() =>
                  setState((p) => ({
                    ...p,
                    done: { ...p.done, [s.id]: !done },
                  }))
                }
                className="flex w-full items-center gap-2 rounded-token px-2 py-1.5 text-left text-token-sm transition-colors hover:bg-accent/60 focus-ring"
              >
                <span
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded-full border",
                    done ? "border-mint bg-mint/20 text-mint" : "border-border text-transparent",
                  )}
                  aria-hidden
                >
                  {done ? <Check className="size-3" /> : <Circle className="size-2" />}
                </span>
                <span className={cn(done && "text-muted-foreground line-through")}>{s.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function SparkStat({
  label,
  value,
  hint,
  values,
  live,
  loading,
  statusLabel,
}: {
  label: string;
  value: string;
  hint?: string;
  values: number[];
  live: boolean;
  loading?: boolean;
  statusLabel: string;
}) {
  if (loading) {
    return (
      <div
        role="status"
        aria-label={`Loading ${label}`}
        className="rounded-token border-hairline bg-card p-4"
      >
        <div className="h-3 w-24 animate-pulse rounded bg-muted/40 motion-reduce:animate-none" />
        <div className="mt-3 flex items-end justify-between gap-3">
          <div className="h-7 w-16 animate-pulse rounded bg-muted/40 motion-reduce:animate-none" />
          <div className="h-10 w-24 animate-pulse rounded bg-muted/30 motion-reduce:animate-none" />
        </div>
      </div>
    );
  }
  if (!values || values.length === 0) {
    return (
      <div className="rounded-token border-hairline bg-card p-4 text-token-sm text-muted-foreground">
        <div className="font-mono text-token-2xs uppercase tracking-wider">{label}</div>
        <p className="mt-2">No samples yet.</p>
      </div>
    );
  }
  const latest = values[values.length - 1];
  const first = values[0];
  const delta = latest - first;
  const trend = delta > 0 ? "trending up" : delta < 0 ? "trending down" : "flat";
  const tooltipText = `${statusLabel} · ${values.length} samples · latest ${latest} · ${trend}${hint ? ` · ${hint}` : ""}`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          tabIndex={0}
          aria-label={`${label}: ${value}. ${tooltipText}`}
          className="rounded-token border-hairline bg-card p-4 transition-colors hover:border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
              {label}
            </div>
            <span
              className={cn(
                "rounded-full border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider",
                live
                  ? "border-mint/30 bg-mint/10 text-mint"
                  : "border-border bg-background/40 text-muted-foreground",
              )}
              aria-label={live ? "Live" : "Cached"}
            >
              {live ? "live" : "cached"}
            </span>
          </div>
          <div className="mt-1.5 flex items-end justify-between gap-3">
            <div>
              <div className="font-display text-token-2xl font-semibold tracking-tight text-foreground">
                {value}
              </div>
              {hint && <div className="mt-0.5 text-token-xs text-muted-foreground">{hint}</div>}
            </div>
            <div className="h-10 w-24 shrink-0 opacity-90">
              <TrendChart values={values} height={40} />
            </div>
          </div>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[240px] text-token-xs">
        {tooltipText}
      </TooltipContent>
    </Tooltip>
  );
}

function CtaBand({
  status,
  connection,
  live,
}: {
  status: ReturnType<typeof useApiStatus>["status"];
  connection: ReturnType<typeof useApiStatus>["connection"];
  live: boolean;
}) {
  const offline = connection === "offline";
  const degraded = status === "degraded";
  const broken = status === "timeout" || status === "unreachable";

  const tone =
    offline || broken
      ? "border-warning/30 bg-warning/[0.04]"
      : degraded
        ? "border-border bg-card/60"
        : "border-border bg-card/40";

  return (
    <section
      aria-label="API status and quick actions"
      className={cn(
        "flex flex-col gap-3 rounded-token border p-4 sm:flex-row sm:items-center sm:justify-between",
        tone,
      )}
    >
      <div className="min-w-0">
        <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
          API status
        </div>
        <p className="mt-1 text-token-sm text-foreground/90">
          {offline
            ? "You're offline. Cached metrics shown — live values resume when your connection returns."
            : broken
              ? `${describeApiStatus(status)}. Metric cards are showing the most recent cached values.`
              : live
                ? "Live. Sparklines reflect the latest 8 weekly buckets."
                : "Checking API…"}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void pingHealth(true)}
          disabled={offline}
          className="inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-token border border-border bg-transparent px-3.5 text-token-xs font-medium text-foreground transition-colors duration-150 hover:bg-accent focus-ring motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw className="size-3.5" />
          Recheck API
        </button>
        <Link
          to="/app/runs"
          className="inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-token bg-coral px-3.5 text-token-xs font-medium text-primary-foreground transition-[filter,transform] duration-150 hover:brightness-110 active:scale-[0.98] focus-ring motion-reduce:transition-none motion-reduce:active:scale-100"
        >
          View agent runs →
        </Link>
      </div>
    </section>
  );
}
