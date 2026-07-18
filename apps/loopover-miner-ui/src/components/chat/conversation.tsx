import { useCallback, useRef, useState } from "react";

import { Avatar, AvatarFallback } from "@loopover/ui-kit/components/avatar";

import { ChatComposer } from "@/components/chat-composer";
import { StreamingText } from "@/components/streaming-text";
import { MessageList } from "@/components/chat/message-list";
import type { ChatMessage } from "@/components/chat/fixtures";
import type { ChunkSource } from "@/lib/use-streaming-text";
import { streamChat, type ChatWireMessage } from "@/lib/chat-stream";

// The chat-rail's content integration (#6518): the first point the persistent rail (#6513) holds a live
// conversation. Pure wiring — it composes the standalone composer (#6514), message list (#6515), and streaming
// renderer (#6516) around the read-only streaming backend (#6517), and owns nothing but the conversation state.
// Strictly ask-a-question / read-only: the only network call it can make is `streamChat` → `POST /api/chat`; it
// never touches an action endpoint (portfolio release/requeue, governor pause/resume) — that surface is a
// separate, later, flag-gated issue.

const ASSISTANT_NAME = "LoopOver";

/** Injectable so tests can drive the stream deterministically; defaults to the real `POST /api/chat` bridge. */
export type StreamChatFn = (messages: ChatWireMessage[]) => AsyncIterable<string>;

export function ChatConversation({ streamChatImpl = streamChat }: { streamChatImpl?: StreamChatFn } = {}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeSource, setActiveSource] = useState<ChunkSource | null>(null);
  const [streaming, setStreaming] = useState(false);
  // #7078: true from submit until the first SSE text chunk — drives MessageList's TypingIndicator so the
  // pre-first-token round-trip isn't a silent gap. Cleared on first chunk, stream completion, or error.
  const [awaitingFirstChunk, setAwaitingFirstChunk] = useState(false);
  const [errored, setErrored] = useState(false);
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
      // What the backend grounds against: the prior user/assistant turns plus this question, in wire shape.
      const history: ChatWireMessage[] = [...messages, userMessage]
        .filter((message): message is ChatMessage & { role: "user" | "assistant" } => message.role !== "system")
        .map((message) => ({ role: message.role, content: message.content }));

      setMessages((prev) => [...prev, userMessage]);
      setErrored(false);
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
            setErrored(true);
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
    [messages, streamChatImpl],
  );

  return (
    <div className="flex h-full flex-col gap-2 p-4">
      <p className="font-mono text-token-xs uppercase tracking-[0.2em] text-primary">Chat</p>
      <div className="min-h-0 flex-1 overflow-hidden">
        <MessageList messages={messages} isError={errored} composing={streaming && awaitingFirstChunk} />
        {streaming && activeSource ? (
          <div className="flex gap-3 px-3 pt-4" data-testid="chat-streaming-response">
            <Avatar className="size-8 shrink-0">
              <AvatarFallback>{ASSISTANT_NAME.slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
            <StreamingText
              source={activeSource}
              className="min-w-0 whitespace-pre-wrap break-words rounded-token-sm bg-muted px-3 py-2 text-token-sm text-foreground"
            />
          </div>
        ) : null}
      </div>
      <ChatComposer onSubmit={handleSubmit} disabled={streaming} />
    </div>
  );
}
