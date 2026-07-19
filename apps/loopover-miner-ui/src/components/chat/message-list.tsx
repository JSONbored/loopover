import { useRef, type ReactNode } from "react";

import { ScrollArea } from "@loopover/ui-kit/components/scroll-area";
import { StateBoundary } from "@loopover/ui-kit/components/state-views";
import { MessageBubble } from "./message-bubble";
import { TypingIndicator } from "./typing-indicator";
import type { ChatMessage } from "./fixtures";
import { useStickToBottom } from "@/lib/use-stick-to-bottom";

// The scrollable message list for the chat rail (#6515). Backend-agnostic: it renders whatever message
// array it's given, wrapping the content in ui-kit's StateBoundary for its own loading/empty/error states
// and using ui-kit's ScrollArea (not a raw overflow div) for the viewport. The composing flag surfaces the
// TypingIndicator below the list regardless of the message-array state.
//
// #7229: the ScrollArea auto-follows its newest content (a committed message, or the live streaming answer
// passed in via `footer`) via useStickToBottom, so a growing conversation stays in view without a manual
// scroll — unless the operator has scrolled up, in which case their position is left alone. `footer` renders
// inside the same scrollable viewport (but outside the #7081 aria-live `<ol>`) so the streaming render grows
// the viewport the same way a committed message does, and the one follow mechanism covers both.
export function MessageList({
  messages,
  isLoading = false,
  isError = false,
  composing = false,
  footer,
}: {
  messages: ChatMessage[];
  isLoading?: boolean;
  isError?: boolean;
  composing?: boolean;
  footer?: ReactNode;
}) {
  const scrollRootRef = useRef<HTMLDivElement>(null);
  useStickToBottom(scrollRootRef);
  return (
    <ScrollArea ref={scrollRootRef} className="h-full">
      <StateBoundary
        isLoading={isLoading}
        isError={isError}
        isEmpty={messages.length === 0}
        loadingTitle="Loading conversation…"
        emptyTitle="No messages yet"
        emptyDescription="Start the conversation to see messages here."
        errorTitle="Couldn't load the conversation"
        errorDescription="The conversation source did not respond. Retry, or check back once it has recovered."
      >
        {/*
          #7081: the message list is a polite ARIA live region so assistive tech announces each completed turn
          even when the user has moved focus out of the list. `messages` gains a committed entry exactly once per
          turn — conversation.tsx appends the finished answer only after StreamingText's per-chunk accumulation
          resolves, never mid-stream, and the live StreamingText render lives OUTSIDE this `<ol>` (it comes in via
          `footer`, below) — so each new message announces once, never once-per-streaming-chunk. `aria-relevant="additions"` keeps it to newly
          appended messages; StateBoundary's own loading/empty/error status/alert regions are separate and
          untouched (an added message can't reach here in those branches anyway).
        */}
        <ol className="flex flex-col gap-4 p-3" aria-live="polite" aria-relevant="additions">
          {messages.map((message) => (
            <li key={message.id}>
              <MessageBubble message={message} />
            </li>
          ))}
        </ol>
      </StateBoundary>
      {composing ? <TypingIndicator composing authorName="Assistant" /> : null}
      {footer}
    </ScrollArea>
  );
}
