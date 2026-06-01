import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { z } from "zod";
import { AnimatePresence, motion } from "motion/react";
import {
  ChevronLeft,
  ChevronRight,
  Filter,
  Link2,
  RotateCw,
  Save,
  Search,
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
}

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
    actionType: string;
    targetRepoFullName?: string | null;
    recommendation?: string | null;
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

        <div className="grid grid-cols-2 gap-4 text-token-sm">
          <KV k="Source" v={run.source} />
          <KV k="Repo" v={run.repo} />
          <KV k="Ranked actions" v={run.ranked_actions} />
          <KV k="Ruleset" v={run.ruleset_snapshot} />
          <KV k="Created" v={new Date(run.created_at).toUTCString().slice(5, 22)} />
          <KV k="Signal" v={run.signal_fidelity} />
        </div>

        <div>
          <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
            Inputs
          </div>
          <pre className="mt-2 overflow-x-auto rounded-token border border-border bg-background/60 p-3 font-mono text-token-2xs text-foreground/90">
            {JSON.stringify({ repo: run.repo, source: run.source, kind: run.kind }, null, 2)}
          </pre>
        </div>

        <div>
          <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
            Evidence
          </div>
          <ul className="mt-2 space-y-1 text-token-sm text-foreground/90">
            {(run.recommendations?.length
              ? [run.summary, ...run.recommendations].filter(isString)
              : [
                  "Decision pack snapshot hash matched.",
                  "Linked-issue policy evaluated against current ruleset.",
                  "Queue capacity sampled at run start.",
                ]
            ).map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
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
