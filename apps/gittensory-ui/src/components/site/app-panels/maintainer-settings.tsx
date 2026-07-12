import { FileCog, Loader2, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { StatusPill } from "@/components/site/control-primitives";
import { apiFetch } from "@/lib/api/request";
import { getApiOrigin } from "@/lib/api/origin";
import { extractPreviewRepoOptions, splitRepoFullName } from "@/lib/maintainer-settings-preview";

type GateMode = "off" | "advisory" | "block";
type CommandRole = "maintainer" | "collaborator" | "pr_author" | "confirmed_miner";

type CommandAuthorization = {
  default?: CommandRole[];
  commands?: Record<string, CommandRole[]>;
};

type MaintainerSettings = {
  commentMode: "off" | "detected_contributors_only" | "all_prs";
  publicAudienceMode: "oss_maintainer" | "gittensor_only";
  publicSignalLevel: "minimal" | "standard";
  publicSurface: "off" | "comment_and_label" | "comment_only" | "label_only";
  checkRunMode: "off" | "enabled";
  checkRunDetailLevel: "minimal" | "standard";
  // #4618: gateCheckMode is deprecated (a computed read-back value only) -- reviewCheckMode is the real,
  // writable authority for whether the review-agent check-run publishes.
  reviewCheckMode: "required" | "visible" | "disabled";
  gatePack: "gittensor" | "oss-anti-slop";
  linkedIssueGateMode: GateMode;
  duplicatePrGateMode: GateMode;
  qualityGateMode: GateMode;
  qualityGateMinScore: number | null;
  mergeReadinessGateMode: GateMode;
  manifestPolicyGateMode: GateMode;
  firstTimeContributorGrace: boolean;
  slopGateMode: GateMode;
  slopGateMinScore: number | null;
  slopAiAdvisory: boolean;
  autoLabelEnabled: boolean;
  gittensorLabel: string;
  createMissingLabel: boolean;
  includeMaintainerAuthors: boolean;
  requireLinkedIssue: boolean;
  badgeEnabled: boolean;
  publicQualityMetrics: boolean;
  commandAuthorization: CommandAuthorization;
  autonomy: Partial<Record<AgentActionClass, AutonomyLevel>>;
  autoMaintain: { requireApprovals: number; mergeMethod: AutoMergeMethod };
  agentPaused: boolean;
  agentDryRun: boolean;
};

type AutonomyLevel = "observe" | "auto_with_approval" | "auto";
type AgentActionClass = "review" | "request_changes" | "approve" | "merge" | "close" | "label";
type AutoMergeMethod = "merge" | "squash" | "rebase";

const AUTONOMY_LEVELS: AutonomyLevel[] = ["observe", "auto_with_approval", "auto"];
const AGENT_ACTION_CLASSES: AgentActionClass[] = [
  "review",
  "request_changes",
  "approve",
  "merge",
  "close",
  "label",
];

type Message = { kind: "ok" | "err"; text: string };

const GATE_MODE_OPTIONS: Array<[GateMode, string]> = [
  ["off", "off"],
  ["advisory", "advisory"],
  ["block", "block"],
];

const COMMAND_ROLES: Array<[CommandRole, string]> = [
  ["maintainer", "maintainer"],
  ["collaborator", "collaborator"],
  ["pr_author", "PR author"],
  ["confirmed_miner", "confirmed miner"],
];

// The maintainer-editable subset, sent verbatim to PUT /settings (which merges onto current settings).
const EDITABLE_KEYS: Array<keyof MaintainerSettings> = [
  "commentMode",
  "publicAudienceMode",
  "publicSignalLevel",
  "publicSurface",
  "checkRunMode",
  "checkRunDetailLevel",
  "reviewCheckMode",
  "gatePack",
  "linkedIssueGateMode",
  "duplicatePrGateMode",
  "qualityGateMode",
  "qualityGateMinScore",
  "mergeReadinessGateMode",
  "manifestPolicyGateMode",
  "firstTimeContributorGrace",
  "slopGateMode",
  "slopGateMinScore",
  "slopAiAdvisory",
  "autoLabelEnabled",
  "gittensorLabel",
  "createMissingLabel",
  "includeMaintainerAuthors",
  "requireLinkedIssue",
  "badgeEnabled",
  "publicQualityMetrics",
  "commandAuthorization",
  "autonomy",
  "autoMaintain",
  "agentPaused",
  "agentDryRun",
];

type SelectFieldDef = {
  key: keyof MaintainerSettings;
  label: string;
  kind: "select";
  options: Array<[string, string]>;
};
type ToggleFieldDef = {
  key: keyof MaintainerSettings;
  label: string;
  kind: "toggle";
  hint?: string;
  // Renders greyed-out and non-interactive with the hint as the disclosure -- for a field that is real
  // and DB-backed but currently wired to nothing (e.g. firstTimeContributorGrace, #2266/#2411), so a
  // maintainer can't be misled into thinking the toggle has an effect.
  disabled?: boolean;
};
type NumberFieldDef = {
  key: keyof MaintainerSettings;
  label: string;
  kind: "number";
  placeholder?: string;
};
type FieldDef = SelectFieldDef | ToggleFieldDef | NumberFieldDef;

const GATE_FIELDS: FieldDef[] = [
  {
    key: "reviewCheckMode",
    label: "Review agent check",
    kind: "select",
    // "visible" (publishes but never required in branch protection) is deliberately not offered here --
    // this toggle keeps its historical off/enabled shape; set .gittensory.yml gate.checkMode: visible directly
    // for that finer-grained mode.
    options: [
      ["disabled", "off"],
      ["required", "enabled"],
    ],
  },
  {
    key: "gatePack",
    label: "Policy pack",
    kind: "select",
    options: [
      ["gittensor", "gittensor (confirmed-only)"],
      ["oss-anti-slop", "oss-anti-slop (any author)"],
    ],
  },
  {
    key: "mergeReadinessGateMode",
    label: "Merge-readiness (master)",
    kind: "select",
    options: GATE_MODE_OPTIONS,
  },
  { key: "linkedIssueGateMode", label: "Linked issue", kind: "select", options: GATE_MODE_OPTIONS },
  { key: "duplicatePrGateMode", label: "Duplicate PR", kind: "select", options: GATE_MODE_OPTIONS },
  {
    key: "qualityGateMode",
    label: "Quality / readiness",
    kind: "select",
    options: GATE_MODE_OPTIONS,
  },
  {
    key: "qualityGateMinScore",
    label: "Quality min score",
    kind: "number",
    placeholder: "default",
  },
  {
    key: "manifestPolicyGateMode",
    label: "Focus-manifest policy",
    kind: "select",
    options: GATE_MODE_OPTIONS,
  },
  {
    key: "firstTimeContributorGrace",
    label: "First-time-contributor grace",
    kind: "toggle",
    hint: "Reserved — currently has no effect on gate decisions (#2266)",
    disabled: true,
  },
];

const SLOP_FIELDS: FieldDef[] = [
  { key: "slopGateMode", label: "Slop gate", kind: "select", options: GATE_MODE_OPTIONS },
  {
    key: "slopGateMinScore",
    label: "Slop min score",
    kind: "number",
    placeholder: "60 (high band)",
  },
  {
    key: "slopAiAdvisory",
    label: "AI slop advisory",
    kind: "toggle",
    hint: "Append an AI-assisted advisory note",
  },
];

const SURFACE_FIELDS: FieldDef[] = [
  {
    key: "commentMode",
    label: "Comment mode",
    kind: "select",
    options: [
      ["off", "off"],
      ["detected_contributors_only", "detected contributors only"],
      ["all_prs", "all PRs"],
    ],
  },
  {
    key: "publicSurface",
    label: "Public surface",
    kind: "select",
    options: [
      ["off", "off"],
      ["comment_and_label", "comment + label"],
      ["comment_only", "comment only"],
      ["label_only", "label only"],
    ],
  },
  {
    key: "publicSignalLevel",
    label: "Public signal level",
    kind: "select",
    options: [
      ["minimal", "minimal"],
      ["standard", "standard"],
    ],
  },
  {
    key: "publicAudienceMode",
    label: "Audience",
    kind: "select",
    options: [
      ["oss_maintainer", "OSS maintainer"],
      ["gittensor_only", "gittensor only"],
    ],
  },
  {
    key: "checkRunMode",
    label: "Context check run",
    kind: "select",
    options: [
      ["off", "off"],
      ["enabled", "enabled"],
    ],
  },
  {
    key: "checkRunDetailLevel",
    label: "Check detail",
    kind: "select",
    options: [
      ["minimal", "minimal"],
      ["standard", "standard"],
    ],
  },
  { key: "includeMaintainerAuthors", label: "Include maintainer-authored PRs", kind: "toggle" },
  { key: "requireLinkedIssue", label: "Require a linked issue", kind: "toggle" },
  { key: "badgeEnabled", label: "Repo badge", kind: "toggle" },
  { key: "publicQualityMetrics", label: "Public quality page", kind: "toggle" },
];

function repoApiBase(repoFullName: string): string | null {
  const target = splitRepoFullName(repoFullName);
  if (!target) return null;
  return `${getApiOrigin().replace(/\/$/, "")}/v1/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
}

const JSON_HEADERS = { Accept: "application/json", "Content-Type": "application/json" };
const FIELD_CLASS =
  "mt-1 min-h-10 w-full rounded-token border border-border bg-background/70 px-3 py-2 font-mono text-token-sm text-foreground outline-none transition-colors focus:border-mint";
const LABEL_CLASS = "font-mono text-token-2xs uppercase tracking-wider text-muted-foreground";

/**
 * Maintainer self-serve editor for the per-repo gate / slop / label / surface / command-authorization
 * settings (#130). Loads GET /settings, saves a merge via PUT /settings; the focus manifest has its own
 * load/save against /focus-manifest. The secret AI key and operator-only scoring internals are not editable
 * here — they live on the AI-review panel and operator surfaces respectively.
 */
export function MaintainerSettings({ reviewability }: { reviewability: Array<{ pr: string }> }) {
  const repoOptions = useMemo(() => extractPreviewRepoOptions(reviewability), [reviewability]);
  const [repoFullName, setRepoFullName] = useState(repoOptions[0] ?? "");
  const [settings, setSettings] = useState<MaintainerSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);

  const base = repoApiBase(repoFullName);
  const hasRepos = repoOptions.length > 0;

  const load = useCallback(async () => {
    const apiBase = repoApiBase(repoFullName);
    if (!apiBase) return;
    setMessage(null);
    setLoading(true);
    const result = await apiFetch<MaintainerSettings>(`${apiBase}/settings`, {
      label: "Repository settings",
      credentials: "include",
      silentStatus: true,
    });
    // Default the agent-layer fields defensively so the editor renders even against an older response shape.
    setSettings(
      result.ok
        ? {
            ...result.data,
            autonomy: result.data.autonomy ?? {},
            agentPaused: result.data.agentPaused ?? false,
            agentDryRun: result.data.agentDryRun ?? false,
            autoMaintain: result.data.autoMaintain ?? {
              requireApprovals: 1,
              mergeMethod: "squash",
            },
          }
        : null,
    );
    setLoading(false);
  }, [repoFullName]);

  useEffect(() => {
    void load();
  }, [load]);

  function setField<K extends keyof MaintainerSettings>(key: K, value: MaintainerSettings[K]) {
    setSettings((current) => (current ? { ...current, [key]: value } : current));
  }

  async function save() {
    if (!base || !settings) return;
    setBusy(true);
    const payload = Object.fromEntries(EDITABLE_KEYS.map((key) => [key, settings[key]]));
    const result = await apiFetch<MaintainerSettings>(`${base}/settings`, {
      method: "PUT",
      label: "Save repository settings",
      credentials: "include",
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
    });
    setBusy(false);
    if (result.ok) {
      setSettings(result.data);
      setMessage({ kind: "ok", text: "Settings saved." });
    } else {
      setMessage({ kind: "err", text: result.message });
    }
  }

  const defaultRoles = settings?.commandAuthorization?.default ?? [];
  const commandOverrides = Object.entries(settings?.commandAuthorization?.commands ?? {});

  return (
    <section
      className="rounded-token border-hairline bg-card p-5"
      aria-labelledby="maintainer-settings-title"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="maintainer-settings-title" className="font-display text-token-lg font-semibold">
            Repository settings
          </h2>
          <p className="mt-1 text-token-xs text-muted-foreground">
            Configure exactly what Gittensory enforces and surfaces on this repo — gate modes,
            anti-slop, labels, public output, and who can run each command. Changes are audited.
          </p>
        </div>
        {settings ? (
          <StatusPill status={settings.reviewCheckMode === "disabled" ? "info" : "ready"}>
            gate {settings.reviewCheckMode === "disabled" ? "off" : "enabled"}
          </StatusPill>
        ) : null}
      </div>

      <label className="mt-4 block max-w-sm">
        <span className={LABEL_CLASS}>Repository</span>
        <input
          value={repoFullName}
          onChange={(event) => setRepoFullName(event.target.value)}
          list="maintainer-settings-repos"
          placeholder="owner/repo"
          className={FIELD_CLASS}
        />
        <datalist id="maintainer-settings-repos">
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

      {loading ? (
        <p className="mt-6 flex items-center gap-2 text-token-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading settings…
        </p>
      ) : settings ? (
        <div className="mt-6 space-y-6">
          <FieldGroup
            title="Merge gate"
            fields={GATE_FIELDS}
            settings={settings}
            setField={setField}
          />
          <FieldGroup
            title="Anti-slop"
            fields={SLOP_FIELDS}
            settings={settings}
            setField={setField}
          />
          <div>
            <h3 className={LABEL_CLASS}>Labels</h3>
            <div className="mt-2 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <ToggleControl
                label="Auto-label PRs"
                hint="Only the base context label below — type labels have their own toggle"
                value={settings.autoLabelEnabled}
                onChange={(v) => setField("autoLabelEnabled", v)}
              />
              <label className="block">
                <span className={LABEL_CLASS}>Label name</span>
                <input
                  value={settings.gittensorLabel}
                  onChange={(event) => setField("gittensorLabel", event.target.value)}
                  className={FIELD_CLASS}
                />
              </label>
              <ToggleControl
                label="Create label if missing"
                value={settings.createMissingLabel}
                onChange={(v) => setField("createMissingLabel", v)}
              />
            </div>
          </div>
          <FieldGroup
            title="Public output & checks"
            fields={SURFACE_FIELDS}
            settings={settings}
            setField={setField}
          />

          <div>
            <h3 className={LABEL_CLASS}>Command authorization</h3>
            <p className="mt-1 text-token-2xs text-muted-foreground">
              Default roles allowed to run any <code className="font-mono">@gittensory</code>{" "}
              command. Per-command overrides (edited via the focus manifest) are shown below.
            </p>
            <div className="mt-2 flex flex-wrap gap-3">
              {COMMAND_ROLES.map(([role, roleLabel]) => (
                <label key={role} className="flex items-center gap-2 text-token-sm">
                  <input
                    type="checkbox"
                    checked={defaultRoles.includes(role)}
                    onChange={(event) => {
                      const next = event.target.checked
                        ? [...new Set([...defaultRoles, role])]
                        : defaultRoles.filter((existing) => existing !== role);
                      setField("commandAuthorization", {
                        ...settings.commandAuthorization,
                        default: next,
                      });
                    }}
                    className="size-4 accent-mint"
                  />
                  <span>{roleLabel}</span>
                </label>
              ))}
            </div>
            {commandOverrides.length > 0 ? (
              <dl className="mt-3 grid gap-x-4 gap-y-1 text-token-2xs sm:grid-cols-2">
                {commandOverrides.map(([command, roles]) => (
                  <div key={command} className="min-w-0">
                    <dt className="font-mono text-foreground/90">{command}</dt>
                    <dd className="break-words text-muted-foreground">{roles.join(", ")}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </div>

          <div>
            <h3 className={LABEL_CLASS}>Auto-maintain (agent layer)</h3>
            <p className="mt-1 text-token-2xs text-muted-foreground">
              Per-action autonomy: <code className="font-mono">observe</code> (watch only) →{" "}
              <code className="font-mono">auto_with_approval</code> →{" "}
              <code className="font-mono">auto</code>. Deny-by-default — anything left at{" "}
              <code className="font-mono">observe</code> never acts.
            </p>
            <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {AGENT_ACTION_CLASSES.map((actionClass) => (
                <label key={actionClass} className="block">
                  <span className={LABEL_CLASS}>{actionClass.replace(/_/g, " ")}</span>
                  <select
                    value={settings.autonomy[actionClass] ?? "observe"}
                    onChange={(event) =>
                      setField("autonomy", {
                        ...settings.autonomy,
                        [actionClass]: event.target.value as AutonomyLevel,
                      })
                    }
                    className={FIELD_CLASS}
                  >
                    {AUTONOMY_LEVELS.map((level) => (
                      <option key={level} value={level}>
                        {level}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <label className="block">
                <span className={LABEL_CLASS}>Approvals before auto-merge</span>
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={settings.autoMaintain.requireApprovals}
                  onChange={(event) =>
                    setField("autoMaintain", {
                      ...settings.autoMaintain,
                      requireApprovals: Math.max(0, Math.min(10, Number(event.target.value) || 0)),
                    })
                  }
                  className={FIELD_CLASS}
                />
              </label>
              <label className="block">
                <span className={LABEL_CLASS}>Merge method</span>
                <select
                  value={settings.autoMaintain.mergeMethod}
                  onChange={(event) =>
                    setField("autoMaintain", {
                      ...settings.autoMaintain,
                      mergeMethod: event.target.value as AutoMergeMethod,
                    })
                  }
                  className={FIELD_CLASS}
                >
                  <option value="merge">merge</option>
                  <option value="squash">squash</option>
                  <option value="rebase">rebase</option>
                </select>
              </label>
            </div>
            <div className="mt-3 flex flex-wrap gap-6">
              <ToggleControl
                label="Pause all agent actions (kill-switch)"
                hint="Take no action on this repo until re-enabled"
                value={settings.agentPaused}
                onChange={(v) => setField("agentPaused", v)}
              />
              <ToggleControl
                label="Dry-run / shadow mode"
                hint="Suppress GitHub writes only — AI review calls still run and still cost tokens"
                value={settings.agentDryRun}
                onChange={(v) => setField("agentDryRun", v)}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={busy || !base}
              aria-busy={busy}
              onClick={() => void save()}
              className="inline-flex items-center gap-2 rounded-token border border-mint/40 bg-mint px-3 py-2 text-token-xs font-medium text-primary-foreground transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
              Save settings
            </button>
            <span
              role="status"
              aria-live="polite"
              className={`text-token-xs ${message ? (message.kind === "ok" ? "text-mint" : "text-warning") : "sr-only"}`}
            >
              {message?.text ?? ""}
            </span>
          </div>

          <FocusManifestEditor base={base} />
        </div>
      ) : (
        <p className="mt-6 text-token-sm text-muted-foreground">
          {hasRepos
            ? "Settings are unavailable for this repository."
            : "Enter an installed repository to configure it."}
        </p>
      )}
    </section>
  );
}

function FieldGroup({
  title,
  fields,
  settings,
  setField,
}: {
  title: string;
  fields: FieldDef[];
  settings: MaintainerSettings;
  setField: <K extends keyof MaintainerSettings>(key: K, value: MaintainerSettings[K]) => void;
}) {
  return (
    <div>
      <h3 className={LABEL_CLASS}>{title}</h3>
      <div className="mt-2 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {fields.map((field) => {
          if (field.kind === "toggle") {
            return (
              <ToggleControl
                key={field.key}
                label={field.label}
                hint={field.hint}
                disabled={field.disabled}
                value={settings[field.key] as boolean}
                onChange={(value) =>
                  setField(field.key, value as MaintainerSettings[typeof field.key])
                }
              />
            );
          }
          if (field.kind === "number") {
            const raw = settings[field.key] as number | null;
            return (
              <label key={field.key} className="block">
                <span className={LABEL_CLASS}>{field.label}</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={raw ?? ""}
                  placeholder={field.placeholder}
                  onChange={(event) => {
                    const next =
                      event.target.value === ""
                        ? null
                        : Math.max(0, Math.min(100, Number(event.target.value)));
                    setField(field.key, next as MaintainerSettings[typeof field.key]);
                  }}
                  className={FIELD_CLASS}
                />
              </label>
            );
          }
          return (
            <label key={field.key} className="block">
              <span className={LABEL_CLASS}>{field.label}</span>
              <select
                value={String(settings[field.key])}
                onChange={(event) =>
                  setField(field.key, event.target.value as MaintainerSettings[typeof field.key])
                }
                className={FIELD_CLASS}
              >
                {field.options.map(([value, optionLabel]) => (
                  <option key={value} value={value}>
                    {optionLabel}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function ToggleControl({
  label,
  hint,
  value,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`flex items-start gap-2 text-token-sm ${disabled ? "opacity-60" : ""}`}>
      <input
        type="checkbox"
        checked={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-4 accent-mint"
      />
      <span>
        {label}
        {hint ? <span className="block text-token-2xs text-muted-foreground">{hint}</span> : null}
      </span>
    </label>
  );
}

type FocusManifestResponse = { manifest: unknown };

/**
 * Edit the repo's focus manifest as JSON. The manifest is repo-public config-as-code (it mirrors
 * `.gittensory.yml`); this surface lets a maintainer edit the API-record copy without committing a file.
 */
function FocusManifestEditor({ base }: { base: string | null }) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);

  const load = useCallback(async () => {
    if (!base) return;
    setLoading(true);
    setMessage(null);
    const result = await apiFetch<FocusManifestResponse>(`${base}/focus-manifest`, {
      label: "Focus manifest",
      credentials: "include",
      silentStatus: true,
    });
    setText(result.ok ? JSON.stringify(result.data.manifest, null, 2) : "");
    setLoading(false);
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!base) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setMessage({ kind: "err", text: "Manifest must be valid JSON." });
      return;
    }
    setBusy(true);
    const result = await apiFetch<FocusManifestResponse>(`${base}/focus-manifest`, {
      method: "PUT",
      label: "Save focus manifest",
      credentials: "include",
      headers: JSON_HEADERS,
      body: JSON.stringify(parsed),
    });
    setBusy(false);
    if (result.ok) {
      setText(JSON.stringify(result.data.manifest, null, 2));
      setMessage({ kind: "ok", text: "Focus manifest saved." });
    } else {
      setMessage({ kind: "err", text: result.message });
    }
  }

  return (
    <div className="rounded-token border-hairline bg-background/40 p-4">
      <h3 className="flex items-center gap-2 font-medium">
        <FileCog className="size-4" /> Focus manifest (config-as-code)
      </h3>
      <p className="mt-1 text-token-2xs text-muted-foreground">
        The repo&apos;s maintainer focus policy as JSON — wanted paths, linked-issue policy, test
        expectations, and gate overrides. Mirrors <code className="font-mono">.gittensory.yml</code>
        .
      </p>
      <textarea
        value={loading ? "Loading…" : text}
        onChange={(event) => setText(event.target.value)}
        readOnly={loading}
        spellCheck={false}
        rows={10}
        className="mt-3 w-full rounded-token border border-border bg-background/70 px-3 py-2 font-mono text-token-xs text-foreground outline-none transition-colors focus:border-mint"
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy || loading || !base}
          aria-busy={busy}
          onClick={() => void save()}
          className="inline-flex items-center gap-2 rounded-token border border-mint/40 bg-mint px-3 py-2 text-token-xs font-medium text-primary-foreground transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
          Save manifest
        </button>
        <span
          role="status"
          aria-live="polite"
          className={`text-token-xs ${message ? (message.kind === "ok" ? "text-mint" : "text-warning") : "sr-only"}`}
        >
          {message?.text ?? ""}
        </span>
      </div>
    </div>
  );
}
