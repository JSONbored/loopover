import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useStreamingText, type ChunkSource } from "./lib/use-streaming-text";

// A promise the test resolves by hand, to gate a generator between chunks so intermediate stream state is
// observable deterministically (no timers, just microtask ordering) — the streaming analogue of
// use-polled-fetch.test.ts's manually-resolved in-flight fetches.
function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("useStreamingText (#6516)", () => {
  it("accumulates chunks incrementally across renders, not only at the end", async () => {
    const second = gate();
    const source: ChunkSource = () =>
      (async function* () {
        yield "Hel";
        await second.promise;
        yield "lo";
      })();

    const { result } = renderHook(() => useStreamingText(source));

    await waitFor(() => expect(result.current.text).toBe("Hel")); // partial, before the 2nd chunk
    expect(result.current.status).toBe("streaming");

    second.release();
    await waitFor(() => expect(result.current.status).toBe("done"));
    expect(result.current.text).toBe("Hello");
  });

  it("stops consuming a previous source when a new one is supplied — no late chunk from the old source lands", async () => {
    const oldLate = gate();
    const source1: ChunkSource = () =>
      (async function* () {
        yield "one";
        await oldLate.promise;
        yield "LATE";
      })();
    const source2: ChunkSource = () =>
      (async function* () {
        yield "two";
      })();

    const { result, rerender } = renderHook(({ src }) => useStreamingText(src), {
      initialProps: { src: source1 as ChunkSource },
    });

    await waitFor(() => expect(result.current.text).toBe("one"));

    rerender({ src: source2 });
    await waitFor(() => expect(result.current.status).toBe("done"));
    expect(result.current.text).toBe("two"); // reset to source2; source1 abandoned

    oldLate.release(); // source1's tail chunk fires AFTER the swap
    await Promise.resolve();
    await Promise.resolve();
    expect(result.current.text).toBe("two"); // "LATE" never appended
  });

  it("does not update state after unmount, even if a pending chunk resolves late", async () => {
    const late = gate();
    const source: ChunkSource = () =>
      (async function* () {
        yield "start";
        await late.promise;
        yield "END";
      })();

    const { result, unmount } = renderHook(() => useStreamingText(source));
    await waitFor(() => expect(result.current.text).toBe("start"));

    unmount();
    late.release();
    await Promise.resolve();
    await Promise.resolve();

    expect(result.current.text).toBe("start"); // frozen at unmount; "END" never applied
  });

  it("surfaces a mid-stream error through status/error and keeps the partial text", async () => {
    const boom = new Error("stream exploded");
    const source: ChunkSource = () =>
      (async function* () {
        yield "part";
        throw boom;
      })();

    const { result } = renderHook(() => useStreamingText(source));

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toBe(boom);
    expect(result.current.text).toBe("part");
  });

  it("cancel() halts an in-flight stream and ignores later chunks", async () => {
    const second = gate();
    const source: ChunkSource = () =>
      (async function* () {
        yield "a";
        await second.promise;
        yield "b";
      })();

    const { result } = renderHook(() => useStreamingText(source));
    await waitFor(() => expect(result.current.text).toBe("a"));

    act(() => result.current.cancel());
    expect(result.current.status).toBe("cancelled");

    second.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(result.current.text).toBe("a"); // "b" ignored after cancel
    expect(result.current.status).toBe("cancelled");
  });

  it("stays idle with a null source and cancel() is a no-op", () => {
    const { result } = renderHook(() => useStreamingText(null));

    expect(result.current.status).toBe("idle");
    expect(result.current.text).toBe("");
    expect(result.current.error).toBeNull();

    act(() => result.current.cancel()); // must not throw or change state
    expect(result.current.status).toBe("idle");
  });
});
