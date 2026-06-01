import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Eye, EyeOff } from "lucide-react";

import {
  DiffBlock,
  MiniSparkbar,
  StatusPill,
  type Status,
} from "@/components/site/control-primitives";
import { StatCard } from "@/components/site/primitives";
import { StateBoundary } from "@/components/site/state-views";
import { useApiResource } from "@/lib/api/use-api-resource";
import { cn } from "@/lib/utils";

const BUCKET_TONE: Record<string, Status> = {
  "review-now": "ready",
  review_now: "ready",
  "needs-author": "warn",
  needs_author: "warn",
  watch: "info",
  redirect: "blocked",
};

type MaintainerDashboard = {
  metrics: Array<{ label: string; value: number; spark: number[] }>;
  health: Array<{
    installationId: number;
    accountLogin: string;
    installedReposCount: number;
    status: "healthy" | "needs_attention" | "broken";
    missingPermissions: string[];
    missingEvents: string[];
    checkedAt: string;
  }>;
  reviewability: Array<{
    pr: string;
    title: string;
    author: string;
    bucket: string;
    reason: string;
  }>;
  settingsPreview: { removed: string[]; added: string[] };
};

export function MaintainerPanel() {
  const dashboard = useApiResource<MaintainerDashboard>(
    "/v1/app/maintainer-dashboard",
    "Maintainer dashboard",
  );
  const data = dashboard.status === "ready" ? dashboard.data : null;
  const isEmpty = data !== null && data.health.length === 0 && data.reviewability.length === 0;

  return (
    <StateBoundary
      isLoading={dashboard.status === "loading"}
      isEmpty={isEmpty}
      onRetry={dashboard.reload}
      onRefresh={dashboard.reload}
      loadingTitle="Loading maintainer context…"
      emptyTitle="No maintainer data yet"
      emptyDescription="Install health, reviewability, and surface previews appear after repository data is available."
    >
      {dashboard.status === "error" ? (
        <div className="rounded-token border border-warning/30 bg-warning/[0.04] p-4 text-token-sm text-warning">
          Maintainer dashboard is unavailable right now ({dashboard.error}).
        </div>
      ) : data ? (
        <div className="space-y-6">
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {data.metrics.map((metric) => (
              <StatCard
                key={metric.label}
                label={metric.label}
                value={metric.value.toLocaleString()}
                hint={<MiniSparkbar values={metric.spark} />}
              />
            ))}
          </section>

          <section className="grid gap-6 lg:grid-cols-2">
            <div className="rounded-token border-hairline bg-card p-5">
              <div className="flex items-center justify-between gap-3">
                <h2 className="font-display text-token-lg font-semibold">Install health</h2>
                <StatusPill status="ready">live</StatusPill>
              </div>
              <ul className="mt-4 space-y-3">
                {data.health.map((installation) => (
                  <li
                    key={installation.installationId}
                    className="rounded-token border-hairline bg-background/40 p-3 transition-colors hover:border-strong"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <div className="font-medium">{installation.accountLogin}</div>
                        <div className="font-mono text-token-2xs text-muted-foreground">
                          {installation.installationId} · {installation.installedReposCount} repos
                        </div>
                      </div>
                      <StatusPill
                        status={
                          installation.status === "healthy"
                            ? "ready"
                            : installation.status === "needs_attention"
                              ? "warn"
                              : "blocked"
                        }
                      >
                        {installation.status}
                      </StatusPill>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2 text-token-2xs">
                      <StatusPill
                        status={installation.missingPermissions.length === 0 ? "ready" : "blocked"}
                      >
                        perms {installation.missingPermissions.length === 0 ? "ok" : "missing"}
                      </StatusPill>
                      <StatusPill
                        status={installation.missingEvents.length === 0 ? "ready" : "warn"}
                      >
                        webhook {installation.missingEvents.length === 0 ? "ok" : "lagging"}
                      </StatusPill>
                      <span className="font-mono text-muted-foreground">
                        last event {new Date(installation.checkedAt).toUTCString().slice(5, 22)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>

            <div className="rounded-token border-hairline bg-card p-5">
              <h2 className="font-display text-token-lg font-semibold">Repo settings preview</h2>
              <p className="mt-1 text-token-xs text-muted-foreground">
                Suggested changes to <code className="font-mono">.gittensor.yml</code>.
                Preview-only, no writes.
              </p>
              <div className="mt-3">
                <DiffBlock
                  removed={data.settingsPreview.removed}
                  added={data.settingsPreview.added}
                />
              </div>
            </div>
          </section>

          <section className="rounded-token border-hairline bg-card p-5">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-token-lg font-semibold">Reviewability queue</h2>
              <span className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                private
              </span>
            </div>
            <table className="mt-4 w-full text-left text-token-sm">
              <thead>
                <tr className="border-b-hairline font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                  <th className="py-2 pr-3 font-normal">PR</th>
                  <th className="py-2 pr-3 font-normal">Title</th>
                  <th className="py-2 pr-3 font-normal">Author</th>
                  <th className="py-2 pr-3 font-normal">Bucket</th>
                  <th className="py-2 font-normal">Reason</th>
                </tr>
              </thead>
              <tbody>
                {data.reviewability.map((row) => (
                  <tr
                    key={row.pr}
                    className="border-b-hairline last:border-b-0 transition-colors hover:bg-muted/40"
                  >
                    <td className="py-2 pr-3 font-mono text-token-xs text-foreground/90">
                      {row.pr}
                    </td>
                    <td className="py-2 pr-3">{row.title}</td>
                    <td className="py-2 pr-3 text-token-xs text-muted-foreground">{row.author}</td>
                    <td className="py-2 pr-3">
                      <StatusPill status={BUCKET_TONE[row.bucket] ?? "info"}>
                        {row.bucket}
                      </StatusPill>
                    </td>
                    <td className="py-2 text-token-xs text-muted-foreground">{row.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <SurfacePreview />
        </div>
      ) : null}
    </StateBoundary>
  );
}

type Side = "public" | "private";

function SurfacePreview() {
  const [side, setSide] = useState<Side>("public");
  return (
    <section className="rounded-token border-hairline bg-card p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-token-lg font-semibold">Surface preview</h2>
          <p className="mt-1 text-token-xs text-muted-foreground">
            Flip between what shows on GitHub publicly and what only you see in private MCP / API
            context.
          </p>
        </div>
        <div className="inline-flex rounded-token border-hairline bg-background/40 p-0.5">
          {[
            {
              id: "public" as const,
              label: "Public on GitHub",
              icon: <Eye className="size-3.5" />,
            },
            {
              id: "private" as const,
              label: "Private to you",
              icon: <EyeOff className="size-3.5" />,
            },
          ].map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setSide(option.id)}
              className={cn(
                "inline-flex min-w-0 items-center justify-center gap-1.5 rounded-token px-3 py-1 text-token-xs font-medium leading-token-snug transition-all duration-150 focus-ring motion-reduce:transition-none motion-reduce:active:scale-100 active:scale-[0.98]",
                side === option.id
                  ? "bg-mint/15 text-mint"
                  : "text-muted-foreground hover:text-foreground",
              )}
              aria-pressed={side === option.id}
            >
              {option.icon}
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={side}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.18 }}
          className="mt-4 rounded-token border-hairline bg-background/40 p-4"
        >
          {side === "public" ? (
            <pre className="whitespace-pre-wrap font-mono text-token-xs text-foreground/90">
              {[
                "Gittensory checked public metadata for this PR.",
                "",
                "- No private scorer weights are posted publicly.",
                "- Maintainer-only context stays in MCP/API surfaces.",
              ].join("\n")}
            </pre>
          ) : (
            <pre className="whitespace-pre-wrap font-mono text-token-xs text-foreground/90">
              {[
                "Private maintainer context",
                "",
                "- Decision-pack blockers",
                "- Reviewability score",
                "- Cached contributor outcome history",
              ].join("\n")}
            </pre>
          )}
        </motion.div>
      </AnimatePresence>
    </section>
  );
}
