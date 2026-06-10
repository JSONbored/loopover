import { useState, type ReactNode } from "react";

import { StatusPill, type Status } from "@/components/site/control-primitives";
import { cn } from "@/lib/utils";
import type { SnapshotReplayView, SnapshotReplayViewer } from "@/lib/snapshot-replay";

const STATUS_PILL: Record<SnapshotReplayView["status"], Status> = {
  populated: "ready",
  stale: "stale",
  missing: "info",
};

const STATUS_LABEL: Record<SnapshotReplayView["status"], string> = {
  populated: "Replayable",
  stale: "Stale evidence",
  missing: "No evidence",
};

const VIEWER_LABEL: Record<SnapshotReplayViewer, string> = {
  authenticated: "Authenticated",
  public: "Public-safe",
};

/**
 * Snapshot replay card with an audience toggle so reviewers can confirm the
 * public-safe view withholds the private detail the authenticated view shows.
 * The two views are precomputed by the caller; switching never re-derives or
 * exposes withheld fields.
 */
export function SnapshotReplayCard({
  authenticated,
  publicSafe,
}: {
  authenticated: SnapshotReplayView;
  publicSafe: SnapshotReplayView;
}) {
  const [viewer, setViewer] = useState<SnapshotReplayViewer>("authenticated");
  const view = viewer === "public" ? publicSafe : authenticated;
  return (
    <div className="space-y-2">
      <div
        role="group"
        aria-label="Snapshot replay audience"
        className="inline-flex rounded-token border border-border p-0.5 text-token-2xs"
      >
        {(["authenticated", "public"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setViewer(option)}
            aria-pressed={viewer === option}
            className={cn(
              "rounded-[6px] px-2.5 py-1 font-mono uppercase tracking-wider transition-colors focus-ring",
              viewer === option
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {VIEWER_LABEL[option]}
          </button>
        ))}
      </div>
      <SnapshotReplay view={view} />
    </div>
  );
}

/**
 * Inspection-only replay view for a single decision snapshot (issue #285).
 * Renders public-safe provenance, freshness/confidence context, evidence gaps,
 * and counterfactuals, with private detail clearly separated and withheld for
 * public viewers. It intentionally exposes no mutating actions.
 */
export function SnapshotReplay({ view }: { view: SnapshotReplayView }) {
  return (
    <section
      data-testid="snapshot-replay"
      data-status={view.status}
      className="rounded-token border border-border bg-background/60 p-4"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
            Decision snapshot replay
          </div>
          <div className="mt-0.5 truncate font-mono text-[12px] text-foreground/90">
            {view.snapshotId ?? "unknown snapshot"}
          </div>
        </div>
        <StatusPill status={STATUS_PILL[view.status]}>{STATUS_LABEL[view.status]}</StatusPill>
      </header>

      <p className="mt-2 text-token-xs text-muted-foreground">{view.notice}</p>

      {view.status === "missing" ? null : (
        <>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-token-sm">
            <Field label="Action" value={view.actionType ?? "—"} />
            <Field label="Repo" value={view.target.repoFullName ?? "—"} />
            <Field label="Confidence" value={view.confidence} />
            <Field label="Freshness" value={view.freshness} />
            <Field label="Generated" value={view.generatedAt ?? "—"} />
            <Field label="Scoring model" value={view.scoringModelId ?? "—"} />
          </dl>

          {view.sources.length > 0 && (
            <div className="mt-3">
              <SubHeading>Evidence sources</SubHeading>
              <ul className="mt-1.5 space-y-1 text-token-xs text-foreground/90">
                {view.sources.map((source) => (
                  <li key={source.name} className="flex items-center justify-between gap-2">
                    <span className="font-mono">{source.name}</span>
                    <span className="text-muted-foreground">
                      {source.freshness}
                      {source.generatedAt ? ` · ${source.generatedAt}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {view.staleReasons.length > 0 && (
            <div className="mt-3 rounded-token border border-warning/30 bg-warning/[0.04] p-3 text-token-xs text-warning">
              <SubHeading>Evidence caveats</SubHeading>
              <ul className="mt-1.5 list-disc space-y-1 pl-4">
                {view.staleReasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </div>
          )}

          {view.counterfactuals.length > 0 && (
            <div className="mt-3">
              <SubHeading>Why not the alternatives</SubHeading>
              <div className="mt-1.5 space-y-2">
                {view.counterfactuals.map((cf) => (
                  <div
                    key={`${cf.repoFullName}-${cf.recommendation}`}
                    className="rounded-token border border-border/70 p-2.5"
                  >
                    <div className="font-mono text-token-2xs text-muted-foreground">
                      {cf.repoFullName} · chose {cf.recommendation}
                    </div>
                    <ul className="mt-1 space-y-1.5 text-token-xs text-foreground/90">
                      {cf.alternatives.map((alt, index) => (
                        <li key={`${alt.alternative}-${index}`}>
                          <span className="text-foreground">{alt.publicSummary}</span>
                          {alt.reason ? (
                            <span className="mt-0.5 block text-muted-foreground">{alt.reason}</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          )}

          {view.withheldPrivateFields.length > 0 && (
            <p className="mt-3 text-token-2xs text-muted-foreground">
              Private detail withheld for this context: {view.withheldPrivateFields.join(", ")}.
            </p>
          )}
        </>
      )}
    </section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-0.5 truncate font-mono text-[12px] text-foreground/90">{value}</dd>
    </div>
  );
}

function SubHeading({ children }: { children: ReactNode }) {
  return (
    <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}
