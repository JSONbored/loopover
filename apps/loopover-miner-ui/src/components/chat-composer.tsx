import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { Button } from "@loopover/ui-kit/components/button";
import { Textarea } from "@loopover/ui-kit/components/textarea";

/** Tallest the textarea grows before it stops and scrolls internally instead (#6514). Roughly six lines at the
 *  primitive's own type scale — enough to read a pasted multi-line question back without the composer eating
 *  the rail it lives in. */
const MAX_COMPOSER_HEIGHT_PX = 160;

/**
 * Message input for the miner dashboard's chat rail (#6514). The ui-kit's `Textarea`/`Button` are deliberately
 * behavior-less primitives, so the submit-on-Enter, Shift+Enter-newline, and auto-grow logic lives here rather
 * than being pushed down into that package.
 *
 * Self-contained by design: it owns its own draft state and never calls an API, MCP tool, or action endpoint —
 * the caller gets the finished message through `onSubmit` and decides what to do with it. That is what lets it
 * ship unwired, ahead of the rail that will eventually mount it.
 */
export function ChatComposer({
  onSubmit,
  placeholder = "Ask about this miner…",
  disabled = false,
}: {
  onSubmit: (message: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Re-measure on every value change, not just on keystrokes: a paste, a programmatic clear, and the reset
  // after submit all have to settle the height too. useLayoutEffect so the browser paints the grown box in the
  // same frame as the text -- with useEffect the caret can visibly outrun the box for a frame on a fast paste.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    // Collapse first, then measure: scrollHeight only shrinks back if the element isn't already holding the
    // taller inline height from the previous keystroke, so deleting a line would otherwise never shrink it.
    textarea.style.height = "auto";
    const next = Math.min(textarea.scrollHeight, MAX_COMPOSER_HEIGHT_PX);
    textarea.style.height = `${next}px`;
    // At the cap the content is taller than the box, so hand scrolling back to the textarea; below it, keep
    // the overflow hidden so no scrollbar flickers in while the box is still growing.
    textarea.style.overflowY = textarea.scrollHeight > MAX_COMPOSER_HEIGHT_PX ? "auto" : "hidden";
  }, [value]);

  /** Emit the trimmed draft and clear, or do nothing when there is nothing real to send. Shared by the Enter
   *  path and the button so the two can never disagree about what counts as empty. */
  const submit = useCallback(() => {
    const message = value.trim();
    if (!message) return;
    onSubmit(message);
    setValue("");
  }, [onSubmit, value]);

  return (
    <div className="flex items-end gap-2">
      <Textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          // Shift+Enter is the newline escape hatch, so only a bare Enter submits. The other modifiers are
          // checked too: Ctrl/Cmd/Alt+Enter is a submit chord in plenty of chat UIs, and silently treating it
          // as a plain Enter here would send a half-written message.
          if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
          event.preventDefault(); // otherwise the newline lands in the box we're about to clear
          submit();
        }}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
        className="max-h-[160px] resize-none"
      />
      <Button type="button" onClick={submit} disabled={disabled} size="sm">
        Send
      </Button>
    </div>
  );
}
