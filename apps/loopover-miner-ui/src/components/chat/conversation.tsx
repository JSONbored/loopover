import { useCallback, useRef, useState } from "react";

import { Avatar, AvatarFallback } from "@loopover/ui-kit/components/avatar";

import { ChatComposer } from "@/components/chat-composer";
import { StreamingText } from "@loopover/ui-kit/components/streaming-text";
import { MessageList } from "@/components/chat/message-list";
import type { ChatMessage } from "@/components/chat/fixtures";
import type { ChunkSource } from "@loopover/ui-kit/hooks/use-streaming-text";
import { streamChat, type ChatWireMessage } from "@/lib/chat-stream";
import {
  handlePortfolioQueueChatCommand,
  resolvePortfolioQueueChatAction,
  type HandlePortfolioQueueChatCommandDeps,
  type HandlePortfolioQueueChatCommandResult,
} from "@/lib/chat-portfolio-queue-actions";
import { fetchPortfolioQueueItems } from "@/lib/portfolio-queue-actions";
import {
  enabledChatActionsEnv,
  registerGovernorChatActions,
  runGovernorChatAction,
  unwrapGovernorPauseChatResult,
  type RegisterGovernorChatActionsOptions,
} from "@/lib/chat-governor-actions";
import { formatGovernorPauseChatMessage } from "@/lib/chat-governor-action-copy";
import { resolveGovernorChatAction } from "@/lib/chat-governor-resolve";
import { GovernorChatActionResult } from "@/components/chat/governor-action-result";

// The chat-rail's content integration (#6518): the first point the persistent rail (#6513) holds a live
// conversation. Pure wiring — it composes the standalone composer (#6514), message list (#6515), and streaming
// renderer (#6516) around the read-only streaming backend (#6517), and owns nothing but the conversation state.
//
// #7075: portfolio release/requeue is resolved first via resolvePortfolioQueueChatAction; only unresolved
// text falls through to streamChat. Action dispatch reuses the already-built handlePortfolioQueueChatCommand
// pipeline (no new routes / fetches).
//
// #8670: governor pause/resume is resolved the same way via resolveGovernorChatAction; a matched intent
// dispatches through the already-built runGovernorChatAction wire (registry + flag + gate — no new routes /
// fetches) and renders GovernorChatActionResult in the message stream, so the chat rail finally reaches the
// same pauseGovernor/resumeGovernor clients the Ledgers buttons call.

const ASSISTANT_NAME = "LoopOver";
/** Inline failure note appended after a failed turn — keeps history visible instead of StateBoundary wipe (#7077). */
const TURN_FAILED_MESSAGE =
  "The latest response failed to complete. Any partial answer above is incomplete — you can try again.";

/** Local queue administration is not a chokepoint content-write (#6838 / #7075); satisfy the registry brand. */
const allowAdministrativeGate = () => ({ decision: { stage: "allow" } });

/** Injectable so tests can drive the stream deterministically; defaults to the real `POST /api/chat` bridge. */
export type StreamChatFn = (messages: ChatWireMessage[]) => AsyncIterable<string>;

export type PortfolioQueueChatCommandFn = (
  text: string,
  deps: HandlePortfolioQueueChatCommandDeps,
) => Promise<HandlePortfolioQueueChatCommandResult>;

/** Injectable so tests can observe the dispatch; defaults to the real flag-gated `runGovernorChatAction`. */
export type RunGovernorChatActionFn = typeof runGovernorChatAction;

export type ChatConversationProps = {
  streamChatImpl?: StreamChatFn;
  /** Defaults to the real end-to-end portfolio release/requeue handler (#7075). */
  handlePortfolioQueueChatCommandImpl?: PortfolioQueueChatCommandFn;
  /** Partial override of production portfolio-command deps (tests inject loadItems / gates / env). */
  portfolioQueueChatDeps?: Partial<HandlePortfolioQueueChatCommandDeps>;
  /** Defaults to the real flag-gated governor dispatch wire (#8670). */
  runGovernorChatActionImpl?: RunGovernorChatActionFn;
  /** Override of production governor registration deps (tests inject registry / pause / resume fns). */
  governorChatDeps?: RegisterGovernorChatActionsOptions;
};

function defaultPortfolioQueueChatDeps(
  overrides: Partial<HandlePortfolioQueueChatCommandDeps> = {},
): HandlePortfolioQueueChatCommandDeps {
  return {
    loadItems: () => fetchPortfolioQueueItems(),
    buildGovernorInput: () => ({}),
    evaluateGate: allowAdministrativeGate,
    ...overrides,
  };
}

export function ChatConversation({
  streamChatImpl = streamChat,
  handlePortfolioQueueChatCommandImpl = handlePortfolioQueueChatCommand,
  portfolioQueueChatDeps,
  runGovernorChatActionImpl = runGovernorChatAction,
  governorChatDeps,
}: ChatConversationProps = {}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeSource, setActiveSource] = useState<ChunkSource | null>(null);
  const [streaming, setStreaming] = useState(false);
  // #8670: true for the duration of a governor pause/resume round-trip — drives the pending copy of
  // GovernorChatActionResult below the list (the chat twin of LedgersPage's `actionPending`).
  const [governorActionPending, setGovernorActionPending] = useState(false);
  // #7078: true from submit until the first SSE text chunk — drives MessageList's TypingIndicator so the
  // pre-first-token round-trip isn't a silent gap. Cleared on first chunk, stream completion, or error.
  const [awaitingFirstChunk, setAwaitingFirstChunk] = useState(false);
  const idCounter = useRef(0);
  const nextId = () => `m${(idCounter.current += 1)}`;

  const handleSubmit = useCallback(
    (text: string) => {
      const userMessage: ChatMessage = {
        id: nextId(),
        role: "user",
        content: text,
        timestamp: new Date().toISOString(),
      };

      // #7075: try portfolio release/requeue resolution BEFORE opening a read-only stream.
      const portfolioResolved = resolvePortfolioQueueChatAction(text);
      if (portfolioResolved.ok) {
        setMessages((prev) => [...prev, userMessage]);
        // Reuse the composer-disable flag for the action round-trip (no streaming source / typing indicator).
        setStreaming(true);
        void (async () => {
          try {
            const result = await handlePortfolioQueueChatCommandImpl(
              text,
              defaultPortfolioQueueChatDeps(portfolioQueueChatDeps),
            );
            setMessages((prev) => [...prev, ...result.messages]);
          } catch {
            setMessages((prev) => [
              ...prev,
              {
                id: nextId(),
                role: "system",
                content: TURN_FAILED_MESSAGE,
                timestamp: new Date().toISOString(),
              },
            ]);
          } finally {
            setStreaming(false);
          }
        })();
        return;
      }

      // #8670: try governor pause/resume resolution next — BEFORE opening a read-only stream, so
      // governor-intent text actually reaches runGovernorChatAction instead of the generic assistant.
      const governorResolved = resolveGovernorChatAction(text);
      if (governorResolved.ok) {
        setMessages((prev) => [...prev, userMessage]);
        // Reuse the composer-disable flag for the action round-trip (no streaming source / typing indicator).
        setStreaming(true);
        void (async () => {
          const stamp = () => new Date().toISOString();
          try {
            // Same idempotent registration the Vite dev-server entry performs — safe to repeat per dispatch,
            // and the only path that works when the rail renders before (or without) that entry point.
            registerGovernorChatActions(governorChatDeps ?? {});
            const dispatch = await runGovernorChatActionImpl(
              {
                action: governorResolved.action,
                ...(governorResolved.params ? { params: governorResolved.params } : {}),
              },
              {
                env: enabledChatActionsEnv(),
                ...(governorChatDeps?.registry ? { registry: governorChatDeps.registry } : {}),
                onPending: setGovernorActionPending,
              },
            );
            const result = unwrapGovernorPauseChatResult(dispatch);
            setMessages((prev) => [
              ...prev,
              result
                ? {
                    id: nextId(),
                    role: "system",
                    content: formatGovernorPauseChatMessage(result),
                    timestamp: stamp(),
                    governorActionResult: result,
                  }
                : {
                    id: nextId(),
                    role: "system",
                    content: `Couldn't run the governor action: ${dispatch.status}.`,
                    timestamp: stamp(),
                  },
            ]);
          } catch {
            setMessages((prev) => [
              ...prev,
              { id: nextId(), role: "system", content: TURN_FAILED_MESSAGE, timestamp: stamp() },
            ]);
          } finally {
            setStreaming(false);
          }
        })();
        return;
      }

      // What the backend grounds against: the prior user/assistant turns plus this question, in wire shape.
      const history: ChatWireMessage[] = [...messages, userMessage]
        .filter((message): message is ChatMessage & { role: "user" | "assistant" } => message.role !== "system")
        .map((message) => ({ role: message.role, content: message.content }));

      setMessages((prev) => [...prev, userMessage]);
      setAwaitingFirstChunk(true);
      setStreaming(true);

      // This source both feeds the live StreamingText render AND, on natural completion, commits the finished
      // answer into the message list. Every state write below runs in the generator's async continuation (driven
      // by useStreamingText inside StreamingText), never synchronously in an effect body — so it stays clear of
      // react-hooks/set-state-in-effect. The composer is disabled for the whole in-flight window, so a second
      // request can't start before this one resolves and clears `streaming`.
      const source: ChunkSource = () =>
        (async function* () {
          let answer = "";
          let sawFirstChunk = false;
          try {
            for await (const delta of streamChatImpl(history)) {
              if (!sawFirstChunk) {
                sawFirstChunk = true;
                // Drop the typing indicator before StreamingText paints real content — they must not overlap.
                setAwaitingFirstChunk(false);
              }
              answer += delta;
              yield delta;
            }
            setMessages((prev) => [
              ...prev,
              {
                id: nextId(),
                role: "assistant",
                content: answer,
                timestamp: new Date().toISOString(),
                authorName: ASSISTANT_NAME,
              },
            ]);
          } catch {
            // #7077: never gate MessageList on isError (that replaces the whole history via StateBoundary).
            // Commit any partial streamed text, then append an inline system failure note so prior turns stay.
            const failedAt = new Date().toISOString();
            setMessages((prev) => {
              const next = [...prev];
              if (answer.length > 0) {
                next.push({
                  id: nextId(),
                  role: "assistant",
                  content: answer,
                  timestamp: failedAt,
                  authorName: ASSISTANT_NAME,
                });
              }
              next.push({
                id: nextId(),
                role: "system",
                content: TURN_FAILED_MESSAGE,
                timestamp: failedAt,
              });
              return next;
            });
          } finally {
            setAwaitingFirstChunk(false);
            setStreaming(false);
            setActiveSource(null);
          }
        })();

      // `source` is itself a function, so it must be stored via an updater — a bare `setActiveSource(source)`
      // would be read as a functional update and *call* it instead of storing it.
      setActiveSource(() => source);
    },
    [
      messages,
      streamChatImpl,
      handlePortfolioQueueChatCommandImpl,
      portfolioQueueChatDeps,
      runGovernorChatActionImpl,
      governorChatDeps,
    ],
  );

  return (
    <div className="flex h-full flex-col gap-2 p-4">
      <p className="font-mono text-token-xs uppercase tracking-[0.2em] text-primary">Chat</p>
      <div className="min-h-0 flex-1 overflow-hidden">
        <MessageList
          messages={messages}
          composing={streaming && awaitingFirstChunk}
          footer={
            governorActionPending ? (
              // #8670: pending copy for an in-flight pause/resume, in the same viewport slot the live
              // streaming render uses — GovernorChatActionResult owns the role="status" announcement.
              <div className="px-3 pt-4" data-testid="chat-governor-pending">
                <GovernorChatActionResult pending result={null} />
              </div>
            ) : streaming && activeSource ? (
              <div className="flex gap-3 px-3 pt-4" data-testid="chat-streaming-response">
                <Avatar className="size-8 shrink-0">
                  <AvatarFallback>{ASSISTANT_NAME.slice(0, 2).toUpperCase()}</AvatarFallback>
                </Avatar>
                <StreamingText
                  source={activeSource}
                  className="min-w-0 whitespace-pre-wrap break-words rounded-token-sm bg-muted px-3 py-2 text-token-sm text-foreground"
                />
              </div>
            ) : null
          }
        />
      </div>
      <ChatComposer onSubmit={handleSubmit} disabled={streaming} />
    </div>
  );
}
