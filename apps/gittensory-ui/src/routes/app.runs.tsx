import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { z } from "zod";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Filter,
  Link2,
  RotateCw,
  Save,
  Search,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import { toast } from "sonner";

import {
  BoundaryBadge,
  StatusPill,
  type Boundary,
  type Status,
} from "@/components/site/control-primitives";
import { useApiResource } from "@/lib/api/use-api-resource";
import { useSession } from "@/lib/api/session";
import { EmptyState } from "@/components/site/state-views";
import { useLocalStorage } from "@/lib/use-local-storage";
import { cn } from "@/lib/utils";

const SIGNAL: Record<string, Status> = {
  ready: "ready",
  degraded: "warn",
  stale: "warn",
  blocked: "blocked",
};

const STATUS_FILTERS = ["all", "ready", "degraded", "stale", "blocked"] as const;
const KIND_FILTERS = [
  "all",
  "plan-next-work",
  "preflight-branch",
  "prepare-pr-packet",
  "explain-blockers",
] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];
type KindFilter = (typeof KIND_FILTERS)[number];

interface AgentRun {
  id: string;
  source: "mcp" | "api" | "github-command";
  kind: "plan-next-work" | "preflight-branch" | "prepare-pr-packet" | "explain-blockers";
  repo: string;
  ranked_actions: number;
  ruleset_snapshot: string;
  signal_fidelity: "ready" | "degraded" | "stale" | "blocked";
  boundary: Boundary;
  created_at: string;
  summary?: string;
  recommendations?: string[];
  evidenceActions: ActionEvidence[];
  freshnessWarnings: string[];
  errorSummary?: string | null;
}

type AgentSafetyClass = "private" | "public_safe" | "approval_required";

type EvidenceSource = {
  name: string;
  source?: string | null;
  generatedAt?: string | null;
  freshness: string;
  summary: string;
};

type RecommendationEvidence = {
  confidence: "high" | "medium" | "low";
  sourceSummary: string;
  freshness: string;
  sources: EvidenceSource[];
  assumptions: string[];
  warnings: string[];
  userSuppliedScenarios: boolean;
  userSuppliedScenarioCount: number;
};

type ActionEvidence = {
  id: string;
  actionType: string;
  targetRepoFullName?: string | null;
  recommendation: string;
  why: string[];
  blockedBy: string[];
  scoreabilityImpact?: string | null;
  riskImpact?: string | null;
  maintainerImpact?: string | null;
  publicSafeSummary: string;
  approvalRequired: boolean;
  safetyClass: AgentSafetyClass;
  status: string;
  rerunWhen?: string | null;
  evidence?: RecommendationEvidence | null;
};

type AgentRunBundleResponse = {
  runs: AgentRunBundle[];
};

type AgentRunBundle = {
  run: {
    id: string;
    objective: string;
    actorLogin: string;
    surface: "mcp" | "github_comment" | "api";
    status: "queued" | "running" | "completed" | "failed" | "needs_snapshot_refresh";
    dataQualityStatus: "complete" | "degraded" | "blocked" | "unknown";
    errorSummary?: string | null;
    payload?: Record<string, unknown>;
    createdAt?: string | null;
    updatedAt?: string | null;
  };
  actions: Array<{
    id: string;
    actionType: string;
    targetRepoFullName?: string | null;
    recommendation: string;
    why: string[];
    blockedBy: string[];
    scoreabilityImpact?: string | null;
    riskImpact?: string | null;
    maintainerImpact?: string | null;
    publicSafeSummary: string;
    approvalRequired: boolean;
    safetyClass: AgentSafetyClass;
    status: string;
    rerunWhen?: string | null;
    payload?: Record<string, unknown>;
  }>;
  contextSnapshots: Array<{
    scoringModelId?: string | null;
    decisionPackVersion?: string | null;
    freshnessWarnings?: string[];
  }>;
  summary: string;
};

const searchSchema = z.object({
  status: z.enum(STATUS_FILTERS).optional(),
  kind: z.enum(KIND_FILTERS).optional(),
  q: z.string().optional(),
  selected: z.string().optional(),
});

export const Route = createFileRoute("/app/runs")({
  validateSearch: (s) => searchSchema.parse(s),
  component: AgentRuns,
});

function AgentRuns() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { session } = useSession();
  const actorLogin = session?.login?.trim();
  const canUseLiveRuns = Boolean(actorLogin);
  const liveRuns = useApiResource<AgentRunBundleResponse>(
    `/v1/agent/runs?actorLogin=${encodeURIComponent(actorLogin ?? "")}&limit=100`,
    "Agent runs",
    undefined,
    { enabled: canUseLiveRuns },
  );
  const runs = useMemo(
    () =>
      canUseLiveRuns && liveRuns.status === "ready"
        ? liveRuns.data.runs.map(mapAgentRunBundle)
        : [],
    [canUseLiveRuns, liveRuns.data, liveRuns.status],
  );
  const status: StatusFilter = search.status ?? "all";
  const kind: KindFilter = search.kind ?? "all";
  const q = search.q ?? "";
  const selectedId = search.selected;
  const selected = useMemo(
    () => (selectedId ? (runs.find((r) => r.id === selectedId) ?? null) : null),
    [runs, selectedId],
  );

  const setSelected = (id: string | null) =>
    navigate({
      search: (p: z.infer<typeof searchSchema>) => ({
        ...p,
        selected: id ?? undefined,
      }),
      replace: false,
    });

  const setStatus = (s: StatusFilter) =>
    navigate({
      search: (p: z.infer<typeof searchSchema>) => ({
        ...p,
        status: s === "all" ? undefined : s,
      }),
      replace: true,
    });
  const setKind = (k: KindFilter) =>
    navigate({
      search: (p: z.infer<typeof searchSchema>) => ({
        ...p,
        kind: k === "all" ? undefined : k,
      }),
      replace: true,
    });
  const setQ = (value: string) =>
    navigate({
      search: (p: z.infer<typeof searchSchema>) => ({
        ...p,
        q: value ? value : undefined,
      }),
      replace: true,
    });

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return runs.filter((r) => {
      if (status !== "all" && r.signal_fidelity !== status) return false;
      if (kind !== "all" && r.kind !== kind) return false;
      if (term && !`${r.id} ${r.kind} ${r.repo} ${r.source}`.toLowerCase().includes(term))
        return false;
      return true;
    });
  }, [runs, status, kind, q]);

  const grouped = useMemo(() => groupByDate(filtered), [filtered]);
  const sourceStatus: Status =
    canUseLiveRuns && liveRuns.status === "ready"
      ? "ready"
      : canUseLiveRuns && liveRuns.status === "loading"
        ? "info"
        : "warn";
  const sourceLabel =
    canUseLiveRuns && liveRuns.status === "ready"
      ? "Live API"
      : canUseLiveRuns && liveRuns.status === "loading"
        ? "Loading live API"
        : "No session";

  // Keyboard navigation: ←/→ to cycle through filtered runs while drawer is open.
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      const idx = filtered.findIndex((r) => r.id === selected.id);
      if (idx === -1) return;
      const nextIdx = e.key === "ArrowRight" ? idx + 1 : idx - 1;
      const next = filtered[nextIdx];
      if (next) {
        e.preventDefault();
        setSelected(next.id);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, filtered]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="font-mono text-token-2xs uppercase tracking-wider text-mint">
            Activity
          </div>
          <h1 className="mt-1 font-display text-token-2xl font-semibold tracking-tight">
            Agent runs
          </h1>
          <p className="mt-1 max-w-2xl text-token-sm text-muted-foreground">
            Unified feed of MCP, API, and @gittensory runs. Each entry carries a ruleset snapshot
            and a public/private boundary.
          </p>
        </div>
        <StatusPill status={sourceStatus}>{sourceLabel}</StatusPill>
      </header>

      {canUseLiveRuns && liveRuns.status === "error" && liveRuns.error !== "disabled" && (
        <div className="rounded-token border border-warning/30 bg-warning/5 p-3 text-token-xs text-warning">
          Live runs are unavailable right now ({liveRuns.error}).
        </div>
      )}

      <div className="rounded-token border border-border bg-transparent p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center gap-1.5 font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
            <Filter className="size-3.5" />
            Status
          </div>
          <div className="flex flex-wrap gap-1">
            {STATUS_FILTERS.map((s) => (
              <Chip key={s} active={status === s} onClick={() => setStatus(s)}>
                {s}
              </Chip>
            ))}
          </div>
          <span aria-hidden className="ml-2 hidden accent-divider-v-tall sm:inline-block" />
          <div className="inline-flex items-center gap-1.5 font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
            Kind
          </div>
          <div className="flex flex-wrap gap-1">
            {KIND_FILTERS.map((k) => (
              <Chip key={k} active={kind === k} onClick={() => setKind(k)}>
                {k}
              </Chip>
            ))}
          </div>
          <div className="ml-auto inline-flex items-center gap-2 rounded-token border border-border bg-background/40 px-2">
            <Search className="size-3.5 text-muted-foreground" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search runs…"
              className="w-40 border-0 bg-transparent py-1 text-token-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
        </div>
      </div>

      <SavedViews
        current={{ status, kind, q }}
        onApply={(v) =>
          navigate({
            search: () => ({
              status: v.status === "all" ? undefined : v.status,
              kind: v.kind === "all" ? undefined : v.kind,
              q: v.q ? v.q : undefined,
            }),
            replace: true,
          })
        }
      />

      <div className="text-token-2xs text-muted-foreground">
        Showing {filtered.length} of {runs.length}
      </div>

      {filtered.length === 0 ? (
        <ul className="space-y-2">
          <li>
            <EmptyState
              title="No runs match these filters"
              description="Try clearing the status or kind filter, or search by repo or run id."
              action={
                <button
                  type="button"
                  onClick={() => {
                    setStatus("all");
                    setKind("all");
                    setQ("");
                    toast("Filters cleared", {
                      description: "Showing all available agent runs again.",
                    });
                  }}
                  className="inline-flex min-w-0 items-center justify-center rounded-token border border-border bg-transparent px-3 py-1.5 text-center text-token-xs font-medium text-foreground transition-all duration-150 hover:bg-accent focus-ring motion-reduce:transition-none motion-reduce:active:scale-100 active:scale-[0.98]"
                >
                  Clear filters
                </button>
              }
            />
          </li>
        </ul>
      ) : (
        <div className="space-y-5">
          {grouped.map((bucket) => (
            <section key={bucket.label} aria-label={bucket.label}>
              <h2 className="sticky top-[6.25rem] z-[1] -mx-1 mb-2 bg-background/85 px-1 py-1 font-mono text-token-2xs uppercase tracking-wider text-muted-foreground backdrop-blur">
                {bucket.label} · {bucket.runs.length}
              </h2>
              <ul className="space-y-2">
                {bucket.runs.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(r.id)}
                      aria-current={selectedId === r.id ? "true" : undefined}
                      className={cn(
                        "grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-token border bg-transparent p-3 text-left transition-all duration-150 focus-ring motion-reduce:transition-none motion-reduce:active:scale-100 active:scale-[0.99]",
                        selectedId === r.id
                          ? "border-mint/40 bg-mint/[0.04]"
                          : "border-border hover:border-foreground/30",
                      )}
                    >
                      <StatusPill status={SIGNAL[r.signal_fidelity]}>
                        {r.signal_fidelity}
                      </StatusPill>
                      <div className="min-w-0">
                        <div className="truncate text-token-sm">{r.kind}</div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-token-2xs text-muted-foreground">
                          <span className="font-mono">{r.id}</span>
                          <span>·</span>
                          <span>{r.source}</span>
                          <span>·</span>
                          <span>{r.repo}</span>
                        </div>
                      </div>
                      <div className="text-right font-mono text-token-2xs text-muted-foreground">
                        {new Date(r.created_at).toUTCString().slice(5, 22)}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <RunDrawer
        run={selected}
        filtered={filtered}
        onSelect={(id) => setSelected(id)}
        onClose={() => setSelected(null)}
        onRerun={() => {
          toast("Open the workbench to rerun", {
            description: `${selected?.id ?? "This run"} can be recreated from the Playground with the same repo and action type.`,
          });
        }}
      />
    </div>
  );
}

function mapAgentRunBundle(bundle: AgentRunBundle): AgentRun {
  const payload = bundle.run.payload ?? {};
  const input = recordValue(payload.input);
  const repo =
    stringValue(bundle.actions[0]?.targetRepoFullName) ??
    stringValue(payload.repoFullName) ??
    stringValue(input?.repoFullName) ??
    "unknown";
  const scoringSnapshot =
    bundle.contextSnapshots[0]?.scoringModelId ??
    bundle.contextSnapshots[0]?.decisionPackVersion ??
    "live";
  const freshnessWarnings = bundle.contextSnapshots.flatMap((s) => s.freshnessWarnings ?? []);

  const evidenceActions: ActionEvidence[] = bundle.actions.map((action) => {
    const evidencePayload = recordValue(action.payload?.recommendationEvidence ?? null);
    const evidence: RecommendationEvidence | null = evidencePayload
      ? {
          confidence: (evidencePayload.confidence as RecommendationEvidence["confidence"]) ?? "low",
          sourceSummary: stringValue(evidencePayload.sourceSummary) ?? "",
          freshness: stringValue(evidencePayload.freshness) ?? "unknown",
          sources: (Array.isArray(evidencePayload.sources) ? evidencePayload.sources : []).map(
            (s: unknown) => {
              const src = recordValue(s);
              return {
                name: stringValue(src?.name) ?? "unknown",
                source: stringValue(src?.source),
                generatedAt: stringValue(src?.generatedAt),
                freshness: stringValue(src?.freshness) ?? "unknown",
                summary: stringValue(src?.summary) ?? "",
              };
            },
          ),
          assumptions: (Array.isArray(evidencePayload.assumptions)
            ? evidencePayload.assumptions
            : []
          ).filter(isString),
          warnings: (Array.isArray(evidencePayload.warnings)
            ? evidencePayload.warnings
            : []
          ).filter(isString),
          userSuppliedScenarios: Boolean(evidencePayload.userSuppliedScenarios),
          userSuppliedScenarioCount: Number(evidencePayload.userSuppliedScenarioCount ?? 0),
        }
      : null;

    return {
      id: action.id,
      actionType: action.actionType,
      targetRepoFullName: action.targetRepoFullName,
      recommendation: action.recommendation,
      why: action.why ?? [],
      blockedBy: action.blockedBy ?? [],
      scoreabilityImpact: action.scoreabilityImpact,
      riskImpact: action.riskImpact,
      maintainerImpact: action.maintainerImpact,
      publicSafeSummary: action.publicSafeSummary,
      approvalRequired: action.approvalRequired,
      safetyClass: action.safetyClass,
      status: action.status,
      rerunWhen: action.rerunWhen,
      evidence,
    };
  });

  return {
    id: bundle.run.id,
    source: bundle.run.surface === "github_comment" ? "github-command" : bundle.run.surface,
    kind: mapAgentRunKind(stringValue(payload.kind)),
    repo,
    ranked_actions: bundle.actions.length,
    ruleset_snapshot: scoringSnapshot,
    signal_fidelity: mapSignalFidelity(bundle.run.dataQualityStatus),
    boundary:
      bundle.run.surface === "github_comment"
        ? "public"
        : bundle.run.surface === "mcp"
          ? "private-mcp"
          : "private-api",
    created_at: bundle.run.createdAt ?? bundle.run.updatedAt ?? new Date().toISOString(),
    summary: bundle.summary,
    recommendations: bundle.actions.map((action) => action.recommendation).filter(isString),
    evidenceActions,
    freshnessWarnings,
    errorSummary: bundle.run.errorSummary,
  };
}

function mapAgentRunKind(kind: string | null): AgentRun["kind"] {
  if (kind === "preflight_branch") return "preflight-branch";
  if (kind === "prepare_pr_packet") return "prepare-pr-packet";
  if (kind === "explain_blockers" || kind === "explain_branch_blockers") return "explain-blockers";
  return "plan-next-work";
}

function mapSignalFidelity(
  status: AgentRunBundle["run"]["dataQualityStatus"],
): AgentRun["signal_fidelity"] {
  if (status === "complete") return "ready";
  if (status === "degraded") return "degraded";
  if (status === "blocked") return "blocked";
  return "stale";
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function groupByDate(runs: AgentRun[]) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 7);
  const buckets: Record<string, AgentRun[]> = {
    Today: [],
    Yesterday: [],
    "This week": [],
    Earlier: [],
  };
  for (const r of runs) {
    const d = new Date(r.created_at);
    if (d >= today) buckets.Today.push(r);
    else if (d >= yesterday) buckets.Yesterday.push(r);
    else if (d >= weekAgo) buckets["This week"].push(r);
    else buckets.Earlier.push(r);
  }
  return (["Today", "Yesterday", "This week", "Earlier"] as const)
    .map((label) => ({ label, runs: buckets[label] }))
    .filter((b) => b.runs.length > 0);
}

type SavedView = {
  id: string;
  name: string;
  status: StatusFilter;
  kind: KindFilter;
  q: string;
};

function SavedViews({
  current,
  onApply,
}: {
  current: { status: StatusFilter; kind: KindFilter; q: string };
  onApply: (v: { status: StatusFilter; kind: KindFilter; q: string }) => void;
}) {
  const [views, setViews, hydrated] = useLocalStorage<SavedView[]>("gittensory.runs.views", []);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  if (!hydrated) return null;
  const hasCurrentFilters = current.status !== "all" || current.kind !== "all" || current.q !== "";
  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const id = `v_${Date.now().toString(36)}`;
    setViews((p) => [...p, { id, name: trimmed, ...current }]);
    setName("");
    setNaming(false);
    toast.success("View saved", { description: `“${trimmed}” pinned to your filters.` });
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
        Views
      </span>
      {views.length === 0 && !naming && (
        <span className="text-token-2xs text-muted-foreground">
          Save current filters as a named view.
        </span>
      )}
      {views.map((v) => (
        <span
          key={v.id}
          className="group inline-flex items-center gap-1 rounded-full border border-border bg-card/40 pl-2.5 pr-1 py-0.5 text-token-2xs"
        >
          <button
            type="button"
            onClick={() => onApply(v)}
            className="text-foreground/90 transition-colors hover:text-foreground focus-ring rounded"
          >
            {v.name}
          </button>
          <button
            type="button"
            onClick={() => {
              setViews((p) => p.filter((x) => x.id !== v.id));
              toast(`Removed “${v.name}”`);
            }}
            aria-label={`Remove ${v.name}`}
            className="rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-ring"
          >
            <Trash2 className="size-3" />
          </button>
        </span>
      ))}
      {naming ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
          className="inline-flex items-center gap-1"
        >
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              if (!name.trim()) setNaming(false);
            }}
            placeholder="View name"
            className="h-7 w-32 rounded-token border border-border bg-background/60 px-2 text-token-xs outline-none focus-ring"
          />
          <button
            type="submit"
            className="inline-flex h-7 items-center gap-1 rounded-token bg-mint px-2 text-token-2xs font-medium text-primary-foreground focus-ring"
          >
            Save
          </button>
        </form>
      ) : (
        <button
          type="button"
          disabled={!hasCurrentFilters}
          onClick={() => setNaming(true)}
          className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-token-2xs text-muted-foreground transition-colors hover:border-strong hover:text-foreground focus-ring disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Save className="size-3" />
          Save view
        </button>
      )}
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-0.5 font-mono text-token-2xs lowercase tracking-wider transition-colors",
        active
          ? "border-mint/40 bg-mint/10 text-mint"
          : "border-border text-muted-foreground hover:border-border hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function RunDrawer({
  run,
  filtered,
  onSelect,
  onClose,
  onRerun,
}: {
  run: AgentRun | null;
  filtered: AgentRun[];
  onSelect: (id: string) => void;
  onClose: () => void;
  onRerun: () => void;
}) {
  return (
    <AnimatePresence>
      {run && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[60] flex justify-end bg-background/60 "
          onClick={onClose}
        >
          <DrawerSurface
            run={run}
            filtered={filtered}
            onSelect={onSelect}
            onClose={onClose}
            onRerun={onRerun}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function DrawerSurface({
  run,
  filtered,
  onSelect,
  onClose,
  onRerun,
}: {
  run: AgentRun;
  filtered: AgentRun[];
  onSelect: (id: string) => void;
  onClose: () => void;
  onRerun: () => void;
}) {
  const idx = filtered.findIndex((r) => r.id === run.id);
  const prev = idx > 0 ? filtered[idx - 1] : null;
  const next = idx >= 0 && idx < filtered.length - 1 ? filtered[idx + 1] : null;

  const copyPermalink = async () => {
    try {
      const url = `${window.location.origin}${window.location.pathname}?selected=${encodeURIComponent(run.id)}`;
      await navigator.clipboard.writeText(url);
      toast.success("Permalink copied", { description: url });
    } catch {
      toast.error("Couldn't copy permalink");
    }
  };
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const titleId = `run-drawer-title-${run.id}`;

  useEffect(() => {
    restoreRef.current = (document.activeElement as HTMLElement) ?? null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      restoreRef.current?.focus?.();
    };
    // Re-bind when the selected run changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id]);

  return (
    <motion.aside
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      initial={{ x: 40, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 40, opacity: 0 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      onClick={(e) => e.stopPropagation()}
      className="flex h-full w-full max-w-lg flex-col overflow-hidden border-l border-border bg-popover/95"
    >
      <header className="flex items-start justify-between gap-3 border-b border-border p-5">
        <div>
          <BoundaryBadge boundary={run.boundary} />
          <h2 id={titleId} className="mt-2 font-display text-token-lg font-semibold">
            {run.kind}
          </h2>
          <div className="mt-1 font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
            {run.id}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => prev && onSelect(prev.id)}
            disabled={!prev}
            aria-label="Previous run (←)"
            title="Previous run (←)"
            className="rounded-token p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-ring disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <ChevronLeft className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => next && onSelect(next.id)}
            disabled={!next}
            aria-label="Next run (→)"
            title="Next run (→)"
            className="rounded-token p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-ring disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <ChevronRight className="size-4" />
          </button>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close run details (Esc)"
            className="rounded-token p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-ring"
          >
            <X className="size-4" />
          </button>
        </div>
      </header>

      <motion.div
        key={run.id}
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.12, ease: "easeOut" }}
        className="flex-1 space-y-5 overflow-auto p-5"
      >
        {run.signal_fidelity !== "ready" && (
          <div className="rounded-token border border-warning/30 bg-warning/5 p-3 text-token-xs text-warning">
            Signal fidelity is <strong>{run.signal_fidelity}</strong>. Treat ranked actions as
            advisory until upstream drift clears.
          </div>
        )}

        {run.errorSummary && (
          <div className="rounded-token border border-destructive/30 bg-destructive/5 p-3 text-token-xs text-destructive">
            <strong>Error:</strong> {run.errorSummary}
          </div>
        )}

        <div className="grid grid-cols-2 gap-4 text-token-sm">
          <KV k="Source" v={run.source} />
          <KV k="Repo" v={run.repo} />
          <KV k="Ranked actions" v={run.ranked_actions} />
          <KV k="Ruleset" v={run.ruleset_snapshot} />
          <KV k="Created" v={new Date(run.created_at).toUTCString().slice(5, 22)} />
          <KV k="Signal" v={run.signal_fidelity} />
        </div>

        <FreshnessWarningsBanner warnings={run.freshnessWarnings} />

        <div>
          <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
            Inputs
          </div>
          <pre className="mt-2 overflow-x-auto rounded-token border border-border bg-background/60 p-3 font-mono text-token-2xs text-foreground/90">
            {JSON.stringify({ repo: run.repo, source: run.source, kind: run.kind }, null, 2)}
          </pre>
        </div>

        <ActionEvidenceList actions={run.evidenceActions} boundary={run.boundary} />
      </motion.div>

      <footer className="border-t border-border p-4">
        <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
          <button
            type="button"
            onClick={onRerun}
            aria-label={`Re-run ${run.kind} with the same inputs`}
            className="inline-flex items-center justify-center gap-2 rounded-token bg-mint px-3 py-2 text-token-xs font-medium text-primary-foreground transition-[filter,transform] duration-150 hover:brightness-110 active:scale-[0.98] focus-ring motion-reduce:transition-none motion-reduce:active:scale-100"
          >
            <RotateCw className="size-3.5" />
            Re-run with same inputs
          </button>
          <button
            type="button"
            onClick={copyPermalink}
            className="inline-flex items-center justify-center gap-1.5 rounded-token border border-border px-3 py-2 text-token-xs text-foreground/90 transition-colors hover:bg-accent focus-ring"
          >
            <Link2 className="size-3.5" />
            Permalink
          </button>
          <a
            href={`/app/workbench?tab=playground`}
            className="inline-flex items-center justify-center gap-1.5 rounded-token border border-border px-3 py-2 text-token-xs text-foreground/90 transition-colors hover:bg-accent focus-ring"
          >
            <Workflow className="size-3.5" />
            Open in workbench
          </a>
        </div>
        <p className="mt-2 text-center text-token-2xs text-muted-foreground">
          Use ← / → to cycle through {filtered.length} filtered runs.
        </p>
      </footer>
    </motion.aside>
  );
}

function KV({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div>
      <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
        {k}
      </div>
      <div className="mt-0.5 font-mono text-[12px] text-foreground/90">{v}</div>
    </div>
  );
}

function FreshnessWarningsBanner({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null;
  return (
    <div className="rounded-token border border-warning/30 bg-warning/5 p-3">
      <div className="mb-1.5 flex items-center gap-1.5 font-mono text-token-2xs uppercase tracking-wider text-warning">
        <Clock className="size-3.5" />
        Snapshot Freshness
      </div>
      <ul className="space-y-1">
        {warnings.map((w, i) => (
          <li key={i} className="flex items-start gap-1.5 text-token-xs text-warning/90">
            <AlertTriangle className="mt-0.5 size-3 shrink-0" />
            {w}
          </li>
        ))}
      </ul>
    </div>
  );
}

function SafetyClassBadge({
  safetyClass,
  approvalRequired,
}: {
  safetyClass: AgentSafetyClass;
  approvalRequired: boolean;
}) {
  if (safetyClass === "public_safe") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-mint/30 bg-mint/10 px-2 py-0.5 font-mono text-token-2xs text-mint">
        <ShieldCheck className="size-3" />
        public-safe
      </span>
    );
  }
  if (approvalRequired || safetyClass === "approval_required") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 font-mono text-token-2xs text-warning">
        <ShieldAlert className="size-3" />
        approval-required
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-card/40 px-2 py-0.5 font-mono text-token-2xs text-muted-foreground">
      <ShieldOff className="size-3" />
      private
    </span>
  );
}

function FreshnessIcon({ freshness }: { freshness: string }) {
  if (freshness === "fresh") return <CheckCircle2 className="size-3 text-mint" />;
  if (freshness === "stale" || freshness === "possibly_stale")
    return <AlertTriangle className="size-3 text-warning" />;
  if (freshness === "missing") return <ShieldOff className="size-3 text-muted-foreground" />;
  return <Clock className="size-3 text-muted-foreground" />;
}

function EvidenceSources({ sources }: { sources: EvidenceSource[] }) {
  if (!sources.length) return null;
  return (
    <div className="mt-2">
      <div className="mb-1 font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
        Sources
      </div>
      <ul className="space-y-1.5">
        {sources.map((src, i) => (
          <li key={i} className="flex items-start gap-2 text-token-xs text-foreground/80">
            <FreshnessIcon freshness={src.freshness} />
            <span>
              <span className="font-mono text-foreground/60">{src.name}</span>
              {" — "}
              {src.summary}
              {src.generatedAt && (
                <span className="ml-1 text-muted-foreground">
                  ({new Date(src.generatedAt).toUTCString().slice(5, 22)})
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ActionEvidenceList({
  actions,
  boundary,
}: {
  actions: ActionEvidence[];
  boundary: Boundary;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  if (!actions.length) {
    return (
      <div>
        <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
          Evidence
        </div>
        <p className="mt-2 text-token-xs text-muted-foreground">
          No ranked actions available for this run. The run may have been queued or interrupted
          before completing.
        </p>
      </div>
    );
  }
  return (
    <div>
      <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
        Evidence · {actions.length} ranked action{actions.length !== 1 ? "s" : ""}
      </div>
      <ul className="mt-2 space-y-2">
        {actions.map((action, i) => {
          const isOpen = expanded === action.id;
          const ev = action.evidence;
          return (
            <li key={action.id} className="rounded-token border border-border bg-background/40">
              <button
                type="button"
                onClick={() => setExpanded(isOpen ? null : action.id)}
                className="flex w-full items-start justify-between gap-3 p-3 text-left focus-ring"
                aria-expanded={isOpen}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-token-xs text-foreground/90">
                      {i + 1}. {action.actionType.replace(/_/g, " ")}
                    </span>
                    <SafetyClassBadge
                      safetyClass={action.safetyClass}
                      approvalRequired={action.approvalRequired}
                    />
                    {action.status === "blocked" && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-destructive/30 bg-destructive/10 px-2 py-0.5 font-mono text-token-2xs text-destructive">
                        blocked
                      </span>
                    )}
                  </div>
                  {action.targetRepoFullName && (
                    <div className="mt-0.5 font-mono text-token-2xs text-muted-foreground">
                      {action.targetRepoFullName}
                    </div>
                  )}
                  <p className="mt-1 text-token-xs text-foreground/80">{action.recommendation}</p>
                </div>
                <ChevronRight
                  className={cn(
                    "mt-1 size-4 shrink-0 text-muted-foreground transition-transform",
                    isOpen && "rotate-90",
                  )}
                />
              </button>

              {isOpen && (
                <div className="border-t border-border px-3 pb-3 pt-2 space-y-3">
                  {boundary !== "public" && action.why.length > 0 && (
                    <div>
                      <div className="mb-1 font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                        Why
                      </div>
                      <ul className="space-y-1">
                        {action.why.map((reason, j) => (
                          <li
                            key={j}
                            className="flex items-start gap-1.5 text-token-xs text-foreground/80"
                          >
                            <CheckCircle2 className="mt-0.5 size-3 shrink-0 text-mint" />
                            {reason}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {action.blockedBy.length > 0 && (
                    <div>
                      <div className="mb-1 font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                        Blocked by
                      </div>
                      <ul className="space-y-1">
                        {action.blockedBy.map((blocker, j) => (
                          <li
                            key={j}
                            className="flex items-start gap-1.5 text-token-xs text-destructive/80"
                          >
                            <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                            {blocker}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {boundary !== "public" &&
                    (action.scoreabilityImpact || action.riskImpact || action.maintainerImpact) && (
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                        {action.scoreabilityImpact && (
                          <div>
                            <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                              Scoreability
                            </div>
                            <p className="mt-0.5 text-token-xs text-foreground/80">
                              {action.scoreabilityImpact}
                            </p>
                          </div>
                        )}
                        {action.riskImpact && (
                          <div>
                            <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                              Risk
                            </div>
                            <p className="mt-0.5 text-token-xs text-foreground/80">
                              {action.riskImpact}
                            </p>
                          </div>
                        )}
                        {action.maintainerImpact && (
                          <div>
                            <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                              Maintainer
                            </div>
                            <p className="mt-0.5 text-token-xs text-foreground/80">
                              {action.maintainerImpact}
                            </p>
                          </div>
                        )}
                      </div>
                    )}

                  <div>
                    <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                      Public-safe summary
                    </div>
                    <p className="mt-0.5 text-token-xs text-foreground/80">
                      {action.publicSafeSummary}
                    </p>
                  </div>

                  {action.rerunWhen && (
                    <div>
                      <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                        Rerun when
                      </div>
                      <p className="mt-0.5 text-token-xs text-foreground/80">{action.rerunWhen}</p>
                    </div>
                  )}

                  {boundary !== "public" && ev && (
                    <div>
                      <div className="flex items-center gap-2">
                        <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                          Provenance
                        </div>
                        <span
                          className={cn(
                            "font-mono text-token-2xs",
                            ev.confidence === "high"
                              ? "text-mint"
                              : ev.confidence === "medium"
                                ? "text-foreground/60"
                                : "text-warning",
                          )}
                        >
                          {ev.confidence} confidence · {ev.freshness}
                        </span>
                      </div>
                      <p className="mt-1 text-token-xs text-foreground/70">{ev.sourceSummary}</p>
                      <EvidenceSources sources={ev.sources} />
                      {ev.warnings.length > 0 && (
                        <ul className="mt-2 space-y-1">
                          {ev.warnings.map((w, j) => (
                            <li
                              key={j}
                              className="flex items-start gap-1.5 text-token-xs text-warning/80"
                            >
                              <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                              {w}
                            </li>
                          ))}
                        </ul>
                      )}
                      {ev.assumptions.length > 0 && (
                        <div className="mt-2">
                          <div className="mb-1 font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                            Assumptions
                          </div>
                          <ul className="space-y-1">
                            {ev.assumptions.map((a, j) => (
                              <li key={j} className="text-token-xs text-muted-foreground">
                                {a}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
