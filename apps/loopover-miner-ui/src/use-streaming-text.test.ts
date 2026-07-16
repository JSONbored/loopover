import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useStreamingText, type ChunkSource } from "./lib/use-streaming-text";

afterEach(() => vi.restoreAllMocks());

/**
 * A chunk source whose delivery the test drives explicitly: the generator yields any queued chunks, then
 * awaits a gate; `push`/`fail`/`finish` enqueue the next event and release the gate. This makes intermediate
 * accumulation and the cancel/error transitions deterministic, in the spirit of use-polled-fetch.test.ts's
 * fake-timer control.
 */
function deferredSource() {
  const queued: string[] = [];
  let release: (() => void) | null = null;
  let finished = false;
  let failure: Error | null = null;
  const gate = () => new Promise<void>((resolve) => (release = resolve));
  const wake = () => {
    const r = release;
    release = null;
    r?.();
  };
  async function* gen(): AsyncGenerator<string> {
    let i = 0;
    for (;;) {
      while (i < queued.length) yield queued[i++]!;
      if (failure) throw failure;
      if (finished) return;
      await gate();
    }
  }
  return {
    source: (() => gen()) as ChunkSource,
    push: async (chunk: string) => act(async () => (queued.push(chunk), wake())),
    fail: async (err: Error) => act(async () => ((failure = err), wake())),
    finish: async () => act(async () => ((finished = true), wake())),
  };
}

describe("useStreamingText (#6516)", () => {
  it("starts idle when given no source", () => {
    const { result } = renderHook(() => useStreamingText(null));
    expect(result.current).toMatchObject({ text: "", status: "idle", error: null });
  });

  it("accumulates chunks incrementally across renders, then reaches done", async () => {
    const src = deferredSource();
    const { result } = renderHook(() => useStreamingText(src.source));
    await waitFor(() => expect(result.current.status).toBe("streaming"));

    await src.push("Hel");
    await waitFor(() => expect(result.current.text).toBe("Hel"));
    await src.push("lo wor");
    await waitFor(() => expect(result.current.text).toBe("Hello wor"));
    await src.push("ld");
    await waitFor(() => expect(result.current.text).toBe("Hello world"));

    await src.finish();
    await waitFor(() => expect(result.current.status).toBe("done"));
    expect(result.current.text).toBe("Hello world");
  });

  it("cancel() stops the stream and no later chunk reaches state", async () => {
    const src = deferredSource();
    const { result } = renderHook(() => useStreamingText(src.source));
    await src.push("first");
    await waitFor(() => expect(result.current.text).toBe("first"));

    act(() => result.current.cancel());
    await waitFor(() => expect(result.current.status).toBe("cancelled"));

    await src.push("late"); // arrives after cancel — must be ignored
    expect(result.current.text).toBe("first");
    expect(result.current.status).toBe("cancelled");
  });

  it("starting a new source stops the previous one; its late chunk never reaches state", async () => {
    const first = deferredSource();
    const { result, rerender } = renderHook(({ s }: { s: ChunkSource }) => useStreamingText(s), {
      initialProps: { s: first.source },
    });
    await first.push("old");
    await waitFor(() => expect(result.current.text).toBe("old"));

    const second = deferredSource();
    rerender({ s: second.source }); // swap sources mid-stream
    await second.push("new");
    await waitFor(() => expect(result.current.text).toBe("new"));

    await first.push("STALE"); // a late chunk from the abandoned first source
    expect(result.current.text).toBe("new");
  });

  it("does not update state after unmount, even if a chunk resolves late", async () => {
    const src = deferredSource();
    const { result, unmount } = renderHook(() => useStreamingText(src.source));
    await src.push("kept");
    await waitFor(() => expect(result.current.text).toBe("kept"));

    unmount();
    await expect(src.push("after-unmount")).resolves.not.toThrow(); // no throw, no state write
    expect(result.current.text).toBe("kept");
  });

  it("surfaces a mid-stream error through status/error, not as an unhandled rejection", async () => {
    const src = deferredSource();
    const { result } = renderHook(() => useStreamingText(src.source));
    await src.push("partial");
    await waitFor(() => expect(result.current.text).toBe("partial"));

    await src.fail(new Error("stream boom"));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error?.message).toBe("stream boom");
    expect(result.current.text).toBe("partial");
  });
});
