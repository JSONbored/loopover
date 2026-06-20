import { useMemo, useState } from "react";

import {
  BoundaryBadge,
  DiffBlock,
  StatusPill,
  type Status,
} from "@/components/site/control-primitives";
import { StateBoundary } from "@/components/site/state-views";
import { Input } from "@/components/ui/input";
import { useApiResource } from "@/lib/api/use-api-resource";
import {
  buildRegistrationWorkspaceView,
  splitRepoFullName,
  type OwnerWorkflowState,
  type GittensorConfigRecommendationPayload,
  type RegistrationReadinessPayload,
  type RegistrationWorkspaceView,
  type WorkspaceLaneStatus,
} from "@/lib/registration-workspace";

const LANE_STATUS_MAP: Record<WorkspaceLaneStatus, Status> = {
  ready: "ready",
  warn: "warn",
  blocked: "blocked",
  info: "info",
};

const FRESHNESS_STATUS_MAP: Record<RegistrationWorkspaceView["freshness"]["status"], Status> = {
  complete: "ready",
  degraded: "degraded",
  stale: "stale",
  unknown: "info",
};

const WORKFLOW_STATUS_MAP: Record<OwnerWorkflowState, Status> = {
  accepted: "ready",
  needs_cleanup: "warn",
  not_ready: "blocked",
};

export function OwnerPanel() {
  const [repo, setRepo] = useState("entrius/gittensor");
  const parts = splitRepoFullName(repo.trim());
  const repoPath = parts
    ? `/v1/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.repo)}`
    : null;
  const readiness = useApiResource<RegistrationReadinessPayload>(
    `${repoPath ?? "/v1/repos/__invalid__/__invalid__"}/registration-readiness`,
    "Registration readiness",
    undefined,
    { enabled: Boolean(repoPath) },
  );
  const config = useApiResource<GittensorConfigRecommendationPayload>(
    `${repoPath ?? "/v1/repos/__invalid__/__invalid__"}/gittensor-config-recommendation`,
    "Config recommendation",
    undefined,
    { enabled: Boolean(repoPath) },
  );

  const workspace = useMemo(() => {
    if (readiness.status !== "ready") return null;
    const configPayload = config.status === "ready" ? config.data : null;
    return buildRegistrationWorkspaceView(readiness.data, configPayload);
  }, [readiness, config]);

  const refresh = () => {
    void readiness.reload();
    void config.reload();
  };

  const invalidRepo = repo.trim().length > 0 && !parts;

  return (
    <div className="space-y-6">
      <section
        className="rounded-token border-hairline bg-card p-5"
        aria-labelledby="owner-registration-workspace-title"
      >
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2
              id="owner-registration-workspace-title"
              className="font-display text-token-lg font-semibold"
            >
              Registration workspace
            </h2>
            <p className="mt-1 text-token-xs text-muted-foreground">
              Readiness report with lane tradeoffs — not raw Gittensor telemetry.
            </p>
          </div>
          <div className="w-full sm:w-64">
            <label
              htmlFor="owner-repo-input"
              className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground"
            >
              Repository
            </label>
            <Input
              id="owner-repo-input"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              className="mt-1 font-mono text-token-xs focus-ring"
              placeholder="owner/repo"
              autoComplete="off"
              spellCheck={false}
            />
            {invalidRepo ? (
              <p className="mt-1 text-token-2xs text-danger">Use a valid owner/repo slug.</p>
            ) : null}
          </div>
        </div>
      </section>

      <StateBoundary
        isLoading={
          Boolean(repoPath) && (readiness.status === "loading" || config.status === "loading")
        }
        isError={Boolean(repoPath) && readiness.status === "error" && config.status === "error"}
        isEmpty={Boolean(repoPath) && readiness.status === "ready" && !workspace}
        onRetry={refresh}
        onRefresh={refresh}
        loadingTitle="Loading registration workspace…"
        emptyTitle="No readiness report yet"
        emptyDescription="Registration readiness appears after repository intelligence has been generated for this repo."
      >
        {workspace ? (
          <RegistrationWorkspace
            workspace={workspace}
            generatedLabel={formatGeneratedAt(workspace.generatedAt)}
          />
        ) : null}
        {repoPath && readiness.status === "error" ? (
          <p className="text-token-2xs text-muted-foreground">
            Readiness failed ({readiness.error}).
          </p>
        ) : null}
      </StateBoundary>
    </div>
  );
}

export function RegistrationWorkspace({
  workspace,
  generatedLabel,
}: {
  workspace: RegistrationWorkspaceView;
  generatedLabel: string;
}) {
  return (
    <div className="space-y-6">
      <section className="rounded-token border-hairline bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-display text-token-md font-semibold">{workspace.repoFullName}</h3>
              <StatusPill status={LANE_STATUS_MAP[workspace.summary.status]}>
                {workspace.summary.ready ? "Ready" : "Not ready"}
              </StatusPill>
              <StatusPill status={WORKFLOW_STATUS_MAP[workspace.workflow.overallState]}>
                {formatWorkflowState(workspace.workflow.overallState)}
              </StatusPill>
              <StatusPill status={FRESHNESS_STATUS_MAP[workspace.freshness.status]}>
                {workspace.freshness.status}
              </StatusPill>
              <BoundaryBadge boundary="private-api" />
            </div>
            <p className="text-token-xs text-muted-foreground">{workspace.summary.headline}</p>
            <p className="font-mono text-token-2xs text-muted-foreground">
              Generated {generatedLabel}
            </p>
          </div>
        </div>
        <p className="mt-3 rounded-token border border-mint/20 bg-mint/5 px-3 py-2 text-token-xs text-muted-foreground">
          {workspace.advisoryBanner}
        </p>
        {workspace.freshness.warnings.length > 0 ? (
          <ul className="mt-3 space-y-1 text-token-2xs text-warning">
            {workspace.freshness.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        ) : null}
        <dl className="mt-4 grid gap-3 sm:grid-cols-2">
          <Metric label="Recommended mode" value={workspace.summary.recommendedMode} />
          <Metric label="Issue policy" value={workspace.summary.issuePolicy} />
        </dl>
      </section>

      <section className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="font-display text-token-md font-semibold">Guided owner workflow</h3>
            <p className="mt-1 text-token-xs text-muted-foreground">
              {workspace.workflow.overallHeadline}
            </p>
          </div>
          <StatusPill status={WORKFLOW_STATUS_MAP[workspace.workflow.overallState]}>
            {formatWorkflowState(workspace.workflow.overallState)}
          </StatusPill>
        </div>

        {workspace.workflow.nextSteps.length > 0 ? (
          <div className="rounded-token border-hairline bg-card p-5">
            <h4 className="font-medium">Next owner actions</h4>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-token-xs text-muted-foreground">
              {workspace.workflow.nextSteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-2">
          {workspace.workflow.buckets.map((bucket) => (
            <OwnerWorkflowBucketCard key={bucket.id} bucket={bucket} />
          ))}
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <h3 className="font-display text-token-md font-semibold">Supporting readiness signals</h3>
          <p className="mt-1 text-token-xs text-muted-foreground">
            Detailed lane tradeoffs and operational signals behind the guided workflow.
          </p>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <WorkspaceSectionCard section={workspace.lanes.directPr} />
          <WorkspaceSectionCard section={workspace.lanes.issueDiscovery} />
          <WorkspaceSectionCard section={workspace.lanes.maintainerEconomics} />
          <WorkspaceSectionCard section={workspace.lanes.minerGuidance} />
        </div>
      </section>

      <section className="space-y-4">
        <h3 className="font-display text-token-md font-semibold">Operations & policy</h3>
        <div className="grid gap-4 lg:grid-cols-2">
          {workspace.operations.map((section) => (
            <WorkspaceSectionCard key={section.id} section={section} />
          ))}
        </div>
        {workspace.policyWarnings.length > 0 ? (
          <div className="rounded-token border-hairline bg-card p-5">
            <h4 className="font-medium">Focus policy warnings</h4>
            <ul className="mt-3 space-y-3">
              {workspace.policyWarnings.map((warning) => (
                <li key={`${warning.title}-${warning.detail}`} className="text-token-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{warning.title}</span>
                    <StatusPill status={warning.severity === "critical" ? "blocked" : "warn"}>
                      {warning.severity}
                    </StatusPill>
                  </div>
                  <p className="mt-1 text-muted-foreground">{warning.detail}</p>
                  <p className="mt-1 text-muted-foreground">{warning.action}</p>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      {workspace.config ? (
        <section className="rounded-token border-hairline bg-card p-5 space-y-4">
          <div>
            <h3 className="font-display text-token-md font-semibold">Suggested Gittensor config</h3>
            <p className="mt-1 text-token-xs text-muted-foreground">
              Tradeoffs below separate maintainer economics from contributor lanes. Apply via PR
              when ready.
            </p>
          </div>
          {workspace.config.tradeoffs.length > 0 ? (
            <div>
              <h4 className="text-token-xs font-medium uppercase tracking-wider text-muted-foreground">
                Tradeoffs
              </h4>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-token-xs text-muted-foreground">
                {workspace.config.tradeoffs.map((entry) => (
                  <li key={entry}>{entry}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <DiffBlock
            removed={workspace.config.currentLines}
            added={workspace.config.recommendedLines}
          />
        </section>
      ) : null}
    </div>
  );
}

function WorkspaceSectionCard({
  section,
}: {
  section: RegistrationWorkspaceView["lanes"]["directPr"];
}) {
  return (
    <article className="rounded-token border-hairline bg-card p-5">
      <div className="flex items-start justify-between gap-2">
        <h4 className="font-medium">{section.title}</h4>
        <StatusPill status={LANE_STATUS_MAP[section.status]}>{section.status}</StatusPill>
      </div>
      <p className="mt-2 text-token-xs text-muted-foreground">{section.summary}</p>
      {section.bullets.length > 0 ? (
        <ul className="mt-3 list-disc space-y-1 pl-5 text-token-2xs text-muted-foreground">
          {section.bullets.map((bullet) => (
            <li key={bullet}>{bullet}</li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

function OwnerWorkflowBucketCard({
  bucket,
}: {
  bucket: RegistrationWorkspaceView["workflow"]["buckets"][number];
}) {
  return (
    <article className="rounded-token border-hairline bg-card p-5">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h4 className="font-medium">{bucket.title}</h4>
          <p className="mt-1 text-token-xs text-muted-foreground">{bucket.summary}</p>
        </div>
        <StatusPill status={WORKFLOW_STATUS_MAP[bucket.state]}>
          {formatWorkflowState(bucket.state)}
        </StatusPill>
      </div>

      {bucket.items.length > 0 ? (
        <ul className="mt-4 space-y-3">
          {bucket.items.map((item) => (
            <li key={item.id} className="rounded-token border border-border/80 bg-muted/10 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-token-xs font-medium text-foreground">{item.title}</span>
                <StatusPill status={WORKFLOW_STATUS_MAP[item.state]} className="shrink-0">
                  {formatWorkflowState(item.state)}
                </StatusPill>
              </div>
              <p className="mt-2 text-token-xs text-muted-foreground">{item.summary}</p>
              <p className="mt-2 text-token-2xs text-muted-foreground">
                <span className="font-mono uppercase tracking-wider text-foreground/70">
                  {item.remediationKind === "manual" ? "Manual follow-up" : "Action"}
                </span>{" "}
                {item.remediation}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-token-xs text-muted-foreground">No follow-up needed.</p>
      )}
    </article>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-token border-hairline bg-muted/20 px-3 py-2">
      <dt className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 font-mono text-token-xs">{value}</dd>
    </div>
  );
}

function formatGeneratedAt(value: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toLocaleString();
}

function formatWorkflowState(state: OwnerWorkflowState) {
  return state.replace(/_/g, " ");
}
