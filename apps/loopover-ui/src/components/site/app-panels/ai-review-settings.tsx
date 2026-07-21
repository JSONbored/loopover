import { KeyRound, Loader2, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { StatusPill } from "@/components/site/control-primitives";
import { apiFetch } from "@/lib/api/request";
import { getApiOrigin } from "@/lib/api/origin";
import { extractPreviewRepoOptions, splitRepoFullName } from "@/lib/maintainer-settings-preview";

type AiReviewMode = "off" | "advisory" | "block";
type AiProvider = "anthropic" | "openai";

const MODE_COPY: Record<AiReviewMode, string> = {
  off: "off — no AI review",
  advisory: "advisory — AI notes only",
  block: "block — also blocks on a dual-model consensus defect",
};

type RepoSettingsResponse = {
  aiReviewMode?: AiReviewMode;
  aiReviewByok?: boolean;
  aiReviewProvider?: AiProvider | null;
  aiReviewModel?: string | null;
};

type AiKeyStatus = {
  configured: boolean;
  provider?: AiProvider;
  last4?: string;
  model?: string | null;
};

type Message = { kind: "ok" | "err"; text: string };

function repoApiBase(repoFullName: string): string | null {
  const target = splitRepoFullName(repoFullName);
  if (!target) return null;
  return `${getApiOrigin().replace(/\/$/, "")}/v1/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
}

const JSON_HEADERS = { Accept: "application/json", "Content-Type": "application/json" };

/**
 * Maintainer AI review status + self-serve BYOK key config. mode/byok/provider/model are config-as-code
 * only now (Batch C, loopover#6444) -- read-only here, sourced from GET /settings (manifest-resolved),
 * with guidance to edit the repo's own .loopover.yml gate.aiReview.* block to change them. The provider
 * key management (still fully DB-backed) is unaffected: it POSTs to the encrypted key endpoint and only
 * the configured/last4 status is ever read back — the key is never rendered.
 */
export function AiReviewSettings({ reviewability }: { reviewability: Array<{ pr: string }> }) {
  const repoOptions = useMemo(() => extractPreviewRepoOptions(reviewability), [reviewability]);
  const [repoFullName, setRepoFullName] = useState(repoOptions[0] ?? "");
  const [mode, setMode] = useState<AiReviewMode>("off");
  const [byok, setByok] = useState(false);
  const [provider, setProvider] = useState<AiProvider>("anthropic");
  const [model, setModel] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [keyStatus, setKeyStatus] = useState<AiKeyStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);

  const base = repoApiBase(repoFullName);
  const hasRepos = repoOptions.length > 0;

  // isCancelled guards against an out-of-order response: a keystroke replaces repoFullName (and re-runs the
  // effect) before an earlier request resolves, so an older fetch must not overwrite the newer repo's settings
  // and key status (#7784). Same cancelled-flag idiom as use-polled-fetch.ts -- flipped in the effect cleanup.
  const load = useCallback(
    async (isCancelled: () => boolean = () => false) => {
      const apiBase = repoApiBase(repoFullName);
      if (!apiBase) return;
      setMessage(null);
      setLoading(true);
      const [settings, key] = await Promise.all([
        apiFetch<RepoSettingsResponse>(`${apiBase}/settings`, {
          label: "AI review settings",
          credentials: "include",
          silentStatus: true,
        }),
        apiFetch<AiKeyStatus>(`${apiBase}/ai-key`, {
          label: "AI key status",
          credentials: "include",
          silentStatus: true,
        }),
      ]);
      if (isCancelled()) return;
      if (settings.ok) {
        setMode(settings.data.aiReviewMode ?? "off");
        setByok(settings.data.aiReviewByok ?? false);
        setProvider(settings.data.aiReviewProvider ?? "anthropic");
        setModel(settings.data.aiReviewModel ?? "");
      }
      setKeyStatus(key.ok ? key.data : null);
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

  async function saveKey() {
    if (!base) return;
    const trimmed = keyInput.trim();
    if (trimmed.length < 20) {
      setMessage({ kind: "err", text: "Enter a valid provider API key." });
      return;
    }
    // Mirror the server-side prefix check so an obvious provider/key mismatch is caught before the round-trip.
    const matchesProvider =
      provider === "anthropic"
        ? trimmed.startsWith("sk-ant-")
        : trimmed.startsWith("sk-") && !trimmed.startsWith("sk-ant-");
    if (!matchesProvider) {
      setMessage({
        kind: "err",
        text:
          provider === "anthropic"
            ? "Anthropic keys start with sk-ant-."
            : "OpenAI keys start with sk- (and not sk-ant-).",
      });
      return;
    }
    setBusy(true);
    const result = await apiFetch<AiKeyStatus>(`${base}/ai-key`, {
      method: "POST",
      label: "Save provider key",
      credentials: "include",
      headers: JSON_HEADERS,
      body: JSON.stringify({ provider, key: trimmed, model: model.trim() || null }),
    });
    setBusy(false);
    if (result.ok) {
      setKeyStatus(result.data);
      setKeyInput("");
      setMessage({ kind: "ok", text: "Provider key stored (encrypted)." });
    } else {
      setMessage({ kind: "err", text: result.message });
    }
  }

  async function removeKey() {
    if (!base) return;
    setBusy(true);
    const result = await apiFetch<AiKeyStatus>(`${base}/ai-key`, {
      method: "DELETE",
      label: "Remove provider key",
      credentials: "include",
    });
    setBusy(false);
    if (result.ok) {
      setKeyStatus({ configured: false });
      setMessage({ kind: "ok", text: "Provider key removed." });
    } else {
      setMessage({ kind: "err", text: result.message });
    }
  }

  const fieldClass =
    "mt-1 min-h-10 w-full rounded-token border border-border bg-background/70 px-3 py-2 font-mono text-token-sm text-foreground outline-none transition-colors focus:border-mint";
  const labelClass = "font-mono text-token-2xs uppercase tracking-wider text-muted-foreground";

  return (
    <section
      className="rounded-token border-hairline bg-card p-5"
      aria-labelledby="ai-review-settings-title"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="ai-review-settings-title" className="font-display text-token-lg font-semibold">
            AI review &amp; BYOK
          </h2>
          <p className="mt-1 text-token-xs text-muted-foreground">
            Mode, BYOK, provider, and model are set in this repo's own{" "}
            <code className="font-mono">.loopover.yml</code> (
            <code className="font-mono">gate.aiReview.*</code>) now — shown below as read-only
            status. Consensus blocking always uses the default reviewer and only applies to
            confirmed contributors.
          </p>
        </div>
        <StatusPill status={mode === "off" ? "info" : mode === "block" ? "warn" : "ready"}>
          {mode}
        </StatusPill>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <label className="block">
            <span className={labelClass}>Repository</span>
            <input
              value={repoFullName}
              onChange={(event) => setRepoFullName(event.target.value)}
              list="ai-review-repos"
              placeholder="owner/repo"
              className={fieldClass}
            />
            <datalist id="ai-review-repos">
              {repoOptions.map((repo) => (
                <option key={repo} value={repo} />
              ))}
            </datalist>
            {!hasRepos ? (
              <span className="mt-1 block text-token-2xs text-muted-foreground">
                No registered repositories detected yet — type an installed{" "}
                <code className="font-mono">owner/repo</code> to configure it.
              </span>
            ) : null}
          </label>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <span className={labelClass}>Mode</span>
              <p className="mt-1 text-token-sm text-foreground/90">{MODE_COPY[mode]}</p>
            </div>
            <div>
              <span className={labelClass}>BYOK</span>
              <p className="mt-1 text-token-sm text-foreground/90">{byok ? "on" : "off"}</p>
            </div>
            <div>
              <span className={labelClass}>Provider</span>
              <p className="mt-1 text-token-sm text-foreground/90">
                {provider === "anthropic" ? "Anthropic (Claude)" : "OpenAI (GPT)"}
              </p>
            </div>
            <div>
              <span className={labelClass}>Model</span>
              <p className="mt-1 text-token-sm text-foreground/90">{model || "default"}</p>
            </div>
          </div>
        </div>

        <div className="space-y-4 rounded-token border-hairline bg-background/40 p-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 font-medium">
              <KeyRound className="size-4" /> Provider API key
            </h3>
            <StatusPill status={keyStatus?.configured ? "ready" : "info"}>
              {keyStatus?.configured ? `configured ····${keyStatus.last4 ?? ""}` : "not set"}
            </StatusPill>
          </div>
          <p className="text-token-2xs text-muted-foreground">
            Stored encrypted at rest and used only to generate the advisory review. It is never
            shown again, logged, or posted publicly.
          </p>
          <label className="block">
            <span className={labelClass}>
              {provider === "anthropic" ? "Anthropic API key" : "OpenAI API key"}
            </span>
            <input
              type="password"
              value={keyInput}
              onChange={(event) => setKeyInput(event.target.value)}
              autoComplete="off"
              placeholder={provider === "anthropic" ? "sk-ant-…" : "sk-…"}
              className={fieldClass}
            />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy || loading || !base}
              aria-busy={busy}
              onClick={() => void saveKey()}
              className="inline-flex items-center gap-2 rounded-token border border-mint/40 bg-mint px-3 py-2 text-token-xs font-medium text-primary-foreground transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
              {keyStatus?.configured ? "Replace key" : "Save key"}
            </button>
            {keyStatus?.configured ? (
              <button
                type="button"
                disabled={busy || loading || !base}
                aria-busy={busy}
                onClick={() => void removeKey()}
                className="inline-flex items-center gap-2 rounded-token border border-border px-3 py-2 text-token-xs font-medium text-foreground transition-colors hover:border-warning/50 hover:text-warning disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Trash2 className="size-3.5" /> Remove
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <p
        role="status"
        aria-live="polite"
        className={`mt-4 text-token-xs ${message ? (message.kind === "ok" ? "text-mint" : "text-warning") : "sr-only"}`}
      >
        {message?.text ?? ""}
      </p>
    </section>
  );
}
