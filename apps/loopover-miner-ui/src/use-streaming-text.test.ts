import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useStreamingText, type StreamingTextSource } from "./lib/use-streaming-text";

/** A chunk source we drive by hand: each `push` releases exactly one chunk, so a test can park a stream
 *  mid-flight and then act (restart, unmount) before letting the next chunk land. */
function controllableSource() {
  let release: (() => void) | null = null;
  const gate = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });

  const chunks: string[] = [];
  const source: StreamingTextSource = async function* () {
    for (const chunk of chunks) {
      await gate();
      yield chunk;
    }
  };

  return {
    source,
    queue(...next: string[]) {
      chunks.push(...next);
    },
    /** Let the parked chunk through and flush the microtasks its yield schedules. */
    async push() {
      await act(async () => {
        release?.();
        await Promise.resolve();
      });
    },
  };
}

/** A source that yields one chunk, then throws. */
const throwingSource: StreamingTextSource = async function* () {
  yield "partial";
  throw new Error("stream died");
};

describe("useStreamingText (#6516)", () => {
  it("starts idle with no text when given no source", () => {
    const { result } = renderHook(() => useStreamingText(null));
    expect(result.current.status).toBe("idle");
    expect(result.current.text).toBe("");
    expect(result.current.error).toBeNull();
  });

  it("accumulates progressively across renders, not only at the end", async () => {
    const controller = controllableSource();
    controller.queue("Hello", " ", "world");
    const { result } = renderHook(() => useStreamingText(controller.source));

    await waitFor(() => expect(result.current.status).toBe("streaming"));
    expect(result.current.text).toBe("");

    await controller.push();
    // The point of the hook: text is readable mid-stream, before the source is exhausted.
    await waitFor(() => expect(result.current.text).toBe("Hello"));
    expect(result.current.status).toBe("streaming");

    await controller.push();
    await waitFor(() => expect(result.current.text).toBe("Hello "));

    await controller.push();
    await waitFor(() => expect(result.current.text).toBe("Hello world"));
    await waitFor(() => expect(result.current.status).toBe("done"));
  });

  it("REGRESSION: a late chunk from a superseded source never reaches state", async () => {
    const first = controllableSource();
    first.queue("from-first");
    const second = controllableSource();
    second.queue("from-second");

    const { result, rerender } = renderHook(({ source }) => useStreamingText(source), {
      initialProps: { source: first.source },
    });
    await waitFor(() => expect(result.current.status).toBe("streaming"));

    // Swap sources while the first is still parked on its chunk.
    rerender({ source: second.source });
    await waitFor(() => expect(result.current.text).toBe(""));

    // Now let the FIRST source's chunk land. It must be dropped -- appending it would corrupt the new reply.
    await first.push();
    await second.push();
    await waitFor(() => expect(result.current.text).toBe("from-second"));
    expect(result.current.text).not.toContain("from-first");
  });

  it("REGRESSION: unmounting mid-stream neither throws nor updates retained state", async () => {
    const controller = controllableSource();
    controller.queue("late");
    const { result, unmount } = renderHook(() => useStreamingText(controller.source));
    await waitFor(() => expect(result.current.status).toBe("streaming"));

    unmount();
    // Releasing the pending chunk after unmount must be a no-op, not a state update on a dead component.
    await expect(controller.push()).resolves.toBeUndefined();
    expect(result.current.text).toBe("");
  });

  it("surfaces a mid-stream error through status/error instead of an unhandled rejection", async () => {
    const { result } = renderHook(() => useStreamingText(throwingSource));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toBe("stream died");
    // The chunks that did arrive before the failure are kept -- a partial answer beats a blank box.
    expect(result.current.text).toBe("partial");
  });

  it("reports a non-Error thrown value as a string rather than losing it", async () => {
    const rejecting: StreamingTextSource = async function* () {
      yield "x";
      throw "plain string failure";
    };
    const { result } = renderHook(() => useStreamingText(rejecting));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toBe("plain string failure");
  });

  it("cancel() stops the stream and marks it cancelled, distinct from done", async () => {
    const controller = controllableSource();
    controller.queue("first", "second");
    const { result } = renderHook(() => useStreamingText(controller.source));
    await waitFor(() => expect(result.current.status).toBe("streaming"));

    await controller.push();
    await waitFor(() => expect(result.current.text).toBe("first"));

    act(() => result.current.cancel());
    expect(result.current.status).toBe("cancelled");

    // The chunk that was already in flight must not append after cancellation.
    await controller.push();
    expect(result.current.text).toBe("first");
    expect(result.current.status).toBe("cancelled");
  });

  it("cancel() on an idle hook leaves the status alone", () => {
    const { result } = renderHook(() => useStreamingText(null));
    act(() => result.current.cancel());
    // Nothing was streaming, so there is nothing to cancel -- it must not claim a stream was interrupted.
    expect(result.current.status).toBe("idle");
  });

  it("a new source resets the previous run's text and error", async () => {
    const { result, rerender } = renderHook(({ source }) => useStreamingText(source), {
      initialProps: { source: throwingSource as StreamingTextSource },
    });
    await waitFor(() => expect(result.current.status).toBe("error"));

    const fresh = controllableSource();
    fresh.queue("clean");
    rerender({ source: fresh.source });
    await waitFor(() => expect(result.current.status).toBe("streaming"));
    // The stale failure must not bleed into the new stream.
    expect(result.current.error).toBeNull();
    expect(result.current.text).toBe("");

    await fresh.push();
    await waitFor(() => expect(result.current.text).toBe("clean"));
  });

  it("handles an empty source: it completes with no text rather than hanging in streaming", async () => {
    // A plain AsyncIterable that ends immediately -- an `async function*` with no `yield` trips require-yield.
    const empty: StreamingTextSource = () => ({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true as const, value: undefined }) }),
    });
    const { result } = renderHook(() => useStreamingText(empty));
    await waitFor(() => expect(result.current.status).toBe("done"));
    expect(result.current.text).toBe("");
  });

  it("never calls the network: the source is the only thing consumed", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const controller = controllableSource();
    controller.queue("x");
    renderHook(() => useStreamingText(controller.source));
    await controller.push();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
