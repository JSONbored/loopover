import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A chunked text source: a factory that returns a fresh `AsyncIterable<string>` each time streaming starts
 * (#6516). A factory — rather than a bare iterable — so restarting (a new source supplied, or the same one
 * re-run) always consumes from the beginning rather than a half-drained iterator. A composer/message-list
 * issue can type its real backend adapter against this exported name.
 */
export type ChunkSource = () => AsyncIterable<string>;

/** Lifecycle of a single stream. `idle` = no source yet; terminal states are `done`/`error`/`cancelled`. */
export type StreamStatus = "idle" | "streaming" | "done" | "error" | "cancelled";

export interface StreamingTextState {
  /** The text accumulated from every chunk seen so far. */
  text: string;
  status: StreamStatus;
  /** The error a source threw/rejected with mid-stream; null unless `status === "error"`. */
  error: unknown;
  /** Stop consuming the in-flight source; transitions `streaming` → `cancelled` (a no-op once terminal). */
  cancel: () => void;
}

/**
 * Reveal a chat response's text progressively as chunks arrive, instead of popping the whole message in at
 * once. Consuming the source starts when a non-null `source` is supplied and restarts whenever the `source`
 * reference changes — so, like `usePolledFetch`, the caller must pass a STABLE/memoized source, or each render
 * would restart the stream.
 *
 * Cancellation discipline mirrors `usePolledFetch`'s `cancelled`-flag pattern exactly: supplying a new source
 * (or unmounting) stops consumption of the previous source, and no chunk arriving from it after that point may
 * reach returned state. A source that throws or rejects mid-stream surfaces through `status`/`error` rather
 * than as an unhandled rejection, and is never silently swallowed.
 */
export function useStreamingText(source: ChunkSource | null): StreamingTextState {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<StreamStatus>("idle");
  const [error, setError] = useState<unknown>(null);
  // Points at the ACTIVE run's canceller so the stable `cancel()` below always stops the current stream.
  const cancelRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!source) return;

    let cancelled = false;
    cancelRef.current = () => {
      cancelled = true;
    };

    // Fresh stream: reset accumulation/error and enter the streaming state.
    setText("");
    setError(null);
    setStatus("streaming");

    void (async () => {
      try {
        for await (const chunk of source()) {
          if (cancelled) return; // a late chunk after cancel/unmount/source-swap must not touch state
          setText((prev) => prev + chunk);
        }
        if (cancelled) return;
        setStatus("done");
      } catch (err) {
        if (cancelled) return;
        setError(err);
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [source]);

  const cancel = useCallback(() => {
    cancelRef.current();
    // Only a running stream is cancellable; leave done/error/idle untouched.
    setStatus((prev) => (prev === "streaming" ? "cancelled" : prev));
  }, []);

  return { text, status, error, cancel };
}
