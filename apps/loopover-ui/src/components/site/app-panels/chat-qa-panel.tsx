import { useEffect, useMemo, useState, type ReactNode } from "react";
import { MessageCircle, RefreshCw, Send } from "lucide-react";

import { StatusPill, type Status } from "@/components/site/control-primitives";
import { apiFetch } from "@/lib/api/request";
import { getApiOrigin } from "@/lib/api/origin";
import { splitReviewabilityPr } from "@/lib/maintainer-settings-preview";

/** Mirrors src/services/ai-chat-qa.ts's ChatQaResult, plus a route-local "rate_limited" state for the
 *  shared per-command invocation counter (#6489) -- generateChatQaAnswer itself is never modified. */
type ChatQaResult =
  | { status: "disabled"; reason: string }
  | { status: "unavailable"; reason: string }
  | { status: "declined"; reason: string; suggestion: string }
  | { status: "quota_exceeded"; model: string; estimatedNeurons: number; remainingBudget: number }
  | { status: "unsafe"; model: string; estimatedNeurons: number; reason: string }
  | { status: "error"; model: string; estimatedNeurons: number; reason: string }
  | { status: "ok"; model: string; estimatedNeurons: number; text: string }
  | { status: "rate_limited"; reason: string };

type ReviewabilityRow = { pr: string; title: string; chatQaEnabled: boolean };

/**
 * Maintainer dashboard panel for the existing `@loopover chat <question>` Q&A surface (#6489, per #6230's
 * scope decision). Read-only: calls POST /v1/repos/:owner/:repo/pulls/:number/chat-qa, which is a thin
 * wrapper around the unmodified generateChatQaAnswer service -- no new LLM-routing path, no write/action
 * capability. Renders nothing at all when no PR in view has advisoryAiRouting.chatQa enabled, rather than a
 * disabled-looking version of the panel.
 */
export function ChatQaPanel({ reviewability }: { reviewability: ReviewabilityRow[] }) {
  const eligible = useMemo(() => reviewability.filter((row) => row.chatQaEnabled), [reviewability]);
  const [selectedPr, setSelectedPr] = useState(eligible[0]?.pr ?? "");
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<ChatQaResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!selectedPr && eligible[0]) setSelectedPr(eligible[0].pr);
  }, [selectedPr, eligible]);

  if (eligible.length === 0) return null;

  async function ask() {
    const target = splitReviewabilityPr(selectedPr);
    if (!target) {
      setResult(null);
      setError("Select a pull request to ask about.");
      return;
    }
    const trimmed = question.trim();
    if (!trimmed) {
      setResult(null);
      setError("Enter a question.");
      return;
    }
    setBusy(true);
    setError(null);
    const response = await apiFetch<ChatQaResult>(
      `${getApiOrigin().replace(/\/$/, "")}/v1/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/pulls/${target.number}/chat-qa`,
      {
        method: "POST",
        label: "Chat Q&A",
        credentials: "include",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ question: trimmed }),
      },
    );
    setBusy(false);
    if (response.ok) {
      setResult(response.data);
      return;
    }
    setResult(null);
    setError(response.message);
  }

  return (
    <section className="rounded-token border-hairline bg-card p-5" aria-labelledby="chat-qa-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="chat-qa-title" className="font-display text-token-lg font-semibold">
            Chat Q&A
          </h2>
          <p className="mt-1 text-token-xs text-muted-foreground">
            Ask a grounded question about a PR&apos;s review/gate state — the same{" "}
            <code className="font-mono">@loopover chat</code> surface as the PR-comment command.
          </p>
        </div>
        <MessageCircle className="size-5 text-muted-foreground" aria-hidden />
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto]">
        <label className="block">
          <span className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
            Pull request
          </span>
          <select
            value={selectedPr}
            onChange={(event) => {
              setSelectedPr(event.target.value);
              setResult(null);
              setError(null);
            }}
            className="mt-1 min-h-10 w-full rounded-token border border-border bg-background/70 px-3 py-2 font-mono text-token-sm text-foreground outline-none transition-colors focus:border-mint"
          >
            {eligible.map((row) => (
              <option key={row.pr} value={row.pr}>
                {row.pr} — {row.title}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="mt-3 block">
        <span className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
          Question
        </span>
        <textarea
          value={question}
          onChange={(event) => {
            setQuestion(event.target.value);
            setResult(null);
            setError(null);
          }}
          rows={2}
          placeholder="Why is this PR blocked?"
          className="mt-1 w-full resize-y rounded-token border border-border bg-background/70 px-3 py-2 text-token-sm text-foreground outline-none transition-colors focus:border-mint"
        />
      </label>

      <div className="mt-3 flex items-center justify-between gap-3">
        <button
          type="button"
          disabled={busy || !selectedPr || question.trim().length === 0}
          onClick={() => void ask()}
          className="inline-flex items-center gap-2 rounded-token border border-mint/40 bg-mint px-3 py-2 text-token-xs font-medium text-primary-foreground transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? <RefreshCw className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
          {busy ? "Asking" : "Ask"}
        </button>
      </div>

      {error ? <p className="mt-3 text-token-xs text-warning">{error}</p> : null}
      {result ? <ChatQaResultView result={result} /> : null}
    </section>
  );
}

function ChatQaResultView({ result }: { result: ChatQaResult }) {
  switch (result.status) {
    case "ok":
      return (
        <div className="mt-4 rounded-token border-hairline bg-background/40 p-4">
          <div className="flex items-center justify-between gap-2">
            <StatusPill status="ready">answered</StatusPill>
            <span className="font-mono text-token-2xs text-muted-foreground">{result.model}</span>
          </div>
          <p className="mt-2 whitespace-pre-wrap text-token-sm text-foreground">{result.text}</p>
        </div>
      );
    case "declined":
      return (
        <ChatQaStatusNote status="info" title="Declined">
          {result.reason} Try{" "}
          <code className="font-mono">
            {result.suggestion.match(/`([^`]+)`/)?.[1] ?? result.suggestion}
          </code>
          .
        </ChatQaStatusNote>
      );
    case "disabled":
      return (
        <ChatQaStatusNote status="info" title="Not enabled">
          {result.reason}
        </ChatQaStatusNote>
      );
    case "unavailable":
      return (
        <ChatQaStatusNote status="info" title="Unavailable">
          {result.reason}
        </ChatQaStatusNote>
      );
    case "quota_exceeded":
      return (
        <ChatQaStatusNote status="warn" title="Daily AI budget reached">
          Remaining budget: {result.remainingBudget} neurons ({result.model}).
        </ChatQaStatusNote>
      );
    case "rate_limited":
      return (
        <ChatQaStatusNote status="warn" title="Rate limited">
          {result.reason}
        </ChatQaStatusNote>
      );
    case "unsafe":
      return (
        <ChatQaStatusNote status="blocked" title="Answer withheld">
          The generated answer did not pass the public-safety filter and was withheld (
          {result.model}).
        </ChatQaStatusNote>
      );
    case "error":
      return (
        <ChatQaStatusNote status="blocked" title="Answer failed">
          {result.reason} ({result.model})
        </ChatQaStatusNote>
      );
  }
}

function ChatQaStatusNote({
  status,
  title,
  children,
}: {
  status: Status;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="mt-4 rounded-token border-hairline bg-background/40 p-4">
      <div className="flex items-center gap-2">
        <StatusPill status={status}>{title}</StatusPill>
      </div>
      <p className="mt-2 text-token-sm text-muted-foreground">{children}</p>
    </div>
  );
}
