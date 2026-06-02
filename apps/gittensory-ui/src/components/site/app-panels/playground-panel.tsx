import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Check, Copy, History, RefreshCw, RotateCw, Sparkles, Trash2, WifiOff } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

import { StatusPill } from "@/components/site/control-primitives";
import { Button } from "@/components/ui/button";
import { StateBoundary } from "@/components/site/state-views";
import { useSession } from "@/lib/api/session";
import { getApiOrigin } from "@/lib/api/origin";
import { apiFetch } from "@/lib/api/request";
import { describeApiStatus, pingHealth, useApiStatus } from "@/lib/api/status";
import { cn } from "@/lib/utils";
import {
  PLAYGROUND_SCENARIOS,
  PLAYGROUND_TOOLS,
  buildPlaygroundRequest,
  playgroundToolUsesPullNumber,
  playgroundToolUsesScenario,
  type PlaygroundScenarioId,
  type PlaygroundToolId,
} from "@/lib/playground-tools";

const TOOLS = PLAYGROUND_TOOLS;
type Tool = PlaygroundToolId;

const SCENARIOS = PLAYGROUND_SCENARIOS;
type Scenario = PlaygroundScenarioId;

interface HistoryEntry {
  id: string;
  tool: Tool;
  repo: string;
  branch: string;
  scenario: Scenario;
  aiSummary: boolean;
  createdAt: number;
}

const HISTORY_KEY = "gt:playground-history";
const HISTORY_LIMIT = 8;

function loadHistory(): HistoryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as HistoryEntry[];
    return Array.isArray(parsed) ? parsed.slice(0, HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

function saveHistory(entries: HistoryEntry[]) {
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, HISTORY_LIMIT)));
  } catch {
    /* noop */
  }
}

function timeAgo(ts: number) {
  const diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function PlaygroundPanel({ defaultTool = "preflight-branch" }: { defaultTool?: Tool }) {
  const [tool, setTool] = useState<Tool>(defaultTool);
  const [repo, setRepo] = useState("entrius/gittensor");
  const [branch, setBranch] = useState("feat/coverage-1204");
  const [aiSummary, setAiSummary] = useState(true);
  const [scenario, setScenario] = useState<Scenario>("gated");
  const [pullNumber, setPullNumber] = useState("1");
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory());
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [liveResult, setLiveResult] = useState<unknown | null>(null);
  const { status, connection } = useApiStatus();
  const { session } = useSession();
  const offline = connection === "offline";
  const apiBroken = status === "unreachable" || status === "timeout";
  const disabled = offline || apiBroken || busy;
  const canUseLiveApi = !!session;

  useEffect(() => {
    saveHistory(history);
  }, [history]);

  const result = useMemo(
    () => liveResult ?? { status: "not_run", tool, repo, branch, scenario },
    [branch, liveResult, repo, scenario, tool],
  );
  const ai = useMemo(() => summarizeResult(tool, result), [tool, result]);
  const showScenarios = playgroundToolUsesScenario(tool);
  const showPullNumber = playgroundToolUsesPullNumber(tool);

  const recordRun = (entry: Omit<HistoryEntry, "id" | "createdAt">) => {
    const next: HistoryEntry = {
      ...entry,
      id: `pl_${Date.now().toString(36)}`,
      createdAt: Date.now(),
    };
    setHistory((prev) => [next, ...prev].slice(0, HISTORY_LIMIT));
  };

  const onRun = async () => {
    if (disabled) {
      toast.error("Playground unavailable", {
        description: offline
          ? "You're offline. Reconnect to run playground requests."
          : `${describeApiStatus(status)}. Wait for the API to recover, then try again.`,
      });
      return;
    }
    setBusy(true);
    setLiveResult(null);
    try {
      if (canUseLiveApi && session) {
        const live = await runLiveTool({
          tool,
          repoFullName: repo,
          branchName: branch,
          scenario,
          login: session.login,
          pullNumber: showPullNumber ? Number.parseInt(pullNumber, 10) || 1 : undefined,
        });
        if (live.ok) {
          setLiveResult(live.data);
          toast.success("Live API response returned", {
            description: "Saved to local history for quick reruns.",
          });
        } else {
          toast.error("Live API request failed", {
            description: `${live.status ?? live.kind}: ${live.message}`,
          });
          return;
        }
      } else {
        toast.error("Sign in required", {
          description: "The playground only runs against the live API.",
        });
        return;
      }
    } finally {
      setBusy(false);
    }
    recordRun({ tool, repo, branch, scenario, aiSummary });
  };

  const onCopyOutput = async () => {
    const text = formatOutputForClipboard(tool, result);
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
        throw new Error("Clipboard API unavailable");
      }
      await navigator.clipboard.writeText(text);
      setCopied(true);
      const lines = text.split("\n").length;
      toast.success("Output copied", {
        description: `${lines} line${lines === 1 ? "" : "s"} copied. Paste into your terminal, PR thread, or notes.`,
      });
      setTimeout(() => setCopied(false), 1400);
    } catch (err) {
      toast.error("Copy failed", {
        description:
          err instanceof Error && err.message
            ? `${err.message}. Select the output and copy manually.`
            : "Select the output and copy manually.",
      });
    }
  };

  const onRerun = (entry: HistoryEntry) => {
    setTool(entry.tool);
    setRepo(entry.repo);
    setBranch(entry.branch);
    setScenario(entry.scenario);
    setAiSummary(entry.aiSummary);
    if (disabled) {
      toast.message("Inputs restored", {
        description: offline
          ? "You're offline — will re-run once you're back online."
          : `${describeApiStatus(status)} — will re-run once the API recovers.`,
        action: offline
          ? undefined
          : {
              label: "Recheck API",
              onClick: () => void pingHealth(true),
            },
      });
      return;
    }
    toast.success("Inputs restored", {
      description: "Press Run to execute with the saved values.",
    });
  };

  return (
    <StateBoundary
      isLoading={false}
      isEmpty={false}
      onRetry={() => void pingHealth(true)}
      onRefresh={() => void pingHealth(true)}
      loadingTitle="Loading playground…"
      emptyTitle="No tools available"
      emptyDescription="Once MCP/API tool metadata is available, the playground controls will appear here."
    >
      <div className="grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)_240px]">
        <div className="space-y-4 rounded-token border-hairline bg-card p-5">
          <div>
            <label className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
              Tool
            </label>
            <select
              value={tool}
              onChange={(e) => setTool(e.target.value as Tool)}
              className="mt-1 w-full rounded-token border-hairline bg-background/60 px-2 py-1.5 text-token-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              {TOOLS.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
              Repo
            </label>
            <input
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              className="mt-1 w-full rounded-token border-hairline bg-background/60 px-2 py-1.5 font-mono text-token-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            />
          </div>
          <div>
            <label className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
              Branch
            </label>
            <input
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              className="mt-1 w-full rounded-token border-hairline bg-background/60 px-2 py-1.5 font-mono text-token-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            />
          </div>
          {showPullNumber && (
            <div>
              <label className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                Pull number
              </label>
              <input
                inputMode="numeric"
                value={pullNumber}
                onChange={(e) => setPullNumber(e.target.value.replace(/\D/g, "") || "1")}
                className="mt-1 w-full rounded-token border-hairline bg-background/60 px-2 py-1.5 font-mono text-token-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              />
            </div>
          )}
          <Button
            type="button"
            className="w-full"
            onClick={onRun}
            disabled={disabled}
            aria-disabled={disabled}
            title={
              offline
                ? "Offline — reconnect to run"
                : apiBroken
                  ? `${describeApiStatus(status)} — wait for recovery`
                  : canUseLiveApi
                    ? "Run live API request"
                    : "Sign in to run"
            }
          >
            {offline ? (
              <span className="inline-flex items-center gap-1.5">
                <WifiOff className="size-3.5" /> Offline
              </span>
            ) : apiBroken ? (
              "Unavailable"
            ) : busy ? (
              "Running…"
            ) : (
              "Run"
            )}
          </Button>
          {disabled && (
            <p className="text-token-2xs text-muted-foreground">
              {offline
                ? "Browser reports offline. History stays local."
                : `${describeApiStatus(status)}. History stays local.`}
            </p>
          )}
          <div className="space-y-2 border-t-hairline pt-3">
            <label className="flex items-center justify-between gap-2 text-token-xs">
              <span className="inline-flex items-center gap-1.5 text-foreground/90">
                <Sparkles className="size-3.5 text-mint" />
                Include AI summary
              </span>
              <input
                type="checkbox"
                checked={aiSummary}
                onChange={(e) => setAiSummary(e.target.checked)}
                className="accent-mint"
              />
            </label>
            <p className="text-token-2xs text-muted-foreground">
              Summaries are derived strictly from the structured response. Never invents numbers.
            </p>
          </div>
        </div>

        <div className="rounded-token border-hairline bg-card p-5">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-token-lg font-semibold">Output</h2>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onCopyOutput}
                aria-label={copied ? "Output copied" : "Copy output"}
                className="inline-flex h-7 items-center gap-1.5 rounded-token border border-border bg-transparent px-2 text-token-xs text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground focus-ring motion-reduce:transition-none"
              >
                {copied ? <Check className="size-3.5 text-mint" /> : <Copy className="size-3.5" />}
                {copied ? "Copied" : "Copy"}
              </button>
              <StatusPill status={liveResult ? "ready" : canUseLiveApi ? "info" : "warn"}>
                {liveResult ? "live" : canUseLiveApi ? "ready" : "signed out"}
              </StatusPill>
            </div>
          </div>

          {showScenarios && (
            <div className="mt-4 flex flex-wrap gap-1.5">
              {SCENARIOS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setScenario(s.id)}
                  className={cn(
                    "rounded-full border-hairline px-2.5 py-0.5 font-mono text-token-2xs uppercase tracking-wider transition-colors",
                    scenario === s.id
                      ? "border-strong bg-mint/10 text-mint"
                      : "text-muted-foreground hover:text-foreground hover:border-strong",
                  )}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}

          <AnimatePresence initial={false}>
            {aiSummary && ai && (
              <motion.div
                key={`ai-${tool}`}
                initial={{ opacity: 0, height: 0, marginTop: 0 }}
                animate={{ opacity: 1, height: "auto", marginTop: 16 }}
                exit={{ opacity: 0, height: 0, marginTop: 0 }}
                transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                className="overflow-hidden"
              >
                <div className="rounded-token border-hairline bg-mint/[0.04] p-3">
                  <div className="mb-1 inline-flex items-center gap-1.5 font-mono text-token-2xs uppercase tracking-wider text-mint">
                    <Sparkles className="size-3" />
                    AI summary · derived
                  </div>
                  <p className="text-token-sm text-foreground/90">{ai.summary}</p>
                  <p className="mt-2 text-token-2xs text-muted-foreground">{ai.caveat}</p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence mode="wait">
            <motion.div
              key={`${tool}-${scenario}-${liveResult ? "live" : "preview"}`}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -2 }}
              transition={{ duration: 0.16, ease: "easeOut" }}
            >
              {tool === "public-safe-comment" ? (
                <div className="mt-4 rounded-token border-hairline bg-background/40 p-4 text-token-sm">
                  <div className="mb-2 font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                    gittensory · sticky comment
                  </div>
                  <pre className="whitespace-pre-wrap font-mono text-token-xs text-foreground/90">
                    {formatPublicPreview(result)}
                  </pre>
                </div>
              ) : (
                <pre className="mt-4 overflow-x-auto rounded-token border-hairline bg-background/60 p-3 font-mono text-token-xs text-foreground/90">
                  {JSON.stringify(result, null, 2)}
                </pre>
              )}
            </motion.div>
          </AnimatePresence>
        </div>

        <aside className="space-y-3 rounded-token border-hairline bg-card/40 p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="inline-flex items-center gap-1.5 font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
              <History className="size-3.5" />
              Run history
            </div>
            {history.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setHistory([]);
                  toast("History cleared", {
                    description: "Local playground history removed.",
                  });
                }}
                aria-label="Clear history"
                className="inline-flex h-6 items-center gap-1 rounded-token px-1.5 text-token-2xs text-muted-foreground transition-colors duration-150 hover:text-foreground focus-ring"
              >
                <Trash2 className="size-3" />
                Clear
              </button>
            )}
          </div>
          {disabled && (
            <div
              role="status"
              className="rounded-token border border-warning/30 bg-warning/[0.04] p-2 text-token-2xs text-foreground/80"
            >
              <div className="font-mono uppercase tracking-wider text-warning">
                {offline ? "Offline" : describeApiStatus(status)}
              </div>
              <p className="mt-1 text-muted-foreground">
                Re-run is paused until {offline ? "you reconnect" : "the API recovers"}. Inputs will
                load instantly.
              </p>
              {!offline && (
                <button
                  type="button"
                  onClick={() => void pingHealth(true)}
                  className="mt-1.5 inline-flex items-center gap-1 rounded-token border border-border bg-background/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-foreground transition-colors duration-150 hover:bg-accent focus-ring"
                >
                  <RefreshCw className="size-3" /> Recheck
                </button>
              )}
            </div>
          )}
          {history.length === 0 ? (
            <p className="text-token-xs text-muted-foreground">
              Runs save here automatically. Re-run any entry with the same inputs.
            </p>
          ) : (
            <ul className="space-y-2">
              {history.map((h) => (
                <li key={h.id}>
                  <HistoryRow
                    entry={h}
                    disabled={disabled}
                    disabledReason={
                      offline
                        ? "Offline — reconnect to re-run"
                        : apiBroken
                          ? `${describeApiStatus(status)} — wait for recovery`
                          : ""
                    }
                    onRerun={() => onRerun(h)}
                  />
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </StateBoundary>
  );
}

function HistoryRow({
  entry,
  disabled,
  disabledReason,
  onRerun,
}: {
  entry: HistoryEntry;
  disabled: boolean;
  disabledReason: string;
  onRerun: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onRerun}
      title={disabled ? disabledReason : "Re-run with saved inputs"}
      aria-label={`Re-run ${entry.tool} on ${entry.repo}${disabled ? ` — ${disabledReason}` : ""}`}
      className={cn(
        "group flex w-full flex-col gap-1 rounded-token border border-border bg-background/40 p-2 text-left transition-colors duration-150 focus-ring motion-reduce:transition-none",
        disabled ? "opacity-70 hover:border-warning/40" : "hover:border-foreground/30",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-token-xs font-medium text-foreground">{entry.tool}</span>
        {disabled ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-warning">
            <WifiOff className="size-2.5" /> paused
          </span>
        ) : (
          <RotateCw className="size-3 text-muted-foreground transition-colors group-hover:text-mint" />
        )}
      </div>
      <div className="truncate font-mono text-token-2xs text-muted-foreground">
        {entry.repo} · {entry.branch}
      </div>
      <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/80">
        {entry.scenario} · {timeAgo(entry.createdAt)}
      </div>
    </button>
  );
}

async function runLiveTool(args: {
  tool: Tool;
  repoFullName: string;
  branchName: string;
  scenario: Scenario;
  login: string;
  pullNumber?: number;
}) {
  const request = buildPlaygroundRequest({
    tool: args.tool,
    login: args.login,
    repoFullName: args.repoFullName,
    branchName: args.branchName,
    scenario: args.scenario,
    pullNumber: args.pullNumber,
  });
  const origin = getApiOrigin().replace(/\/$/, "");
  return apiFetch<unknown>(`${origin}${request.path}`, {
    method: request.method,
    label: `Playground ${args.tool}`,
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(request.body ? { "Content-Type": "application/json" } : {}),
    },
    body: request.body ? JSON.stringify(request.body) : undefined,
    timeoutMs: 20_000,
  });
}

function formatOutputForClipboard(tool: Tool, result: unknown): string {
  if (tool === "public-safe-comment") {
    return [
      "Thanks for the PR.",
      "",
      "This branch links to issue #1204 and passes basic preflight.",
      "Maintainers can run `@gittensory blockers` for non-public context.",
    ].join("\n");
  }
  const header = `// gittensory · ${tool} · preview`;
  const body = JSON.stringify(result, null, 2);
  // Normalize line endings and ensure trailing newline for terminal pastes.
  return `${header}\n${body}\n`.replace(/\r\n/g, "\n");
}

function summarizeResult(tool: Tool, result: unknown): { summary: string; caveat: string } {
  const size = JSON.stringify(result).length;
  return {
    summary: `${tool} is using the live API response currently shown below (${size} bytes).`,
    caveat: "This summary is derived only from the structured response in this panel.",
  };
}

function formatPublicPreview(result: unknown): string {
  const record =
    typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {};
  const preview =
    typeof record.preview === "object" && record.preview !== null
      ? (record.preview as Record<string, unknown>)
      : null;
  const body = preview && typeof preview.body === "string" ? preview.body : null;
  return body ?? JSON.stringify(result, null, 2);
}
