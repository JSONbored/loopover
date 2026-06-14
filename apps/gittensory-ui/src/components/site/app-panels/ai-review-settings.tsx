import { KeyRound, Loader2, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { StatusPill } from "@/components/site/control-primitives";
import { apiFetch } from "@/lib/api/request";
import { getApiOrigin } from "@/lib/api/origin";
import { extractPreviewRepoOptions, splitRepoFullName } from "@/lib/maintainer-settings-preview";

type AiReviewMode = "off" | "advisory" | "block";
type AiProvider = "anthropic" | "openai";

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
 * Maintainer self-serve AI review + BYOK key config. The provider key is write-only: it POSTs to the
 * encrypted key endpoint and only the configured/last4 status is ever read back — the key is never rendered.
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

  const load = useCallback(async () => {
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
    if (settings.ok) {
      setMode(settings.data.aiReviewMode ?? "off");
      setByok(settings.data.aiReviewByok ?? false);
      setProvider(settings.data.aiReviewProvider ?? "anthropic");
      setModel(settings.data.aiReviewModel ?? "");
    }
    setKeyStatus(key.ok ? key.data : null);
    setLoading(false);
  }, [repoFullName]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveConfig() {
    if (!base) {
      setMessage({ kind: "err", text: "Enter a repository as owner/repo." });
      return;
    }
    setBusy(true);
    const result = await apiFetch<RepoSettingsResponse>(`${base}/ai-review`, {
      method: "PUT",
      label: "Save AI review config",
      credentials: "include",
      headers: JSON_HEADERS,
      body: JSON.stringify({ mode, byok, provider, model: model.trim() || null }),
    });
    setBusy(false);
    setMessage(
      result.ok
        ? { kind: "ok", text: "AI review configuration saved." }
        : { kind: "err", text: result.message },
    );
  }

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
            Free Cloudflare Workers AI by default. Bring your own Anthropic/OpenAI key for a
            frontier-quality advisory write-up — your key, your provider account. Consensus blocking
            always uses the free models and only applies to confirmed contributors.
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

          <label className="block">
            <span className={labelClass}>Mode</span>
            <select
              value={mode}
              onChange={(event) => setMode(event.target.value as AiReviewMode)}
              className={fieldClass}
            >
              <option value="off">off — no AI review</option>
              <option value="advisory">advisory — AI notes only</option>
              <option value="block">block — also block on a dual-model consensus defect</option>
            </select>
          </label>

          <label className="flex items-center gap-2 text-token-sm">
            <input
              type="checkbox"
              checked={byok}
              onChange={(event) => setByok(event.target.checked)}
              className="size-4 accent-mint"
            />
            <span>Use my own provider key (BYOK) for the advisory write-up</span>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className={labelClass}>Provider</span>
              <select
                value={provider}
                onChange={(event) => setProvider(event.target.value as AiProvider)}
                className={fieldClass}
              >
                <option value="anthropic">Anthropic (Claude)</option>
                <option value="openai">OpenAI (GPT)</option>
              </select>
            </label>
            <label className="block">
              <span className={labelClass}>Model (optional)</span>
              <input
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="default"
                className={fieldClass}
              />
            </label>
          </div>

          <button
            type="button"
            disabled={busy || loading || !base}
            aria-busy={busy}
            onClick={() => void saveConfig()}
            className="inline-flex items-center gap-2 rounded-token border border-mint/40 bg-mint px-3 py-2 text-token-xs font-medium text-primary-foreground transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy || loading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Save className="size-3.5" />
            )}
            {loading ? "Loading…" : "Save configuration"}
          </button>
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
