import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Check, Copy, Download, History, Loader2, RefreshCw } from "lucide-react";

import { KeyValueGrid, StatusPill, type Status } from "@/components/site/control-primitives";
import { McpVersionBadge } from "@/components/site/mcp-version-badge";
import { StatCard } from "@/components/site/primitives";
import { StateBoundary } from "@/components/site/state-views";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiFetch } from "@/lib/api/request";
import { getApiOrigin } from "@/lib/api/origin";
import { useApiResource } from "@/lib/api/use-api-resource";
import { useSession } from "@/lib/api/session";
import {
  buildMinerCommandActions,
  type MinerCommandAction,
  type MinerCommandState,
} from "@/lib/miner-commands";
import { cn } from "@/lib/utils";

const LANE_TONE: Record<string, Status> = {
  pursue: "ready",
  "cleanup-first": "warn",
  "maintainer-lane": "info",
  avoid: "blocked",
};

const CHANGE_TONE: Record<RecommendationChange["status"], Status> = {
  new: "info",
  changed: "warn",
  unchanged: "ready",
};

type RecommendationSignalGroup =
  "repo_state" | "contributor_state" | "validation_state" | "policy_context";

type RecommendationChange = {
  status: "new" | "changed" | "unchanged";
  summary: string;
  labels: Array<{
    kind: RecommendationSignalGroup;
    label: string;
    before?: string;
    after?: string;
  }>;
};

type RerunReasonGroup = {
  group: RecommendationSignalGroup;
  title: string;
  reasons: string[];
};

type MinerDashboard = {
  status: "ready" | "needs_refresh";
  login: string;
  nextActions: Array<
    Record<string, unknown> & {
      change?: RecommendationChange;
      rerunReasons?: RerunReasonGroup[];
    }
  >;
  blockers: Array<{
    group: string;
    items: Array<{ code: string; title: string; howToClear: string }>;
  }>;
  projections: Array<{ name: string; label: string; weight: number; note: string }>;
  repoFit: Array<
    Record<string, unknown> & {
      lane?: string;
      repoFullName?: string;
      recommendation?: string;
      why?: string;
      rationale?: string;
      change?: RecommendationChange;
      rerunReasons?: RerunReasonGroup[];
    }
  >;
  mcp?: { snapshot?: string | null; drift?: string | null; lastRun?: string | null };
};

export function MinerPanel() {
  const { session } = useSession();
  const login = session?.login ?? "";
  const dashboard = useApiResource<MinerDashboard>(
    `/v1/app/miner-dashboard?login=${encodeURIComponent(login)}`,
    "Miner dashboard",
    undefined,
    { enabled: Boolean(login) },
  );
  const data = dashboard.status === "ready" ? dashboard.data : null;
  const blockerCount = data?.blockers.reduce((count, group) => count + group.items.length, 0) ?? 0;
  const isEmpty =
    data !== null &&
    data.nextActions.length === 0 &&
    blockerCount === 0 &&
    data.repoFit.length === 0;
  const commandActions = buildMinerCommandActions({
    login: login || null,
    repoFullName: data ? minerCommandRepoCandidate(data) : null,
  });

  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  const [changelogOpen, setChangelogOpen] = useState(false);

  const refreshPack = async () => {
    if (!login || refreshing) return;
    setRefreshing(true);
    setRefreshNote(null);
    const result = await apiFetch<{ status: string }>(
      `${getApiOrigin().replace(/\/$/, "")}/v1/app/miner-dashboard/refresh?login=${encodeURIComponent(login)}`,
      { method: "POST", label: "Refresh decision pack", credentials: "include" },
    );
    if (result.ok) {
      // The rebuild runs as a queued job, so wait briefly then re-fetch the freshly persisted pack.
      setRefreshNote("Rebuild queued — refreshing shortly…");
      window.setTimeout(() => {
        void dashboard.reload();
        setRefreshing(false);
        setRefreshNote(null);
      }, 4000);
    } else {
      setRefreshNote(result.message);
      setRefreshing(false);
    }
  };

  const exportPack = () => {
    if (!data || typeof document === "undefined") return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `decision-pack-${login || "miner"}-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const changelog = data ? collectChangelog(data) : { changes: [], reasons: [] };
  const hasChangelog = changelog.changes.length > 0 || changelog.reasons.length > 0;

  return (
    <div className="space-y-6">
      <MinerPanelActions
        canRefresh={Boolean(login)}
        canExport={Boolean(data)}
        hasChangelog={hasChangelog}
        refreshing={refreshing}
        refreshNote={refreshNote}
        onRefresh={() => void refreshPack()}
        onExport={exportPack}
        onChangelog={() => setChangelogOpen(true)}
      />
      <MinerCommandActions commands={commandActions} />
      <StateBoundary
        isLoading={dashboard.status === "loading"}
        isEmpty={isEmpty}
        onRetry={dashboard.reload}
        onRefresh={dashboard.reload}
        loadingTitle="Loading miner signals…"
        emptyTitle="No miner actions yet"
        emptyDescription="Once a decision pack or branch analysis exists, ranked next actions and blockers will appear here."
      >
        {dashboard.status === "error" ? (
          <div className="rounded-token border border-warning/30 bg-warning/[0.04] p-4 text-token-sm text-warning">
            Miner dashboard is unavailable right now ({dashboard.error}).
          </div>
        ) : data ? (
          <div className="space-y-6">
            <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard label="Next actions" value={data.nextActions.length} hint={data.status} />
              <StatCard label="Open blockers" value={blockerCount} hint="decision pack" />
              <StatCard label="Repo fit" value={data.repoFit.length} hint="ranked repos" />
              <StatCard
                label="Drift"
                value={data.mcp?.drift ?? "unknown"}
                hint="upstream ruleset"
              />
            </section>

            <section className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
              <div className="rounded-token border-hairline bg-card p-5">
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="font-display text-token-lg font-semibold">Next actions</h2>
                  <span className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                    live
                  </span>
                </div>
                <ol className="space-y-3">
                  {data.nextActions.map((action, index) => (
                    <li
                      key={`${stringField(action, "actionKind", "action")}-${index}`}
                      className="rounded-token border-hairline bg-background/40 p-4 transition-colors hover:border-strong"
                    >
                      <div className="flex items-start gap-3">
                        <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-token border-hairline bg-card font-mono text-token-2xs text-muted-foreground">
                          {index + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="font-medium text-foreground">
                              {stringField(action, "actionKind", "Next action")}
                            </h3>
                            <StatusPill status="info">
                              {stringField(action, "recommendation", "recommended")}
                            </StatusPill>
                          </div>
                          <p className="mt-1 text-token-sm text-muted-foreground leading-token-relaxed">
                            {stringField(
                              action,
                              "rationale",
                              stringField(action, "why", "No rationale recorded."),
                            )}
                          </p>
                          <div className="mt-2 flex flex-wrap items-center gap-2 font-mono text-token-2xs text-muted-foreground">
                            <span>{stringField(action, "repoFullName", "repo pending")}</span>
                          </div>
                          <RecommendationChangeDetails
                            change={action.change}
                            rerunReasons={action.rerunReasons}
                          />
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>

              <div className="space-y-6">
                <div className="rounded-token border-hairline bg-card p-5">
                  <h2 className="font-display text-token-lg font-semibold">
                    Scoreability projections
                  </h2>
                  <p className="mt-1 text-token-xs text-muted-foreground">
                    Priority weight from the live decision pack. Not a payout estimate.
                  </p>
                  <div className="mt-4 space-y-3">
                    {data.projections.map((projection) => (
                      <div key={`${projection.name}-${projection.label}`}>
                        <div className="flex items-center justify-between text-token-xs">
                          <span className="text-foreground/90">{projection.label}</span>
                          <span className="font-mono text-muted-foreground">
                            {Math.round(projection.weight * 100)}
                          </span>
                        </div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-mint transition-all duration-500"
                            style={{ width: `${projection.weight * 100}%` }}
                          />
                        </div>
                        <div className="mt-1 text-token-2xs text-muted-foreground">
                          {projection.note}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-token border-hairline bg-card p-5">
                  <h2 className="font-display text-token-lg font-semibold">MCP status</h2>
                  <div className="mt-3 flex items-center gap-2">
                    <McpVersionBadge />
                    <StatusPill status={data.status === "ready" ? "ready" : "warn"}>
                      {data.status}
                    </StatusPill>
                  </div>
                  <KeyValueGrid
                    className="mt-4"
                    rows={[
                      { k: "Snapshot", v: data.mcp?.snapshot ?? "missing" },
                      { k: "Drift", v: data.mcp?.drift ?? "unknown" },
                      { k: "Last run", v: data.mcp?.lastRun ?? "none" },
                    ]}
                  />
                </div>
              </div>
            </section>

            <section className="grid gap-6 lg:grid-cols-2">
              <div className="rounded-token border-hairline bg-card p-5">
                <h2 className="font-display text-token-lg font-semibold">Scoreability blockers</h2>
                <p className="mt-1 text-token-xs text-muted-foreground">
                  Each blocker links to how to clear it.{" "}
                  <Link
                    to="/docs/scoreability"
                    className="text-mint underline-offset-4 hover:underline"
                  >
                    See scoreability docs →
                  </Link>
                </p>
                <div className="mt-4 space-y-4">
                  {data.blockers.map((group) => (
                    <div key={group.group}>
                      <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                        {group.group}
                      </div>
                      <ul className="mt-2 space-y-2">
                        {group.items.map((item) => (
                          <li
                            key={item.code}
                            className="rounded-token border-hairline bg-background/40 px-3 py-2 transition-colors hover:border-strong"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-token-sm text-foreground">{item.title}</span>
                              <code className="font-mono text-token-2xs text-muted-foreground">
                                {item.code}
                              </code>
                            </div>
                            <p className="mt-1 text-token-xs text-muted-foreground">
                              {item.howToClear}
                            </p>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-token border-hairline bg-card p-5">
                <h2 className="font-display text-token-lg font-semibold">Repo fit</h2>
                <p className="mt-1 text-token-xs text-muted-foreground">
                  Where to spend time, and where not to.
                </p>
                <table className="mt-4 w-full text-left text-token-sm">
                  <thead>
                    <tr className="border-b-hairline font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                      <th className="py-2 pr-3 font-normal">Repo</th>
                      <th className="py-2 pr-3 font-normal">Lane</th>
                      <th className="py-2 font-normal">Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.repoFit.map((repo, index) => {
                      const lane = repo.lane ?? "pursue";
                      return (
                        <tr
                          key={`${repo.repoFullName ?? index}`}
                          className="border-b-hairline last:border-b-0 transition-colors hover:bg-muted/40"
                        >
                          <td className="py-2 pr-3 align-top">
                            <div className="break-all font-mono text-token-xs text-foreground/90">
                              {repo.repoFullName ?? "repo pending"}
                            </div>
                            <RecommendationChangeInline change={repo.change} />
                          </td>
                          <td className="py-2 pr-3 align-top">
                            <StatusPill status={LANE_TONE[lane] ?? "info"}>{lane}</StatusPill>
                          </td>
                          <td className="py-2 align-top text-token-xs text-muted-foreground">
                            {repo.why ??
                              repo.rationale ??
                              repo.recommendation ??
                              "No rationale recorded."}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        ) : null}
      </StateBoundary>
      <ChangelogDialog open={changelogOpen} onOpenChange={setChangelogOpen} changelog={changelog} />
    </div>
  );
}

type ChangelogEntry = { label: string; change: RecommendationChange };
type Changelog = { changes: ChangelogEntry[]; reasons: RerunReasonGroup[] };

// Aggregate the per-recommendation old-vs-new diffs and re-run reasons the API already attaches to each
// next-action / repo-fit row into one changelog view. The inline cards truncate (2 reasons); the modal shows
// everything. `unchanged` rows are skipped from the diff list — only new/changed recommendations are news.
function collectChangelog(data: MinerDashboard): Changelog {
  const changes: ChangelogEntry[] = [];
  const reasonsByGroup = new Map<string, RerunReasonGroup>();
  const ingest = (
    label: string,
    change?: RecommendationChange,
    rerunReasons?: RerunReasonGroup[],
  ) => {
    if (change && change.status !== "unchanged") changes.push({ label, change });
    for (const group of rerunReasons ?? []) {
      if (group.reasons.length === 0) continue;
      const existing = reasonsByGroup.get(group.group);
      if (existing) {
        existing.reasons = [...new Set([...existing.reasons, ...group.reasons])];
      } else {
        reasonsByGroup.set(group.group, { ...group, reasons: [...group.reasons] });
      }
    }
  };
  for (const action of data.nextActions) {
    ingest(stringField(action, "actionKind", "Next action"), action.change, action.rerunReasons);
  }
  for (const repo of data.repoFit) {
    ingest(stringField(repo, "repoFullName", "Repo"), repo.change, repo.rerunReasons);
  }
  return { changes, reasons: [...reasonsByGroup.values()] };
}

function MinerPanelActions({
  canRefresh,
  canExport,
  hasChangelog,
  refreshing,
  refreshNote,
  onRefresh,
  onExport,
  onChangelog,
}: {
  canRefresh: boolean;
  canExport: boolean;
  hasChangelog: boolean;
  refreshing: boolean;
  refreshNote: string | null;
  onRefresh: () => void;
  onExport: () => void;
  onChangelog: () => void;
}) {
  const buttonClass =
    "inline-flex items-center gap-2 rounded-token border-hairline bg-card px-3 py-2 text-token-xs font-medium text-foreground transition-colors hover:border-strong disabled:cursor-not-allowed disabled:opacity-50";
  return (
    <section
      className="flex flex-wrap items-center justify-between gap-3"
      aria-label="Decision pack actions"
    >
      <div>
        <h2 className="font-display text-token-lg font-semibold">Decision pack</h2>
        <div className="mt-1 text-token-xs text-muted-foreground">
          Rebuild from the web, review what changed, or export the pack.
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onChangelog}
          disabled={!hasChangelog}
          className={buttonClass}
          title={
            hasChangelog ? "View the recommendation changelog" : "No changes since the last pack"
          }
        >
          <History className="size-3.5" /> Changelog
        </button>
        <button type="button" onClick={onExport} disabled={!canExport} className={buttonClass}>
          <Download className="size-3.5" /> Export
        </button>
        <button
          type="button"
          onClick={onRefresh}
          disabled={!canRefresh || refreshing}
          aria-busy={refreshing}
          className={buttonClass}
        >
          {refreshing ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
        <span
          role="status"
          aria-live="polite"
          className={`w-full text-right text-token-2xs sm:w-auto ${refreshNote ? "text-muted-foreground" : "sr-only"}`}
        >
          {refreshNote ?? ""}
        </span>
      </div>
    </section>
  );
}

function ChangelogDialog({
  open,
  onOpenChange,
  changelog,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  changelog: Changelog;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Recommendation changelog</DialogTitle>
          <DialogDescription>
            What changed since the previous decision pack, and why it re-ran. Deterministic signals
            only — no payout or reward estimates.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div>
            <h3 className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
              Old vs new ({changelog.changes.length})
            </h3>
            {changelog.changes.length === 0 ? (
              <p className="mt-2 text-token-sm text-muted-foreground">
                No recommendations changed since the last pack.
              </p>
            ) : (
              <ul className="mt-2 space-y-3">
                {changelog.changes.map((entry, index) => (
                  <li
                    key={`${entry.label}-${index}`}
                    className="rounded-token border-hairline bg-background/40 p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill status={CHANGE_TONE[entry.change.status]}>
                        {entry.change.status}
                      </StatusPill>
                      <span className="break-all font-mono text-token-xs text-foreground/90">
                        {entry.label}
                      </span>
                    </div>
                    <p className="mt-1 text-token-xs text-muted-foreground">
                      {entry.change.summary}
                    </p>
                    {entry.change.labels.length > 0 && (
                      <dl className="mt-2 grid gap-x-4 gap-y-1 text-token-2xs sm:grid-cols-2">
                        {entry.change.labels.map((label) => (
                          <div key={`${label.kind}-${label.label}`} className="min-w-0">
                            <dt className="font-mono uppercase tracking-wider text-muted-foreground">
                              {label.label}
                            </dt>
                            <dd className="break-words text-foreground/80">
                              {label.before ? `${label.before} -> ` : ""}
                              {label.after ?? "changed"}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {changelog.reasons.length > 0 && (
            <div>
              <h3 className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                Why it re-ran
              </h3>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                {changelog.reasons.map((group) => (
                  <div key={group.group} className="min-w-0">
                    <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                      {group.title}
                    </div>
                    <ul className="mt-1 space-y-1 text-token-2xs text-muted-foreground">
                      {group.reasons.map((reason) => (
                        <li key={reason} className="break-words">
                          {reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

const COMMAND_STATE_TONE: Record<MinerCommandState, Status> = {
  setup: "info",
  ready: "ready",
  needs_login: "warn",
  needs_repo: "warn",
};

const COMMAND_STATE_LABEL: Record<MinerCommandState, string> = {
  setup: "setup",
  ready: "ready",
  needs_login: "login",
  needs_repo: "repo",
};

function MinerCommandActions({ commands }: { commands: MinerCommandAction[] }) {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);

  const copyCommand = async (command: MinerCommandAction) => {
    if (!command.copyable) return;
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
        throw new Error("clipboard_unavailable");
      }
      await navigator.clipboard.writeText(command.command);
      setFailedId(null);
      setCopiedId(command.id);
      window.setTimeout(
        () => setCopiedId((current) => (current === command.id ? null : current)),
        1600,
      );
    } catch {
      setCopiedId(null);
      setFailedId(command.id);
    }
  };

  return (
    <section className="space-y-3" aria-label="MCP command copy actions">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-token-lg font-semibold">MCP commands</h2>
          <div className="mt-1 text-token-xs text-muted-foreground">
            Local snippets for the active miner state.
          </div>
        </div>
        <StatusPill status="info">local MCP</StatusPill>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {commands.map((command) => {
          const copied = copiedId === command.id;
          const failed = failedId === command.id;
          return (
            <div
              key={command.id}
              className="rounded-token border-hairline bg-card p-3 transition-colors hover:border-strong"
            >
              <div className="flex items-center gap-2">
                <span className="text-token-sm font-medium text-foreground">{command.label}</span>
                <StatusPill status={COMMAND_STATE_TONE[command.state]}>
                  {COMMAND_STATE_LABEL[command.state]}
                </StatusPill>
                <button
                  type="button"
                  onClick={() => void copyCommand(command)}
                  disabled={!command.copyable}
                  aria-label={`Copy ${command.label} command`}
                  className={cn(
                    "ml-auto inline-flex size-8 shrink-0 items-center justify-center rounded-token border-hairline text-muted-foreground transition-all duration-150 hover:border-strong hover:bg-accent hover:text-foreground focus-ring motion-reduce:transition-none",
                    !command.copyable &&
                      "cursor-not-allowed opacity-50 hover:border-border hover:bg-transparent",
                  )}
                >
                  {copied ? <Check className="size-4 text-mint" /> : <Copy className="size-4" />}
                </button>
              </div>
              <code className="mt-2 block min-h-10 overflow-x-auto whitespace-nowrap rounded-token bg-background/70 px-2.5 py-2 font-mono text-token-xs text-foreground/90">
                {command.command}
              </code>
              <div className="mt-2 min-h-4 text-token-2xs text-muted-foreground" aria-live="polite">
                {copied
                  ? "Copied"
                  : failed
                    ? "Copy failed"
                    : command.copyable
                      ? "Ready"
                      : "Needs context"}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function minerCommandRepoCandidate(data: MinerDashboard): string | null {
  const candidates = [...data.nextActions, ...data.repoFit].map((record) =>
    stringField(record, "repoFullName", ""),
  );
  return candidates.find((candidate) => /^[^/\s]+\/[^/\s]+$/.test(candidate)) ?? null;
}

function stringField(record: Record<string, unknown>, key: string, fallback: string): string {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : fallback;
}

function RecommendationChangeDetails({
  change,
  rerunReasons,
}: {
  change?: RecommendationChange;
  rerunReasons?: RerunReasonGroup[];
}) {
  const groups = rerunReasons?.filter((group) => group.reasons.length > 0) ?? [];
  if (!change && groups.length === 0) return null;
  return (
    <div className="mt-3 space-y-3 border-t-hairline pt-3">
      {change && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill status={CHANGE_TONE[change.status]}>{change.status}</StatusPill>
            <span className="text-token-xs text-muted-foreground">{change.summary}</span>
          </div>
          {change.labels.length > 0 && (
            <dl className="grid gap-x-4 gap-y-1 text-token-2xs sm:grid-cols-2">
              {change.labels.map((label) => (
                <div key={`${label.kind}-${label.label}`} className="min-w-0">
                  <dt className="font-mono uppercase tracking-wider text-muted-foreground">
                    {label.label}
                  </dt>
                  <dd className="break-words text-foreground/80">
                    {label.before ? `${label.before} -> ` : ""}
                    {label.after ?? "changed"}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
      {groups.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-2">
          {groups.map((group) => (
            <div key={group.group} className="min-w-0">
              <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                {group.title}
              </div>
              <ul className="mt-1 space-y-1 text-token-2xs text-muted-foreground">
                {group.reasons.slice(0, 2).map((reason) => (
                  <li key={reason} className="break-words">
                    {reason}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RecommendationChangeInline({ change }: { change?: RecommendationChange }) {
  if (!change) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      <StatusPill status={CHANGE_TONE[change.status]}>{change.status}</StatusPill>
      <span className="text-token-2xs text-muted-foreground">{change.summary}</span>
    </div>
  );
}
