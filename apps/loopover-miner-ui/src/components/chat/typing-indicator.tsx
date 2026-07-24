// A composing / "typing" affordance for the chat (#6515) — deliberately distinct from @loopover/ui-kit's
// Spinner, which only signals whole-panel LOADING. This is an animated three-dot pulse with a typing-specific
// accessible name, so assistive tech hears "…is typing", not "loading".
export function TypingIndicator({
  composing = true,
  authorName,
}: {
  /** When false, renders nothing — the other side isn't composing. */
  composing?: boolean;
  authorName?: string;
}) {
  if (!composing) return null;
  const label = `${authorName ?? "Assistant"} is typing…`;
  return (
    <div role="status" aria-live="polite" aria-label={label} className="flex items-center gap-1.5 px-3 py-2">
      <span className="sr-only">{label}</span>
      <span
        aria-hidden="true"
        className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.3s] motion-reduce:animate-none"
      />
      <span
        aria-hidden="true"
        className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.15s] motion-reduce:animate-none"
      />
      <span
        aria-hidden="true"
        className="size-1.5 animate-bounce rounded-full bg-muted-foreground motion-reduce:animate-none"
      />
    </div>
  );
}
