import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_POLL_INTERVAL_MS, usePolledFetch } from "./lib/use-polled-fetch";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("usePolledFetch (#4856)", () => {
  it("fetches once immediately on mount", async () => {
    const loadFn = vi.fn(async () => "loaded");
    const { result } = renderHook(() => usePolledFetch(loadFn, 1000));
    await waitFor(() => expect(result.current.result).toBe("loaded"));
    expect(loadFn).toHaveBeenCalledTimes(1);
  });

  it("re-fetches on every poll interval tick, updating the returned result each time", async () => {
    vi.useFakeTimers();
    let call = 0;
    const loadFn = vi.fn(async () => `loaded-${(call += 1)}`);
    const { result } = renderHook(() => usePolledFetch(loadFn, 1000));

    await vi.waitFor(() => expect(result.current.result).toBe("loaded-1"));

    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(result.current.result).toBe("loaded-2"));

    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(result.current.result).toBe("loaded-3"));

    expect(loadFn).toHaveBeenCalledTimes(3);
  });

  it("stops polling after unmount", async () => {
    vi.useFakeTimers();
    const loadFn = vi.fn(async () => "loaded");
    const { result, unmount } = renderHook(() => usePolledFetch(loadFn, 1000));
    await vi.waitFor(() => expect(result.current.result).toBe("loaded"));
    expect(loadFn).toHaveBeenCalledTimes(1);

    unmount();
    await vi.advanceTimersByTimeAsync(5000);
    expect(loadFn).toHaveBeenCalledTimes(1); // no further calls after unmount
  });

  it("REGRESSION (#7230): refresh() fetches immediately but does NOT reset the interval schedule", async () => {
    vi.useFakeTimers();
    let call = 0;
    const loadFn = vi.fn(async () => `loaded-${(call += 1)}`);
    const { result } = renderHook(() => usePolledFetch(loadFn, 1000));

    // Mount fetch.
    await vi.waitFor(() => expect(result.current.result).toBe("loaded-1"));
    expect(loadFn).toHaveBeenCalledTimes(1);

    // Part-way through the first interval, an operator action triggers refresh(): an immediate extra fetch.
    await vi.advanceTimersByTimeAsync(600);
    result.current.refresh();
    await vi.waitFor(() => expect(result.current.result).toBe("loaded-2"));
    expect(loadFn).toHaveBeenCalledTimes(2);

    // The original schedule is undisturbed: the next scheduled tick still lands at t=1000 (400ms later), NOT
    // 1000ms after the refresh. Advancing the remaining 400ms fires it.
    await vi.advanceTimersByTimeAsync(400);
    await vi.waitFor(() => expect(result.current.result).toBe("loaded-3"));
    expect(loadFn).toHaveBeenCalledTimes(3);
  });

  it("REGRESSION (#7230): a changed loadFn identity does not tear down and re-arm the interval", async () => {
    vi.useFakeTimers();
    let call = 0;
    const makeLoadFn = () => vi.fn(async () => `loaded-${(call += 1)}`);
    const { result, rerender } = renderHook(({ loadFn }) => usePolledFetch(loadFn, 1000), {
      initialProps: { loadFn: makeLoadFn() },
    });
    await vi.waitFor(() => expect(result.current.result).toBe("loaded-1"));

    // A new loadFn identity mid-interval must NOT trigger an immediate fetch or restart the timer — the next
    // scheduled tick simply uses the latest loadFn.
    await vi.advanceTimersByTimeAsync(600);
    rerender({ loadFn: makeLoadFn() });
    expect(call).toBe(1); // no extra fetch fired on the identity change

    await vi.advanceTimersByTimeAsync(400); // original schedule's t=1000 tick
    await vi.waitFor(() => expect(result.current.result).toBe("loaded-2"));
  });

  it("refresh() is skipped while a fetch is already in flight", async () => {
    vi.useFakeTimers();
    let resolveFirst: ((value: string) => void) | undefined;
    let callCount = 0;
    const loadFn = vi.fn(() => {
      callCount += 1;
      if (callCount === 1) {
        return new Promise<string>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(`loaded-${callCount}`);
    });
    const { result } = renderHook(() => usePolledFetch(loadFn, 1000));
    expect(loadFn).toHaveBeenCalledTimes(1); // mount fetch in flight

    result.current.refresh(); // in-flight → no-op
    expect(loadFn).toHaveBeenCalledTimes(1);

    resolveFirst?.("loaded-1");
    await vi.advanceTimersByTimeAsync(0);
    result.current.refresh(); // now free
    await vi.waitFor(() => expect(loadFn).toHaveBeenCalledTimes(2));
  });

  it("skips an overlapping tick when the previous fetch is still in flight, instead of stacking concurrent requests", async () => {
    vi.useFakeTimers();
    let resolveFirst: ((value: string) => void) | undefined;
    let callCount = 0;
    const loadFn = vi.fn(() => {
      callCount += 1;
      if (callCount === 1) {
        return new Promise<string>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(`loaded-${callCount}`);
    });

    renderHook(() => usePolledFetch(loadFn, 1000));
    expect(loadFn).toHaveBeenCalledTimes(1); // first call in flight, unresolved

    // A tick fires while the first fetch is still pending -- must be skipped, not stacked.
    await vi.advanceTimersByTimeAsync(1000);
    expect(loadFn).toHaveBeenCalledTimes(1);

    // Resolve the first fetch; the NEXT tick after that is free to fetch again.
    resolveFirst?.("loaded-1");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(loadFn).toHaveBeenCalledTimes(2);
  });

  it("does not update the result after unmount, even if an in-flight fetch resolves late", async () => {
    let resolveLoad: ((value: string) => void) | undefined;
    const loadFn = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const { result, unmount } = renderHook(() => usePolledFetch(loadFn, 1000));
    unmount();
    resolveLoad?.("too-late");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current.result).toBeNull();
  });

  it("exports a sensible default poll interval", () => {
    expect(DEFAULT_POLL_INTERVAL_MS).toBeGreaterThan(0);
  });
});
