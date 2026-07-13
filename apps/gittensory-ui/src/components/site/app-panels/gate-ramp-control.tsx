import { Loader2, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { toast } from "sonner";

import { StatusPill } from "@/components/site/control-primitives";
import { GateRampConfirmDialog } from "@/components/site/app-panels/gate-ramp-confirm-dialog";
import { StateBoundary } from "@/components/site/state-views";
import { Switch } from "@/components/ui/switch";
import { apiFetch } from "@/lib/api/request";
import { getApiOrigin } from "@/lib/api/origin";
import {
  buildBlockingRampPatch,
  summarizeGateRamp,
  type GateRampSettingsSlice,
} from "@/lib/gate-ramp";
import {
  buildMaintainerSettingsSavePayload,
  type MaintainerSettingsEditable,
} from "@/lib/maintainer-settings-editable";
import { extractPreviewRepoOptions, splitRepoFullName } from "@/lib/maintainer-settings-preview";

function repoApiBase(repoFullName: string): string | null {
  const target = splitRepoFullName(repoFullName);
  if (!target) return null;
  return `${getApiOrigin().replace(/\/$/, "")}/v1/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
}

const JSON_HEADERS = { Accept: "application/json", "Content-Type": "application/json" };
const FIELD_CLASS =
  "mt-1 min-h-10 w-full rounded-token border border-border bg-background/70 px-3 py-2 font-mono text-token-sm text-foreground outline-none transition-colors focus:border-mint";
const LABEL_CLASS = "font-mono text-token-2xs uppercase tracking-wider text-muted-foreground";

function normalizeLoadedSettings(data: MaintainerSettingsEditable): MaintainerSettingsEditable {
  return {
    ...data,
    autonomy: data.autonomy ?? {},
    agentPaused: data.agentPaused ?? false,
    agentDryRun: data.agentDryRun ?? false,
    autoMaintain: data.autoMaintain ?? { requireApprovals: 1, mergeMethod: "squash" },
  };
}

/**
 * One-click advisory → blocking ramp for the maintainer onboarding surface (#2218). Loads GET /settings,
 * reflects the current ramp phase, and on confirm merges the blocking patch through PUT /settings (same path
 * as maintainer-settings.tsx). AlertDialog gates the destructive flip; sonner toasts report save outcomes.
 */
export function GateRampControl({ reviewability }: { reviewability: Array<{ pr: string }> }) {
  const repoOptions = useMemo(() => extractPreviewRepoOptions(reviewability), [reviewability]);
  const [repoFullName, setRepoFullName] = useState(repoOptions[0] ?? "");
  const [settings, setSettings] = useState<MaintainerSettingsEditable | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const switchId = useId();
  const base = repoApiBase(repoFullName);
  const hasRepos = repoOptions.length > 0;

  const rampSlice: GateRampSettingsSlice | null = settings
    ? {
        reviewCheckMode: settings.reviewCheckMode,
        linkedIssueGateMode: settings.linkedIssueGateMode,
        duplicatePrGateMode: settings.duplicatePrGateMode,
        qualityGateMode: settings.qualityGateMode,
      }
    : null;

  const summary = rampSlice ? summarizeGateRamp(rampSlice) : null;

  const load = useCallback(async () => {
    const apiBase = repoApiBase(repoFullName);
    if (!apiBase) {
      setSettings(null);
      setLoadError(null);
      return;
    }
    setLoadError(null);
    setLoading(true);
    const result = await apiFetch<MaintainerSettingsEditable>(`${apiBase}/settings`, {
      label: "Repository settings",
      credentials: "include",
      silentStatus: true,
    });
    setSettings(result.ok ? normalizeLoadedSettings(result.data) : null);
    if (!result.ok) setLoadError(result.message);
    setLoading(false);
  }, [repoFullName]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveBlockingRamp() {
    if (!base || !settings) return;
    setBusy(true);
    const payload = buildMaintainerSettingsSavePayload(settings, buildBlockingRampPatch());
    const result = await apiFetch<MaintainerSettingsEditable>(`${base}/settings`, {
      method: "PUT",
      label: "Ramp to blocking",
      credentials: "include",
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
    });
    setBusy(false);
    setConfirmOpen(false);
    if (result.ok) {
      setSettings(normalizeLoadedSettings(result.data));
      toast.success("Blocking mode enabled", {
        description: "Linked-issue, duplicate-PR, and quality gates can now block merges.",
      });
    } else {
      toast.error("Could not enable blocking", { description: result.message });
    }
  }

  function handleSwitchChange(checked: boolean) {
    if (!summary?.canRampToBlocking || !checked) return;
    setConfirmOpen(true);
  }

  const switchChecked = summary?.isBlocking ?? false;
  const switchDisabled =
    busy || loading || !summary || !summary.canRampToBlocking || summary.isBlocking;

  return (
    <section
      className="rounded-token border-hairline bg-card p-5"
      aria-labelledby="gate-ramp-control-title"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="gate-ramp-control-title" className="font-display text-token-lg font-semibold">
            Gate ramp control
          </h2>
          <p className="mt-1 text-token-xs text-muted-foreground">
            After advisory mode is on, ramp deterministic gate rules to blocking in one action —
            with confirmation before merges can be held.
          </p>
        </div>
        {summary ? (
          <StatusPill
            status={summary.isBlocking ? "blocked" : summary.phase === "advisory" ? "info" : "warn"}
          >
            {summary.label}
          </StatusPill>
        ) : null}
      </div>

      <label className="mt-4 block max-w-sm">
        <span className={LABEL_CLASS}>Repository</span>
        <input
          value={repoFullName}
          onChange={(event) => setRepoFullName(event.target.value)}
          list="gate-ramp-repos"
          placeholder="owner/repo"
          className={FIELD_CLASS}
        />
        <datalist id="gate-ramp-repos">
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
          isEmpty={false}
          onRetry={load}
          onRefresh={load}
          loadingTitle="Loading gate ramp state…"
          errorTitle="Couldn't load repository settings"
          errorDescription={loadError ?? undefined}
        >
          {!base ? (
            <p className="text-token-sm text-muted-foreground">
              {hasRepos
                ? "Settings are unavailable for this repository."
                : "Enter an installed repository to manage the gate ramp."}
            </p>
          ) : summary && settings ? (
            <div className="space-y-4">
              <p className="text-token-sm text-foreground/90">{summary.description}</p>

              <div className="flex flex-wrap items-center justify-between gap-4 rounded-token border-hairline bg-background/40 px-4 py-3">
                <div className="flex min-w-0 items-start gap-3">
                  <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                  <div>
                    <label htmlFor={switchId} className="text-token-sm font-medium text-foreground">
                      Blocking enforcement
                    </label>
                    <p className="mt-0.5 text-token-2xs text-muted-foreground">
                      {summary.canRampToBlocking
                        ? "Off — advisory only. Turn on to block merges when gate findings fire."
                        : summary.isBlocking
                          ? "On — deterministic gates are blocking."
                          : "Unavailable until advisory mode is enabled above."}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {busy ? (
                    <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
                  ) : null}
                  <Switch
                    id={switchId}
                    checked={switchChecked}
                    disabled={switchDisabled}
                    aria-busy={busy}
                    onCheckedChange={handleSwitchChange}
                  />
                </div>
              </div>
            </div>
          ) : null}
        </StateBoundary>
      </div>

      {settings && rampSlice ? (
        <GateRampConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          repoFullName={repoFullName}
          settings={rampSlice}
          busy={busy}
          onConfirm={() => void saveBlockingRamp()}
        />
      ) : null}
    </section>
  );
}
