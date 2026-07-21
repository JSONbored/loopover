import { CheckCircle2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { StatusPill, type Status } from "@/components/site/control-primitives";
import { TableScroll } from "@/components/site/data-table";
import { StateBoundary } from "@/components/site/state-views";
import { formatGeneratedAt } from "@/components/site/app-panels/slop-duplicate-trend-card-model";
import { apiFetch } from "@/lib/api/request";
import { getApiOrigin } from "@/lib/api/origin";
import { extractPreviewRepoOptions, splitRepoFullName } from "@/lib/maintainer-settings-preview";

type ActivationSeverity = "info" | "warning" | "critical";

type ActivationFinding = { code: string; severity: ActivationSeverity; title: string };

type ActivationSample = {
  number: number;
  title: string;
  severity: ActivationSeverity;
  findingCount: number;
  findings: ActivationFinding[];
};

type ActivationPreviewResponse = {
  repoFullName: string;
  generatedAt: string;
  currentReviewCheckMode: "required" | "visible" | "disabled";
  aiReviewConfigured: boolean;
  evaluatedCount: number;
  withFindingsCount: number;
  findingCodeCounts: Array<{ code: string; count: number }>;
  samples: ActivationSample[];
  recommendedAction: "enable_advisory" | null;
  summary: string;
};

const SEVERITY_TONE: Record<ActivationSeverity, Status> = {
  info: "info",
  warning: "warn",
  critical: "blocked",
};

function repoApiBase(repoFullName: string): string | null {
  const target = splitRepoFullName(repoFullName);
  if (!target) return null;
  return `${getApiOrigin().replace(/\/$/, "")}/v1/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
}

/**
 * Maintainer activation demo (#701): loads GET /activation-preview for a repo (deterministic, no AI
 * run) so a newly-installed maintainer sees concrete "here's what LoopOver would have surfaced"
 * evidence. Purely informational — reviewCheckMode and every other gate field it reports on are
 * config-as-code only now (Batch C, loopover#6444), so there is no longer a one-click action this
 * panel can take on the maintainer's behalf; enabling the gate requires editing the repo's own
 * .loopover.yml. Mirrors the AiReviewSettings / MaintainerSettings repo-picker + load shape in this
 * same file group.
 */
export function ActivationPreview({ reviewability }: { reviewability: Array<{ pr: string }> }) {
  const repoOptions = useMemo(() => extractPreviewRepoOptions(reviewability), [reviewability]);
  const [repoFullName, setRepoFullName] = useState(repoOptions[0] ?? "");
  const [preview, setPreview] = useState<ActivationPreviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const base = repoApiBase(repoFullName);
  const hasRepos = repoOptions.length > 0;

  // isCancelled guards against an out-of-order response: a keystroke replaces repoFullName (and re-runs the
  // effect) before an earlier request resolves, so an older fetch must not overwrite the newer repo's state
  // (#7784). Same cancelled-flag idiom as use-polled-fetch.ts -- the flag is flipped in the effect cleanup.
  const load = useCallback(
    async (isCancelled: () => boolean = () => false) => {
      const apiBase = repoApiBase(repoFullName);
      if (!apiBase) {
        setPreview(null);
        setLoadError(null);
        return;
      }
      setLoadError(null);
      setLoading(true);
      const result = await apiFetch<ActivationPreviewResponse>(`${apiBase}/activation-preview`, {
        label: "Activation preview",
        credentials: "include",
        silentStatus: true,
      });
      if (isCancelled()) return;
      if (result.ok) {
        setPreview(result.data);
      } else {
        setPreview(null);
        setLoadError(result.message);
      }
      setLoading(false);
    },
    [repoFullName],
  );

  useEffect(() => {
    let cancelled = false;
    void load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [load]);

  return (
    <section
      className="rounded-token border-hairline bg-card p-5"
      aria-labelledby="activation-preview-title"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="activation-preview-title" className="font-display text-token-lg font-semibold">
            Instant activation preview
          </h2>
          <p className="mt-1 text-token-xs text-muted-foreground">
            See what LoopOver would have surfaced on this repo's recent pull requests. Deterministic
            — never runs AI, never blocks a merge.
          </p>
        </div>
        {preview ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-token-2xs text-muted-foreground">
              generated {formatGeneratedAt(preview.generatedAt)}
            </span>
            <StatusPill status={preview.recommendedAction === null ? "ready" : "info"}>
              gate {preview.currentReviewCheckMode}
            </StatusPill>
          </div>
        ) : null}
      </div>

      <label className="mt-4 block max-w-sm">
        <span className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
          Repository
        </span>
        <input
          value={repoFullName}
          onChange={(event) => setRepoFullName(event.target.value)}
          list="activation-preview-repos"
          placeholder="owner/repo"
          className="mt-1 min-h-10 w-full rounded-token border border-border bg-background/70 px-3 py-2 font-mono text-token-sm text-foreground outline-none transition-colors focus:border-mint"
        />
        <datalist id="activation-preview-repos">
          {repoOptions.map((repo) => (
            <option key={repo} value={repo} />
          ))}
        </datalist>
        {!hasRepos ? (
          <span className="mt-1 block text-token-2xs text-muted-foreground">
            No registered repositories detected yet — type an installed{" "}
            <code className="font-mono">owner/repo</code>.
          </span>
        ) : null}
      </label>

      <div className="mt-6">
        <StateBoundary
          isLoading={Boolean(base) && loading}
          isError={Boolean(base) && !loading && loadError !== null}
          isEmpty={Boolean(base) && !loading && preview !== null && preview.evaluatedCount === 0}
          onRetry={load}
          onRefresh={load}
          loadingTitle="Building activation preview…"
          errorTitle="Couldn't load the activation preview"
          errorDescription={loadError ?? undefined}
          emptyTitle="No recent pull requests yet"
          emptyDescription="LoopOver will start surfacing guidance once this repo has pull requests cached."
        >
          {!base ? (
            <p className="text-token-sm text-muted-foreground">
              {hasRepos
                ? "Settings are unavailable for this repository."
                : "Enter an installed repository to preview activation."}
            </p>
          ) : preview ? (
            <ActivationPreviewBody preview={preview} />
          ) : null}
        </StateBoundary>
      </div>
    </section>
  );
}

function ActivationPreviewBody({ preview }: { preview: ActivationPreviewResponse }) {
  return (
    <div className="space-y-4">
      <p className="text-token-sm text-foreground/90">{preview.summary}</p>

      <div className="grid gap-3 sm:grid-cols-3">
        <MetricTile label="PRs evaluated" value={preview.evaluatedCount} />
        <MetricTile label="Would flag" value={preview.withFindingsCount} />
        <MetricTile
          label="AI review"
          value={preview.aiReviewConfigured ? "configured" : "not set"}
        />
      </div>

      {preview.findingCodeCounts.length > 0 ? (
        <div>
          <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
            Finding types seen
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {preview.findingCodeCounts.map((entry) => (
              <span
                key={entry.code}
                className="rounded-token border-hairline bg-background/40 px-2 py-1 font-mono text-token-2xs text-muted-foreground"
              >
                {entry.code} × {entry.count}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {preview.samples.length > 0 ? (
        <TableScroll className="rounded-token border-hairline" label="Advisory preview sample PRs">
          <table className="w-full text-left text-token-xs">
            <caption className="sr-only">
              Sample pull requests with their title, severity, and finding count.
            </caption>
            <thead className="border-b-hairline font-mono uppercase tracking-wider text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-normal">
                  PR
                </th>
                <th scope="col" className="px-3 py-2 font-normal">
                  Title
                </th>
                <th scope="col" className="px-3 py-2 font-normal">
                  Severity
                </th>
                <th scope="col" className="px-3 py-2 font-normal">
                  Findings
                </th>
              </tr>
            </thead>
            <tbody>
              {preview.samples.map((sample) => (
                <tr key={sample.number} className="border-b-hairline last:border-b-0">
                  <td className="px-3 py-2 font-mono text-foreground/90">#{sample.number}</td>
                  <td className="px-3 py-2">{sample.title}</td>
                  <td className="px-3 py-2">
                    <StatusPill status={SEVERITY_TONE[sample.severity]}>
                      {sample.severity}
                    </StatusPill>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{sample.findingCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        {preview.recommendedAction === "enable_advisory" ? (
          <span className="inline-flex items-center gap-2 rounded-token border-hairline bg-background/40 px-3 py-2 text-token-xs text-muted-foreground">
            Not yet enabled — set <code className="font-mono">gate.checkMode: required</code> (or{" "}
            <code className="font-mono">gate.enabled: true</code>) in this repo's{" "}
            <code className="font-mono">.loopover.yml</code> to turn on advisory mode.
          </span>
        ) : (
          <span className="inline-flex items-center gap-2 rounded-token border border-success/35 bg-success/10 px-3 py-2 text-token-xs text-success">
            <CheckCircle2 className="size-3.5" /> Advisory mode is already enabled
          </span>
        )}
      </div>
    </div>
  );
}

function MetricTile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-token border-hairline bg-background/40 px-3 py-2">
      <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 flex items-center gap-2 text-token-sm font-medium text-foreground">
        {value}
      </div>
    </div>
  );
}
