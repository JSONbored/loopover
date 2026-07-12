import { CheckCircle2, Loader2, Rocket } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { StatusPill, type Status } from "@/components/site/control-primitives";
import { StateBoundary } from "@/components/site/state-views";
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

type ActivationResponse = {
  repoFullName: string;
  reviewCheckMode: string;
  checkRunMode: string;
  linkedIssueGateMode: string;
  duplicatePrGateMode: string;
  qualityGateMode: string;
};

type Message = { kind: "ok" | "err"; text: string };

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
 * One-step maintainer activation demo (#701): loads GET /activation-preview for a repo (deterministic,
 * no AI run) so a newly-installed maintainer sees concrete "here's what Gittensory would have surfaced"
 * evidence, then a single action button posts /activation to turn on advisory mode. Mirrors the
 * AiReviewSettings / MaintainerSettings repo-picker + load/save shape in this same file group.
 */
export function ActivationPreview({ reviewability }: { reviewability: Array<{ pr: string }> }) {
  const repoOptions = useMemo(() => extractPreviewRepoOptions(reviewability), [reviewability]);
  const [repoFullName, setRepoFullName] = useState(repoOptions[0] ?? "");
  const [preview, setPreview] = useState<ActivationPreviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);

  const base = repoApiBase(repoFullName);
  const hasRepos = repoOptions.length > 0;

  const load = useCallback(async () => {
    const apiBase = repoApiBase(repoFullName);
    if (!apiBase) {
      setPreview(null);
      setLoadError(null);
      return;
    }
    setMessage(null);
    setLoadError(null);
    setLoading(true);
    const result = await apiFetch<ActivationPreviewResponse>(`${apiBase}/activation-preview`, {
      label: "Activation preview",
      credentials: "include",
      silentStatus: true,
    });
    if (result.ok) {
      setPreview(result.data);
    } else {
      setPreview(null);
      setLoadError(result.message);
    }
    setLoading(false);
  }, [repoFullName]);

  useEffect(() => {
    void load();
  }, [load]);

  async function activate() {
    if (!base) return;
    setBusy(true);
    const result = await apiFetch<ActivationResponse>(`${base}/activation`, {
      method: "POST",
      label: "Enable advisory mode",
      credentials: "include",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
    });
    setBusy(false);
    if (result.ok) {
      // Reload first — `load()` clears any prior message, so the success message must be set after it settles.
      await load();
      setMessage({
        kind: "ok",
        text: "Advisory mode enabled. Gittensory will now surface guidance on new PRs.",
      });
    } else {
      setMessage({ kind: "err", text: result.message });
    }
  }

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
            See what Gittensory would have surfaced on this repo's recent pull requests, then enable
            advisory mode in one step. Deterministic — never runs AI, never blocks a merge.
          </p>
        </div>
        {preview ? (
          <StatusPill status={preview.recommendedAction === null ? "ready" : "info"}>
            gate {preview.currentReviewCheckMode}
          </StatusPill>
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
          emptyDescription="Gittensory will start surfacing guidance once this repo has pull requests cached."
        >
          {!base ? (
            <p className="text-token-sm text-muted-foreground">
              {hasRepos
                ? "Settings are unavailable for this repository."
                : "Enter an installed repository to preview activation."}
            </p>
          ) : preview ? (
            <ActivationPreviewBody
              preview={preview}
              busy={busy}
              onActivate={() => void activate()}
            />
          ) : null}
        </StateBoundary>
      </div>

      <span
        role="status"
        aria-live="polite"
        className={`mt-4 block text-token-xs ${message ? (message.kind === "ok" ? "text-mint" : "text-warning") : "sr-only"}`}
      >
        {message?.text ?? ""}
      </span>
    </section>
  );
}

function ActivationPreviewBody({
  preview,
  busy,
  onActivate,
}: {
  preview: ActivationPreviewResponse;
  busy: boolean;
  onActivate: () => void;
}) {
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
        <div className="overflow-hidden rounded-token border-hairline">
          <table className="w-full text-left text-token-xs">
            <thead className="border-b-hairline font-mono uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-normal">PR</th>
                <th className="px-3 py-2 font-normal">Title</th>
                <th className="px-3 py-2 font-normal">Severity</th>
                <th className="px-3 py-2 font-normal">Findings</th>
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
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        {preview.recommendedAction === "enable_advisory" ? (
          <button
            type="button"
            disabled={busy}
            aria-busy={busy}
            onClick={onActivate}
            className="inline-flex items-center gap-2 rounded-token border border-mint/40 bg-mint px-3 py-2 text-token-xs font-medium text-primary-foreground transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Rocket className="size-3.5" />}
            Enable advisory mode
          </button>
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
