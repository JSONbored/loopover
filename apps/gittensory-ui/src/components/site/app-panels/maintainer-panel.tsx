import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  CircleSlash,
  ListChecks,
  Play,
  RefreshCw,
  ShieldCheck,
  UserCheck,
} from "lucide-react";

import {
  DiffBlock,
  MiniSparkbar,
  StatusPill,
  type Status,
} from "@/components/site/control-primitives";
import { ActivationPreview } from "@/components/site/app-panels/activation-preview";
import { AiReviewSettings } from "@/components/site/app-panels/ai-review-settings";
import { ContributorQualityTable } from "@/components/site/app-panels/contributor-quality-table";
import type { MaintainerTopContributor } from "@/components/site/app-panels/contributor-quality-table-model";
import { MaintainerSettings } from "@/components/site/app-panels/maintainer-settings";
import { OnboardingPreviewCard } from "@/components/site/app-panels/onboarding-preview-card";
import { CheckRunReadinessTable } from "@/components/site/check-run-readiness-table";
import type { CheckRunReadinessTableData } from "@/components/site/check-run-readiness-model";
import { StatCard } from "@/components/site/primitives";
import { RefreshMeta } from "@/components/site/refresh-meta";
import { EmptyState, LoadingState, StateBoundary } from "@/components/site/state-views";
import { apiFetch } from "@/lib/api/request";
import { getApiOrigin } from "@/lib/api/origin";
import { useApiResource } from "@/lib/api/use-api-resource";
import { useSession } from "@/lib/api/session";
import {
  PREVIEW_SCENARIOS,
  buildSettingsPreviewRequest,
  extractPreviewRepoOptions,
  splitRepoFullName,
  type PreviewFormState,
  type PreviewScenarioId,
} from "@/lib/maintainer-settings-preview";
import { cn } from "@/lib/utils";

const BUCKET_TONE: Record<string, Status> = {
  "review-now": "ready",
  review_now: "ready",
  "needs-author": "warn",
  needs_author: "warn",
  watch: "info",
  redirect: "blocked",
};

// Deterministic slop band → pill tone. Advisory only (it never blocks); the colour just signals severity.
const SLOP_BAND_TONE: Record<string, Status> = {
  clean: "ok",
  low: "info",
  elevated: "warn",
  high: "blocked",
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
    // Brokered self-hosts (Orb token broker mode) can't introspect permissions/events today, so
    // missingPermissions/missingEvents are always [] there — that means "unchecked", not "all granted".
    authMode?: "local" | "broker";
  }>;
  reviewability: Array<{
    pr: string;
    title: string;
    author: string;
    bucket: string;
    reason: string;
    slop?: { risk: number; band: string } | null;
  }>;
  settingsPreview: { removed: string[]; added: string[] };
  qualityDashboard: { topContributors: MaintainerTopContributor[] };
};

type TrustChecklistStatus = "ready" | "needs_attention" | "blocked";

type InstallPreview = {
  status: TrustChecklistStatus;
  summary: string;
  readScope: string[];
  computedContext: string[];
  previewBehavior: string[];
  permissions: {
    status: TrustChecklistStatus;
    required: string[];
    missing: string[];
    missingEvents: string[];
    summary: string;
  };
  publicOutputs: string[];
  privateOnlyContext: string[];
  commandAuthorization: string[];
  auditBehavior: string[];
  sanitizerBoundaries: string[];
  manualControls: string[];
  checklist: Array<{
    id: string;
    category:
      | "permissions"
      | "public_outputs"
      | "private_context"
      | "command_authorization"
      | "audit"
      | "sanitizer"
      | "manual_control";
    status: TrustChecklistStatus;
    label: string;
    summary: string;
    action: string;
  }>;
};

export type SettingsPreviewResponse = {
  repoFullName: string;
  generatedAt: string;
  installation: {
    installationId: number;
    status: "healthy" | "needs_attention" | "broken";
    missingPermissions: string[];
    missingEvents: string[];
    permissionRemediation: Array<{
      permission: string;
      requiredAccess: string;
      currentAccess: string;
      ok: boolean;
      action: string;
    }>;
  } | null;
  sample: {
    authorLogin: string;
    authorType: string;
    authorAssociation: string;
    minerStatus: string;
    title: string;
    labels: string[];
    linkedIssues: number[];
  };
  decision: {
    willComment: boolean;
    willLabel: boolean;
    willCheckRun: boolean;
    skipped: boolean;
    skipReason: string | null;
    actions: Array<"skip" | "comment" | "label" | "check_run" | "none">;
    summary: string;
  };
  previewComment: string | null;
  appliedLabel: string | null;
  checkRun: { willCreate: boolean; title: string; detailLevel: string } | null;
  checkRunReadiness: CheckRunReadinessTableData | null;
  installPreview: InstallPreview;
  warnings: string[];
  summary: string;
};

const MAINTAINER_ROLES = ["maintainer", "owner", "operator"] as const;

/**
 * Role gate. The maintainer console — including the AI review / BYOK key panel — is shown ONLY to
 * verified maintainers/owners/operators. This mirrors the server gate (GET /v1/app/maintainer-dashboard
 * 403s `insufficient_role`, and every BYOK route re-checks per-repo maintainer access), but stops the
 * dashboard query and the BYOK form from ever mounting for a non-maintainer (defense-in-depth + a clean
 * message instead of a raw 403). The backend remains the source of truth.
 */
export function MaintainerPanel({
  initialRepoFullName,
}: { initialRepoFullName?: string | undefined } = {}) {
  const { session, hydrated } = useSession();
  const isMaintainer = (session?.roles ?? []).some((role) =>
    MAINTAINER_ROLES.includes(role as (typeof MAINTAINER_ROLES)[number]),
  );

  if (!hydrated) return <LoadingState title="Checking maintainer access…" />;
  if (!isMaintainer) {
    return (
      <EmptyState
        title="Maintainer access required"
        description="This console is available to verified repository maintainers, owners, and operators. Sign in with a GitHub account that maintains an installed repository to manage AI review and BYOK provider keys."
      />
    );
  }
  return <MaintainerDashboardView initialRepoFullName={initialRepoFullName} />;
}

function MaintainerDashboardView({
  initialRepoFullName,
}: {
  initialRepoFullName?: string | undefined;
}) {
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
          {/* Dashboard-level refresh metadata (#2219) — lives here rather than the route's PageHeader
              because the maintainer resource is gated behind the session/role check above. */}
          <div className="flex items-center justify-end">
            <RefreshMeta loadedAt={dashboard.loadedAt} onRefresh={dashboard.reload} />
          </div>

          <OnboardingPreviewCard reviewability={data.reviewability} />

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
                      {installation.authMode === "broker" ? (
                        <>
                          <StatusPill status="info">perms n/a (broker)</StatusPill>
                          <StatusPill status="info">webhook n/a (broker)</StatusPill>
                        </>
                      ) : (
                        <>
                          <StatusPill
                            status={
                              installation.missingPermissions.length === 0 ? "ready" : "blocked"
                            }
                          >
                            perms {installation.missingPermissions.length === 0 ? "ok" : "missing"}
                          </StatusPill>
                          <StatusPill
                            status={installation.missingEvents.length === 0 ? "ready" : "warn"}
                          >
                            webhook {installation.missingEvents.length === 0 ? "ok" : "lagging"}
                          </StatusPill>
                        </>
                      )}
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
                  <th className="py-2 pr-3 font-normal">Slop</th>
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
                    <td className="py-2 pr-3">
                      {row.slop ? (
                        <StatusPill status={SLOP_BAND_TONE[row.slop.band] ?? "info"}>
                          {row.slop.band} {row.slop.risk}
                        </StatusPill>
                      ) : (
                        <span
                          className="text-token-xs text-muted-foreground"
                          title="Slop detection is off for this repo, or this PR has not been assessed yet."
                        >
                          —
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-token-xs text-muted-foreground">{row.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <ContributorQualityTable topContributors={data.qualityDashboard.topContributors} />

          <ActivationPreview reviewability={data.reviewability} />

          <SurfacePreview
            reviewability={data.reviewability}
            initialRepoFullName={initialRepoFullName}
          />

          <MaintainerSettings reviewability={data.reviewability} />

          <AiReviewSettings reviewability={data.reviewability} />
        </div>
      ) : null}
    </StateBoundary>
  );
}

function SurfacePreview({
  reviewability,
  initialRepoFullName,
}: {
  reviewability: MaintainerDashboard["reviewability"];
  initialRepoFullName?: string | undefined;
}) {
  const repoOptions = useMemo(() => extractPreviewRepoOptions(reviewability), [reviewability]);
  const [form, setForm] = useState<PreviewFormState>({
    repoFullName: initialRepoFullName ?? repoOptions[0] ?? "",
    scenarioId: "confirmed-miner",
    title: "Sample pull request",
    labels: "bug",
    linkedIssues: "7",
    body: "",
  });
  const [preview, setPreview] = useState<SettingsPreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const repoParts = splitRepoFullName(form.repoFullName);

  useEffect(() => {
    if (!form.repoFullName && repoOptions[0]) {
      setForm((current) => ({ ...current, repoFullName: repoOptions[0] }));
    }
  }, [form.repoFullName, repoOptions]);

  useEffect(() => {
    if (!initialRepoFullName) return;
    setForm((current) =>
      current.repoFullName === initialRepoFullName
        ? current
        : { ...current, repoFullName: initialRepoFullName },
    );
  }, [initialRepoFullName]);

  async function runPreview(nextForm = form) {
    const target = splitRepoFullName(nextForm.repoFullName);
    if (!target) {
      setPreview(null);
      setError("Enter a repository as owner/repo.");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await apiFetch<SettingsPreviewResponse>(
      `${getApiOrigin().replace(/\/$/, "")}/v1/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/settings-preview`,
      {
        method: "POST",
        label: "Settings preview",
        credentials: "include",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(buildSettingsPreviewRequest(nextForm)),
      },
    );
    setBusy(false);
    if (result.ok) {
      setPreview(result.data);
      return;
    }
    setPreview(null);
    setError(result.message);
  }

  function updateScenario(scenarioId: PreviewScenarioId) {
    const next = {
      ...form,
      scenarioId,
      title:
        scenarioId === "bot-author"
          ? "Automated dependency update"
          : scenarioId === "maintainer-author"
            ? "Maintainer follow-up"
            : "Sample pull request",
    };
    setForm(next);
    setPreview(null);
    setError(null);
  }

  return (
    <section
      className="rounded-token border-hairline bg-card p-5"
      aria-labelledby="surface-preview-title"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="surface-preview-title" className="font-display text-token-lg font-semibold">
            Public-safe preview simulator
          </h2>
          <p className="mt-1 text-token-xs text-muted-foreground">
            Dry-run the GitHub App decision for a sample PR against the same policy engine used in
            production.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusPill status={preview?.decision.skipped ? "warn" : preview ? "ready" : "info"}>
            {preview ? (preview.decision.skipped ? "skip" : "ready") : "preview"}
          </StatusPill>
          <button
            type="button"
            disabled={busy || !repoParts}
            onClick={() => void runPreview()}
            className="inline-flex items-center gap-2 rounded-token border border-mint/40 bg-mint px-3 py-2 text-token-xs font-medium text-primary-foreground transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <RefreshCw className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
            {busy ? "Running" : "Run preview"}
          </button>
        </div>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
        <div className="space-y-4">
          <label className="block">
            <span className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
              Repository
            </span>
            <input
              value={form.repoFullName}
              onChange={(event) => {
                setForm((current) => ({ ...current, repoFullName: event.target.value }));
                setPreview(null);
                setError(null);
              }}
              list="settings-preview-repos"
              placeholder="owner/repo"
              className="mt-1 min-h-10 w-full rounded-token border border-border bg-background/70 px-3 py-2 font-mono text-token-sm text-foreground outline-none transition-colors focus:border-mint"
            />
            <datalist id="settings-preview-repos">
              {repoOptions.map((repo) => (
                <option key={repo} value={repo} />
              ))}
            </datalist>
          </label>

          <div>
            <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
              Scenario
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {PREVIEW_SCENARIOS.map((scenario) => (
                <button
                  key={scenario.id}
                  type="button"
                  onClick={() => updateScenario(scenario.id)}
                  className={cn(
                    "flex min-h-10 items-center gap-2 rounded-token border px-3 py-2 text-left text-token-xs transition-colors focus-ring",
                    form.scenarioId === scenario.id
                      ? "border-mint/50 bg-mint/10 text-mint"
                      : "border-border bg-background/40 text-muted-foreground hover:text-foreground",
                  )}
                  aria-pressed={form.scenarioId === scenario.id}
                >
                  <ScenarioIcon id={scenario.id} />
                  <span className="min-w-0 truncate">{scenario.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                Title
              </span>
              <input
                value={form.title}
                onChange={(event) => {
                  setForm((current) => ({ ...current, title: event.target.value }));
                  setPreview(null);
                }}
                className="mt-1 min-h-10 w-full rounded-token border border-border bg-background/70 px-3 py-2 text-token-sm text-foreground outline-none transition-colors focus:border-mint"
              />
            </label>
            <label className="block">
              <span className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                Labels
              </span>
              <input
                value={form.labels}
                onChange={(event) => {
                  setForm((current) => ({ ...current, labels: event.target.value }));
                  setPreview(null);
                }}
                placeholder="bug, docs"
                className="mt-1 min-h-10 w-full rounded-token border border-border bg-background/70 px-3 py-2 text-token-sm text-foreground outline-none transition-colors focus:border-mint"
              />
            </label>
          </div>

          <label className="block">
            <span className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
              Linked issues
            </span>
            <input
              value={form.linkedIssues}
              onChange={(event) => {
                setForm((current) => ({ ...current, linkedIssues: event.target.value }));
                setPreview(null);
              }}
              placeholder="#7, #12"
              className="mt-1 min-h-10 w-full rounded-token border border-border bg-background/70 px-3 py-2 font-mono text-token-sm text-foreground outline-none transition-colors focus:border-mint"
            />
          </label>

          <label className="block">
            <span className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
              Body excerpt
            </span>
            <textarea
              value={form.body}
              onChange={(event) => {
                setForm((current) => ({ ...current, body: event.target.value }));
                setPreview(null);
              }}
              rows={3}
              className="mt-1 w-full resize-y rounded-token border border-border bg-background/70 px-3 py-2 text-token-sm text-foreground outline-none transition-colors focus:border-mint"
            />
          </label>
        </div>

        <PreviewResult preview={preview} error={error} busy={busy} />
      </div>
    </section>
  );
}

export function PreviewResult({
  preview,
  error,
  busy,
}: {
  preview: SettingsPreviewResponse | null;
  error: string | null;
  busy: boolean;
}) {
  if (error) {
    return (
      <div className="rounded-token border border-danger/30 bg-danger/[0.04] p-4 text-token-sm text-danger">
        {error}
      </div>
    );
  }

  if (!preview) {
    return (
      <div className="flex min-h-[360px] items-center justify-center rounded-token border-hairline bg-background/40 p-6 text-center">
        <div>
          <ShieldCheck className="mx-auto size-7 text-mint" />
          <div className="mt-3 text-token-sm font-medium text-foreground">
            {busy ? "Building preview" : "No preview run yet"}
          </div>
          <p className="mt-1 max-w-sm text-token-xs text-muted-foreground">
            Choose a repo and scenario, then run the dry-run preview.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-token border-hairline bg-background/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
            Decision
          </div>
          <div className="mt-1 text-token-base font-medium text-foreground">{preview.summary}</div>
          <div className="mt-1 font-mono text-token-2xs text-muted-foreground">
            {preview.repoFullName} · {preview.sample.authorLogin} · {preview.sample.minerStatus}
          </div>
        </div>
        <StatusPill status={preview.decision.skipped ? "warn" : "ready"}>
          {preview.decision.skipped ? (preview.decision.skipReason ?? "skip") : "will act"}
        </StatusPill>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        <ActionState active={preview.decision.willComment} label="comment" />
        <ActionState active={preview.decision.willLabel} label={preview.appliedLabel ?? "label"} />
        <ActionState active={preview.decision.willCheckRun} label="check run" />
      </div>

      <TrustChecklist installPreview={preview.installPreview} />

      {preview.warnings.length > 0 && (
        <div className="rounded-token border border-warning/30 bg-warning/[0.04] p-3">
          <div className="mb-2 flex items-center gap-2 text-token-xs font-medium text-warning">
            <AlertTriangle className="size-3.5" />
            Permissions and remediation
          </div>
          <ul className="space-y-1 text-token-xs text-warning/90">
            {preview.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}

      {preview.installation?.permissionRemediation.length ? (
        <div className="overflow-hidden rounded-token border-hairline">
          <table className="w-full text-left text-token-xs">
            <thead className="border-b-hairline font-mono uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-normal">Permission</th>
                <th className="px-3 py-2 font-normal">Current</th>
                <th className="px-3 py-2 font-normal">Required</th>
              </tr>
            </thead>
            <tbody>
              {preview.installation.permissionRemediation.map((row) => (
                <tr key={row.permission} className="border-b-hairline last:border-b-0">
                  <td className="px-3 py-2 text-foreground">{row.permission}</td>
                  <td className="px-3 py-2 text-muted-foreground">{row.currentAccess}</td>
                  <td className="px-3 py-2 text-muted-foreground">{row.requiredAccess}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {preview.checkRun?.willCreate ? (
        <CheckRunReadinessTable
          detailLevel={preview.checkRun.detailLevel as "minimal" | "standard"}
          readiness={preview.checkRunReadiness}
        />
      ) : null}

      <div>
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
            Public comment preview
          </div>
          <StatusPill status="info">sanitized</StatusPill>
        </div>
        <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap rounded-token border border-border bg-[oklch(0.13_0.005_260)] p-3 font-mono text-token-xs leading-token-relaxed text-foreground/90">
          {preview.previewComment ?? "No public comment would be posted for this scenario."}
        </pre>
      </div>
    </div>
  );
}

const TRUST_STATUS_PILL: Record<TrustChecklistStatus, Status> = {
  ready: "ready",
  needs_attention: "warn",
  blocked: "blocked",
};

const TRUST_STATUS_LABEL: Record<TrustChecklistStatus, string> = {
  ready: "ready",
  needs_attention: "attention",
  blocked: "blocked",
};

function TrustChecklist({ installPreview }: { installPreview: InstallPreview }) {
  const attentionItems = installPreview.checklist.filter((item) => item.status !== "ready");
  const detailGroups = [
    {
      title: "Scope",
      items: [
        ...installPreview.readScope,
        ...installPreview.computedContext,
        ...installPreview.previewBehavior,
      ],
    },
    {
      title: "Public boundary",
      items: [
        ...installPreview.publicOutputs,
        ...installPreview.privateOnlyContext,
        ...installPreview.sanitizerBoundaries,
      ],
    },
    {
      title: "Controls",
      items: [
        ...installPreview.commandAuthorization,
        ...installPreview.auditBehavior,
        ...installPreview.manualControls,
      ],
    },
  ];

  return (
    <div className="rounded-token border-hairline bg-card/60 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
            <ListChecks className="size-3.5 text-mint" />
            Maintainer trust checklist
          </div>
          <p className="mt-1 text-token-xs text-foreground/85">{installPreview.summary}</p>
        </div>
        <StatusPill status={TRUST_STATUS_PILL[installPreview.status]}>
          {TRUST_STATUS_LABEL[installPreview.status]}
        </StatusPill>
      </div>

      <div className="mt-3 overflow-hidden rounded-token border-hairline bg-background/35">
        {installPreview.checklist.map((item) => (
          <div
            key={item.id}
            className={cn(
              "grid gap-2 border-b-hairline p-3 last:border-b-0 sm:grid-cols-[minmax(12rem,0.38fr)_1fr_auto] sm:items-start",
              item.status === "blocked"
                ? "bg-danger/[0.03]"
                : item.status === "needs_attention"
                  ? "bg-warning/[0.03]"
                  : "bg-transparent",
            )}
          >
            <div className="flex min-w-0 items-center gap-2 text-token-xs font-medium text-foreground">
              <TrustStatusIcon status={item.status} />
              <span className="min-w-0">{item.label}</span>
            </div>
            <div className="min-w-0">
              <p className="text-token-xs text-muted-foreground">{item.summary}</p>
            </div>
            <StatusPill status={TRUST_STATUS_PILL[item.status]} className="w-fit shrink-0">
              {TRUST_STATUS_LABEL[item.status]}
            </StatusPill>
          </div>
        ))}
      </div>

      {attentionItems.length > 0 ? (
        <div className="mt-3 rounded-token border border-warning/30 bg-warning/[0.04] p-3 text-token-xs text-warning/90">
          <div className="font-medium text-warning">Review before enabling</div>
          <ul className="mt-1 space-y-1">
            {attentionItems.map((item) => (
              <li key={item.id}>
                <span className="text-warning">{item.label}:</span>{" "}
                <span className="text-foreground/85">{item.action}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <details className="mt-3 rounded-token border-hairline bg-background/30">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-3 font-mono text-token-2xs uppercase tracking-wider text-muted-foreground marker:hidden">
          <span>Preview scope and controls</span>
          <StatusPill status="info">details</StatusPill>
        </summary>
        <div className="grid gap-3 border-t-hairline p-3 md:grid-cols-3">
          {detailGroups.map((group) => (
            <TrustDetailList key={group.title} title={group.title} items={group.items} />
          ))}
        </div>
      </details>
    </div>
  );
}

function TrustDetailList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="min-w-0">
      <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      <ul className="mt-2 space-y-1.5 text-token-xs text-foreground/85">
        {items.map((item) => (
          <li key={item} className="flex gap-2">
            <span className="mt-[0.45em] size-1 shrink-0 rounded-full bg-mint" />
            <span className="min-w-0">{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TrustStatusIcon({ status }: { status: TrustChecklistStatus }) {
  if (status === "blocked") return <CircleSlash className="size-3.5 shrink-0 text-danger" />;
  if (status === "needs_attention")
    return <AlertTriangle className="size-3.5 shrink-0 text-warning" />;
  return <CheckCircle2 className="size-3.5 shrink-0 text-success" />;
}

function ActionState({ active, label }: { active: boolean; label: string }) {
  return (
    <div
      className={cn(
        "flex min-h-10 items-center gap-2 rounded-token border px-3 py-2 text-token-xs",
        active
          ? "border-success/35 bg-success/10 text-success"
          : "border-border bg-background/50 text-muted-foreground",
      )}
    >
      {active ? <CheckCircle2 className="size-3.5" /> : <CircleSlash className="size-3.5" />}
      <span className="min-w-0 truncate">{label}</span>
    </div>
  );
}

function ScenarioIcon({ id }: { id: PreviewScenarioId }) {
  if (id === "bot-author") return <Bot className="size-3.5 shrink-0" />;
  if (id === "maintainer-author") return <UserCheck className="size-3.5 shrink-0" />;
  if (id === "miner-api-unavailable") return <AlertTriangle className="size-3.5 shrink-0" />;
  if (id === "non-miner") return <CircleSlash className="size-3.5 shrink-0" />;
  return <ShieldCheck className="size-3.5 shrink-0" />;
}
