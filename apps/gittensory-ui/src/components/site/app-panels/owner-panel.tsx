import { useMemo, useState } from "react";

import { DiffBlock, StatusPill, type Status } from "@/components/site/control-primitives";
import { StateBoundary } from "@/components/site/state-views";
import { Input } from "@/components/ui/input";
import { useApiResource } from "@/lib/api/use-api-resource";

const STATUS_MAP: Record<string, Status> = { ok: "ready", warn: "warn", blocked: "blocked" };

type RegistrationReadiness = {
  repoFullName: string;
  ready: boolean;
  recommendedRegistrationMode: string;
  issuePolicy: string;
  blockers: string[];
  warnings: string[];
};

type ConfigRecommendation = {
  current: Record<string, unknown> | null;
  recommended: Record<string, unknown>;
  reasons: string[];
  warnings: string[];
};

export function OwnerPanel() {
  const [repo, setRepo] = useState("entrius/gittensor");
  const [owner, name] = repo.split("/");
  const repoPath =
    owner && name
      ? `/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
      : "/v1/repos/entrius/gittensor";
  const readiness = useApiResource<RegistrationReadiness>(
    `${repoPath}/registration-readiness`,
    "Registration readiness",
  );
  const config = useApiResource<ConfigRecommendation>(
    `${repoPath}/gittensor-config-recommendation`,
    "Config recommendation",
  );
  const liveSteps = useMemo(() => {
    if (readiness.status !== "ready") return null;
    const steps = [
      {
        id: "mode",
        title: "Registration mode",
        detail: readiness.data.recommendedRegistrationMode,
        status: readiness.data.ready ? "ok" : "warn",
      },
      {
        id: "issue-policy",
        title: "Issue policy",
        detail: readiness.data.issuePolicy,
        status: readiness.data.ready ? "ok" : "warn",
      },
      ...readiness.data.blockers.map((detail, i) => ({
        id: `blocker-${i}`,
        title: "Readiness blocker",
        detail,
        status: "blocked",
      })),
      ...readiness.data.warnings.map((detail, i) => ({
        id: `warning-${i}`,
        title: "Readiness warning",
        detail,
        status: "warn",
      })),
    ];
    return steps.length > 0 ? steps : null;
  }, [readiness]);
  const steps = liveSteps ?? [];
  const removed = config.status === "ready" ? recordLines(config.data.current ?? {}) : [];
  const added = config.status === "ready" ? recordLines(config.data.recommended) : [];
  const refresh = () => {
    void readiness.reload();
    void config.reload();
  };

  return (
    <StateBoundary
      isLoading={readiness.status === "loading" || config.status === "loading"}
      isError={readiness.status === "error" && config.status === "error"}
      isEmpty={steps.length === 0 && config.status !== "ready"}
      onRetry={refresh}
      onRefresh={refresh}
      loadingTitle="Loading owner readiness…"
      emptyTitle="No readiness checks yet"
      emptyDescription="Registration readiness and config recommendations appear after repository analysis runs."
    >
      <div className="space-y-6">
        <section className="rounded-token border-hairline bg-card p-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="font-display text-token-lg font-semibold">Registration readiness</h2>
              <p className="mt-1 text-token-xs text-muted-foreground">
                Live read-only API check from cached repository intelligence.
              </p>
            </div>
            <div className="w-full sm:w-56">
              <label className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                Repo
              </label>
              <Input
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                className="mt-1 font-mono text-token-xs"
              />
            </div>
          </div>
          {readiness.status === "error" && (
            <p className="mt-3 text-token-2xs text-muted-foreground">
              Live readiness failed ({readiness.error}).
            </p>
          )}
          <ul className="mt-4 divide-hairline">
            {steps.map((s) => (
              <li
                key={s.id}
                className="flex items-start justify-between gap-3 py-3 transition-colors hover:bg-muted/30"
              >
                <div>
                  <div className="font-medium">{s.title}</div>
                  <div className="mt-0.5 text-token-xs text-muted-foreground">{s.detail}</div>
                </div>
                <StatusPill status={STATUS_MAP[s.status]}>{s.status}</StatusPill>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-token border-hairline bg-card p-5">
          <h2 className="font-display text-token-lg font-semibold">Suggested .gittensor.yml</h2>
          <p className="mt-1 text-token-xs text-muted-foreground">
            Diff against the current configuration. Apply via PR when ready.
          </p>
          {config.status === "error" && (
            <p className="mt-2 text-token-2xs text-muted-foreground">
              Live recommendation failed ({config.error}).
            </p>
          )}
          <div className="mt-3">
            <DiffBlock removed={removed} added={added} />
          </div>
        </section>
      </div>
    </StateBoundary>
  );
}

function recordLines(record: Record<string, unknown>) {
  const entries = Object.entries(record);
  if (entries.length === 0) return ["{}"];
  return entries.slice(0, 8).map(([key, value]) => `${key}: ${formatValue(value)}`);
}

function formatValue(value: unknown) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}
