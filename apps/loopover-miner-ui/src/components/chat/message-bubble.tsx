import { Avatar, AvatarFallback, AvatarImage } from "@loopover/ui-kit/components/avatar";
import { GovernorChatActionResult } from "./governor-action-result";
import type { ChatMessage, ChatRole } from "./fixtures";

// Role-differentiated bubble backgrounds, built ONLY from existing @loopover/ui-kit theme tokens
// (packages/loopover-ui-kit/src/theme.css) — no new color literals: user = primary, assistant = muted
// surface, system = secondary.
const ROLE_BUBBLE_CLASS: Record<ChatRole, string> = {
  user: "bg-primary text-primary-foreground",
  assistant: "bg-muted text-foreground",
  system: "bg-secondary text-secondary-foreground",
};

function avatarInitials(message: ChatMessage): string {
  const source = (message.authorName ?? message.role).trim();
  return (source.slice(0, 2) || message.role.slice(0, 2)).toUpperCase();
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function MessageBubble({ message }: { message: ChatMessage }) {
  const bubbleClass = ROLE_BUBBLE_CLASS[message.role];
  const displayName = message.authorName ?? message.role;
  return (
    <div className="flex gap-3">
      <Avatar className="size-8 shrink-0">
        {message.avatarUrl ? <AvatarImage src={message.avatarUrl} alt={displayName} /> : null}
        <AvatarFallback>{avatarInitials(message)}</AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 flex-col gap-1">
        <div className={`whitespace-pre-wrap break-words rounded-token-sm px-3 py-2 text-token-sm ${bubbleClass}`}>
          {message.governorActionResult ? (
            // #8670: a resolved governor pause/resume turn renders through the dedicated result component
            // (same Ledgers-verbatim copy as `content`), not as an undifferentiated plain-text bubble.
            <GovernorChatActionResult pending={false} result={message.governorActionResult} />
          ) : (
            message.content
          )}
        </div>
        <time className="text-token-xs text-muted-foreground" dateTime={message.timestamp}>
          {formatTimestamp(message.timestamp)}
        </time>
      </div>
    </div>
  );
}
