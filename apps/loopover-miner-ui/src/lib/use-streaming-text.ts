import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A source of text chunks. A factory (invoked once per stream start) returning an `AsyncIterable<string>`,
 * so a caller can hand a fresh async generator or a `ReadableStream` wrapper each time — the hook never
 * re-consumes an already-drained iterator. Exported by name so a later composer/message-list issue can type
 * its streaming prop against it.
 */
export type ChunkSource = () => AsyncIterable<string>;

export type StreamingStatus = "idle" | "streaming" | "done" | "error" | "cancelled";

export interface StreamingTextState {
  /** Text accumulated from all chunks consumed so far. */
  text: string;
  status: StreamingStatus;
  error: Error | null;
  /** Stop consuming the current source; no later chunk from it reaches state. Idempotent, safe post-unmount. */
  cancel: () => void;
}

/**
 * Consume a chunked text source progressively (#6516): accumulate each chunk into `text` as it arrives and
 * expose an idle/streaming/done/error/cancelled status. Mirrors `usePolledFetch`'s cancelled-flag discipline —
 * a chunk resolving after a new source starts, after `cancel()`, or after unmount never touches state. This is
 * an unwired primitive: it only ever consumes the source it's handed (a mock in tests, a real stream later).
 */
export function useStreamingText(source: ChunkSource | null): StreamingTextState {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<StreamingStatus>("idle");
  const [error, setError] = useState<Error | null>(null);
  // Points at the CURRENT effect's canceller so cancel() always targets the live stream, never a stale one.
  const cancelRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!source) {
      setStatus("idle");
      return;
    }
    // Per-effect flag (a fresh closure each run): the cleanup below flips it on a new source or unmount, so the
    // previous run's loop stops and writes no more state. cancel() flips this same flag for an explicit stop.
    let cancelled = false;
    setText("");
    setError(null);
    setStatus("streaming");
    cancelRef.current = () => {
      if (!cancelled) {
        cancelled = true;
        setStatus("cancelled");
      }
    };

    void (async () => {
      try {
        for await (const chunk of source()) {
          if (cancelled) return;
          setText((prev) => prev + chunk);
        }
        if (!cancelled) setStatus("done");
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setStatus("error");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [source]);

  const cancel = useCallback(() => cancelRef.current(), []);
  return { text, status, error, cancel };
}
