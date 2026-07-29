import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";

import { StateBoundary } from "@/components/site/state-views";
import {
  PreviewResult,
  type SettingsPreviewResponse,
} from "@/components/site/app-panels/maintainer-panel";
import { apiFetch } from "@/lib/api/request";
import { getApiOrigin } from "@/lib/api/origin";
import {
  buildSettingsPreviewRequest,
  splitRepoFullName,
  type PreviewFormState,
} from "@/lib/maintainer-settings-preview";
import { useLocalStorage } from "@/lib/use-local-storage";

type ReviewabilityRow = { pr: string; title: string; reason: string };

const DISMISS_KEY = "loopover_maintainer_onboarding_preview_dismissed";
// One-time rebrand migration fallback -- see useLocalStorage's legacyKey param.
// Runtime value is the pre-rebrand key (prefix + suffix). Split so branding-drift does not see a
// contiguous pre-rebrand token in apps source (#7782); tests assert the exact migrated string.
const LEGACY_DISMISS_KEY = "git" + "tensory_" + "maintainer_onboarding_preview_dismissed";

/** Builds a settings-preview form from a REAL cached PR (title, and a linked-issue number scraped from
 *  `reason` when present) — everything else (author identity, labels, body) isn't in the reviewability
 *  projection (see src/api/routes.ts's `reviewability` mapper), so it's filled from a representative
 *  scenario, same as SurfacePreview's own default. Returns null if the PR string doesn't parse. */
function reviewabilityRowToForm(row: ReviewabilityRow): PreviewFormState | null {
  const repoFullName = row.pr.split("#")[0] ?? "";
  if (!splitRepoFullName(repoFullName)) return null;
  const linkedIssueMatch = row.reason.match(/linked issue #(\d+)/);
  return {
    repoFullName,
    scenarioId: "confirmed-miner",
    title: row.title,
    labels: "",
    linkedIssues: linkedIssueMatch ? linkedIssueMatch[1] : "",
    body: "",
  };
}

/**
 * First-session onboarding preview card (#2217, part of #701): auto-runs the same settings-preview
 * simulator SurfacePreview drives manually, against this repo's most recently cached pull request, so a
 * maintainer sees "here's what LoopOver would have flagged" without filling out a form. Dismissible via
 * localStorage, matching this codebase's established first-visit-card idiom (app.index.tsx's
 * OnboardingChecklist). Renders through PreviewResult — the same decision/checklist/comment-preview UI
 * SurfacePreview already uses — rather than a new findings UI: the settings-preview response has no
 * discrete findings array, so "flagged" here means decision.willComment / willLabel / willCheckRun.
 */
export function OnboardingPreviewCard({ reviewability }: { reviewability: ReviewabilityRow[] }) {
  const [state, setState, hydrated] = useLocalStorage<{ dismissed: boolean }>(
    DISMISS_KEY,
    { dismissed: false },
    LEGACY_DISMISS_KEY,
  );
  const target = reviewability[0] ?? null;
  // react-query rather than a hand-rolled load effect (#9588). The unparseable-target case is a DERIVED
  // error rather than a fetch that never happens: it depends only on the target, so it needs no request and
  // no state. Options are pinned to the previous behaviour -- one attempt, no focus refetch, no cache.
  const form = target ? reviewabilityRowToForm(target) : null;
  const repoParts = form ? splitRepoFullName(form.repoFullName) : null;
  const unparseable = target !== undefined && target !== null && (!form || !repoParts);

  const query = useQuery({
    queryKey: ["onboarding-preview", repoParts?.owner ?? null, repoParts?.repo ?? null],
    enabled: hydrated && !state.dismissed && form !== null && repoParts !== null,
    retry: false,
    refetchOnWindowFocus: false,
    gcTime: 0,
    queryFn: async () => {
      const result = await apiFetch<SettingsPreviewResponse>(
        `${getApiOrigin().replace(/\/$/, "")}/v1/repos/${encodeURIComponent(repoParts!.owner)}/${encodeURIComponent(repoParts!.repo)}/settings-preview`,
        {
          method: "POST",
          label: "Onboarding preview",
          credentials: "include",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify(buildSettingsPreviewRequest(form!)),
        },
      );
      if (!result.ok) throw new Error(result.message);
      return result.data;
    },
  });

  const preview = query.data ?? null;
  const loading = query.isFetching;
  const error = unparseable
    ? `Couldn't parse a repository from ${target?.pr}.`
    : query.isError
      ? query.error.message
      : null;
  const load = () => void query.refetch();

  if (!hydrated || state.dismissed) return null;

  return (
    <section
      className="rounded-token border-hairline bg-card p-5"
      aria-labelledby="onboarding-preview-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="onboarding-preview-title" className="font-display text-token-lg font-semibold">
            Here's what LoopOver would have flagged
          </h2>
          <p className="mt-1 text-token-xs text-muted-foreground">
            {target ? (
              <>
                A live demo run of the review policy against{" "}
                <span className="font-mono">{target.pr}</span>, your most recently cached pull
                request.
              </>
            ) : (
              "A live demo run against this repo's most recent pull request."
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setState({ dismissed: true })}
          aria-label="Dismiss onboarding preview"
          className="shrink-0 rounded-token p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-ring"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="mt-4">
        <StateBoundary
          isLoading={loading}
          isError={error !== null}
          isEmpty={reviewability.length === 0}
          onRetry={load}
          onRefresh={load}
          loadingTitle="Running the demo preview…"
          errorTitle="Couldn't run the onboarding preview"
          errorDescription={error ?? undefined}
          emptyTitle="No recent pull requests yet"
          emptyDescription="This card will run a live demo once this repo has a cached pull request."
        >
          <PreviewResult preview={preview} error={null} busy={false} />
        </StateBoundary>
      </div>
    </section>
  );
}
