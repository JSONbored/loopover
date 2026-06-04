import { Stat, StatusPill } from "@/components/site/control-primitives";

type WeeklyMetric = {
  id: string;
  label: string;
  value: number;
  detail: string;
};

type RoleRow = {
  role: string;
  count: number;
  activeActors: number;
  activeRepos: number;
};

type RetentionWindow = {
  window: string;
  activeActors: number;
  retainedActors: number;
  retentionRate: number;
  capped: boolean;
  byRole: Array<{
    role: string;
    activeActors: number;
    retainedActors: number;
    retentionRate: number;
  }>;
};

type CommandBucket = {
  command: string;
  feedbackCount: number;
  usefulCount: number;
  notUsefulCount: number;
  usefulnessRate: number | null;
};

export function WeeklyValueMetricsPanel({
  metrics,
  warnings,
}: {
  metrics: WeeklyMetric[];
  warnings: string[];
}) {
  if (metrics.length === 0) return null;
  return (
    <section className="rounded-token border border-border bg-transparent p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-token-lg font-semibold">Weekly value metrics</h2>
          <p className="mt-1 text-token-xs text-muted-foreground">
            Rollup-backed adoption and ecosystem value without raw secrets or source data.
          </p>
        </div>
        <StatusPill status={warnings.length > 0 ? "degraded" : "ready"}>
          {warnings.length > 0 ? `${warnings.length} warning(s)` : "rollup-backed"}
        </StatusPill>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {metrics.map((metric) => (
          <Stat
            key={metric.id}
            label={metric.label}
            value={String(metric.value)}
            hint={<span className="text-muted-foreground">{metric.detail}</span>}
          />
        ))}
      </div>
      {warnings.length > 0 ? (
        <ul className="mt-4 space-y-1 text-token-xs text-muted-foreground">
          {warnings.slice(0, 4).map((warning) => (
            <li key={warning}>· {warning}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function AdoptionRetentionPanel({
  byRole,
  retention,
  activationByRole,
}: {
  byRole: RoleRow[];
  retention: RetentionWindow[];
  activationByRole: Array<{
    role: string;
    firstUsefulActionActors: number;
    doctorPassActors: number;
  }>;
}) {
  if (byRole.length === 0 && retention.length === 0) return null;
  return (
    <section className="rounded-token border border-border bg-transparent p-5">
      <h2 className="font-display text-token-lg font-semibold">Adoption & retention</h2>
      <p className="mt-1 text-token-xs text-muted-foreground">
        Active miners and maintainers from hashed rollups — no wallets, hotkeys, or private source
        data.
      </p>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <DimensionList
          title="Active by role"
          rows={byRole.map((row) => ({ key: row.role, count: row.activeActors }))}
        />
        <DimensionList
          title="Activation funnel"
          rows={activationByRole.map((row) => ({
            key: row.role,
            count: row.firstUsefulActionActors,
            hint: `${row.doctorPassActors} doctor pass`,
          }))}
        />
        <div className="rounded-token border border-border bg-background/40 p-3">
          <div className="text-token-xs font-medium uppercase text-muted-foreground">
            Retention windows
          </div>
          <div className="mt-3 space-y-3">
            {retention.length > 0 ? (
              retention.map((window) => (
                <div key={window.window} className="text-token-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">
                      {formatRetentionWindow(window.window)}
                    </span>
                    <span className="font-mono text-mint">
                      {formatPercent(window.retentionRate)}
                    </span>
                  </div>
                  <div className="mt-1 font-mono text-token-2xs text-muted-foreground">
                    {window.retainedActors}/{window.activeActors} actors
                    {window.capped ? " · capped scan" : ""}
                  </div>
                  {window.byRole.length > 0 ? (
                    <div className="mt-2 space-y-1">
                      {window.byRole.slice(0, 4).map((row) => (
                        <div
                          key={`${window.window}-${row.role}`}
                          className="flex justify-between text-token-xs"
                        >
                          <span>{row.role}</span>
                          <span className="font-mono">{formatPercent(row.retentionRate)}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))
            ) : (
              <div className="text-token-xs text-muted-foreground">No retention rollups yet</div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

type CommandUsefulnessTotals = Omit<CommandBucket, "command"> & { answerCount: number };

export function CommandUsefulnessPanel({
  totals,
  commands,
  windowDays,
}: {
  totals: CommandUsefulnessTotals;
  commands: CommandBucket[];
  windowDays: number;
}) {
  return (
    <section className="rounded-token border border-border bg-transparent p-5">
      <h2 className="font-display text-token-lg font-semibold">Command usefulness</h2>
      <p className="mt-1 text-token-xs text-muted-foreground">
        Maintainer feedback on GitHub command answers — separate from security audit events.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Feedback"
          value={String(totals.feedbackCount)}
          hint={<span>last {windowDays} days</span>}
        />
        <Stat
          label="Useful votes"
          value={String(totals.usefulCount)}
          hint={<span className="text-mint">positive signal</span>}
        />
        <Stat
          label="Usefulness rate"
          value={
            totals.usefulnessRate === null ? "—" : `${Math.round(totals.usefulnessRate * 100)}%`
          }
          hint={<span>answers: {totals.answerCount}</span>}
        />
        <Stat
          label="Not useful"
          value={String(totals.notUsefulCount)}
          hint={<span>improvement signal</span>}
        />
      </div>
      {commands.length > 0 ? (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[480px] text-left text-token-sm">
            <thead className="border-b border-border text-token-xs uppercase text-muted-foreground">
              <tr>
                <th className="py-2 pr-4 font-medium">Command</th>
                <th className="py-2 pr-4 font-medium">Feedback</th>
                <th className="py-2 pr-4 font-medium">Useful</th>
                <th className="py-2 font-medium">Rate</th>
              </tr>
            </thead>
            <tbody>
              {commands.slice(0, 8).map((row) => (
                <tr key={row.command} className="border-b border-border/60 last:border-0">
                  <td className="py-2 pr-4 font-mono text-token-xs">{row.command}</td>
                  <td className="py-2 pr-4 font-mono">{row.feedbackCount}</td>
                  <td className="py-2 pr-4 font-mono">{row.usefulCount}</td>
                  <td className="py-2 font-mono">
                    {row.usefulnessRate === null ? "—" : `${Math.round(row.usefulnessRate * 100)}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-4 text-token-xs text-muted-foreground">
          No command feedback recorded in this window.
        </p>
      )}
    </section>
  );
}

export function ProductUsageBreakdownPanel({
  byEvent,
  bySurface,
  byTool = [],
}: {
  byEvent: Array<{ eventName: string; count: number }>;
  bySurface: Array<{ surface: string; count: number }>;
  byTool?: Array<{ key: string; count: number }>;
}) {
  const highlights = pickUsageHighlights(byEvent, byTool);
  return (
    <section className="rounded-token border border-border bg-transparent p-5">
      <h2 className="font-display text-token-lg font-semibold">Product usage breakdown</h2>
      <p className="mt-1 text-token-xs text-muted-foreground">
        MCP commands, GitHub commands, PR packets, quiet skips, decision-pack tools, and drift
        signals (7-day window).
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {highlights.map((item) => (
          <Stat
            key={item.id}
            label={item.label}
            value={String(item.value)}
            hint={<span>{item.detail}</span>}
          />
        ))}
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <DimensionList
          title="Top events"
          rows={byEvent.slice(0, 6).map((row) => ({ key: row.eventName, count: row.count }))}
        />
        <DimensionList
          title="By surface"
          rows={bySurface.slice(0, 6).map((row) => ({ key: row.surface, count: row.count }))}
        />
      </div>
    </section>
  );
}

function DimensionList({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ key: string; count: number; hint?: string }>;
}) {
  return (
    <div className="rounded-token border border-border bg-background/40 p-3">
      <div className="text-token-xs font-medium uppercase text-muted-foreground">{title}</div>
      <div className="mt-3 space-y-2">
        {rows.length > 0 ? (
          rows.map((row) => (
            <div key={row.key} className="flex items-center justify-between gap-3 text-token-sm">
              <span className="min-w-0 truncate font-mono text-token-xs">{row.key}</span>
              <span className="shrink-0 font-mono text-mint">{row.count}</span>
            </div>
          ))
        ) : (
          <div className="text-token-xs text-muted-foreground">No data</div>
        )}
      </div>
    </div>
  );
}

function pickUsageHighlights(
  byEvent: Array<{ eventName: string; count: number }>,
  byTool: Array<{ key: string; count: number }>,
) {
  const sum = (names: string[]) =>
    byEvent
      .filter((row) => names.includes(row.eventName))
      .reduce((total, row) => total + row.count, 0);
  const mcp = sum(["mcp_request", "mcp_tool_called"]);
  const github = sum(["agent_command_replied", "agent_command_skipped"]);
  const quietSkips = sum(["agent_command_skipped"]);
  const prPackets = sum(["agent_pr_packet_completed"]);
  const preflights = sum(["agent_preflight_branch_completed", "local_branch_analysis_completed"]);
  const decisionPacks = byTool
    .filter((row) => row.key.includes("decision_pack"))
    .reduce((total, row) => total + row.count, 0);
  const driftSignals = sum(["upstream_drift_detected", "upstream_drift_filed"]);
  return [
    { id: "mcp", label: "MCP usage", value: mcp, detail: "requests + tool calls" },
    { id: "github", label: "GitHub commands", value: github, detail: "replies + quiet skips" },
    { id: "quiet", label: "Quiet skips", value: quietSkips, detail: "intentional no-reply" },
    { id: "packets", label: "PR packets", value: prPackets, detail: "completed packets" },
    {
      id: "preflight",
      label: "PR preflights",
      value: preflights,
      detail: "branch preflight events",
    },
    {
      id: "decision",
      label: "Decision packs",
      value: decisionPacks,
      detail: "MCP decision-pack tool calls",
    },
    {
      id: "drift",
      label: "Drift incidents",
      value: driftSignals,
      detail: "upstream drift product events",
    },
  ];
}

function formatRetentionWindow(window: string): string {
  if (window === "previous_7_days") return "7-day retention";
  if (window === "previous_30_days") return "30-day retention";
  return window.replaceAll("_", " ");
}

function formatPercent(rate: number): string {
  return `${Math.round(rate * 1000) / 10}%`;
}
