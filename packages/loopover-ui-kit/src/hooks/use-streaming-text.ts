import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A source of text chunks. A factory (invoked once per stream start) returning an `AsyncIterable<string>`,
 * so a caller can hand a fresh async generator or a `ReadableStream` wrapper each time — the hook never
 * re-consumes an already-drained iterator. Exported by name so a later composer/message-list issue can type
 * its streaming prop against it.
 */
export type ChunkSource = () => AsyncIterable<string>;

export type StreamingStatus =
  "idle" | "streaming" | "done" | "error" | "cancelled";

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
export function useStreamingText(
  source: ChunkSource | null,
): StreamingTextState {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<StreamingStatus>("idle");
  const [error, setError] = useState<Error | null>(null);
  // Points at the CURRENT effect's canceller so cancel() always targets the live stream, never a stale one.
  const cancelRef = useRef<() => void>(() => {});

  useEffect(() => {
    // Per-effect flag (a fresh closure each run): the cleanup below flips it on a new source or unmount, so the
    // previous run's worker stops and writes no more state. cancel() flips this same flag for an explicit stop.
    let cancelled = false;
    cancelRef.current = () => {
      if (!cancelled) {
        cancelled = true;
        setStatus("cancelled");
      }
    };

    // ALL state writes live inside this async worker rather than the effect body — the reset + "streaming"
    // transition, incremental accumulation, and terminal done/error transitions — so none is a synchronous
    // setState-in-effect (react-hooks/set-state-in-effect). Each is guarded by `cancelled` so a write never
    // lands after a new source starts, after cancel(), or after unmount.
    void (async () => {
      if (cancelled) return;
      setText("");
      setError(null);
      if (!source) {
        setStatus("idle");
        return;
      }
      setStatus("streaming");
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
