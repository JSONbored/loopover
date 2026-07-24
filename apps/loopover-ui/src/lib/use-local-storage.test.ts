import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useLocalStorage } from "@/lib/use-local-storage";

function dispatchStorage(init: StorageEventInit) {
  window.dispatchEvent(new StorageEvent("storage", init));
}

describe("useLocalStorage legacyKey migration (rebrand key rename)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("reads the new key directly when it's already present, ignoring any legacy key", async () => {
    window.localStorage.setItem("new.key", JSON.stringify("from-new"));
    window.localStorage.setItem("legacy.key", JSON.stringify("from-legacy"));
    const { result } = renderHook(() =>
      useLocalStorage<string>("new.key", "initial", "legacy.key"),
    );
    await waitFor(() => expect(result.current[2]).toBe(true));
    expect(result.current[0]).toBe("from-new");
  });

  it("falls back to the legacy key when the new key is absent, and migrates the value forward", async () => {
    window.localStorage.setItem("legacy.key", JSON.stringify("carried-over"));
    const { result } = renderHook(() =>
      useLocalStorage<string>("new.key", "initial", "legacy.key"),
    );
    await waitFor(() => expect(result.current[2]).toBe(true));
    expect(result.current[0]).toBe("carried-over");
    // Migrated forward: the new key now holds the value directly, without removing the legacy key.
    expect(window.localStorage.getItem("new.key")).toBe(JSON.stringify("carried-over"));
    expect(window.localStorage.getItem("legacy.key")).toBe(JSON.stringify("carried-over"));
  });

  it("uses the initial value when neither the new nor the legacy key is present", async () => {
    const { result } = renderHook(() =>
      useLocalStorage<string>("new.key", "initial", "legacy.key"),
    );
    await waitFor(() => expect(result.current[2]).toBe(true));
    expect(result.current[0]).toBe("initial");
    expect(window.localStorage.getItem("new.key")).toBeNull();
  });

  it("behaves exactly as before when no legacyKey is given at all", async () => {
    window.localStorage.setItem("solo.key", JSON.stringify("value"));
    const { result } = renderHook(() => useLocalStorage<string>("solo.key", "initial"));
    await waitFor(() => expect(result.current[2]).toBe(true));
    expect(result.current[0]).toBe("value");
  });

  it("writes through the new key going forward after a migration", async () => {
    window.localStorage.setItem("legacy.key", JSON.stringify("old-value"));
    const { result } = renderHook(() =>
      useLocalStorage<string>("new.key", "initial", "legacy.key"),
    );
    await waitFor(() => expect(result.current[2]).toBe(true));
    act(() => result.current[1]("new-value"));
    expect(window.localStorage.getItem("new.key")).toBe(JSON.stringify("new-value"));
  });
});

describe("useLocalStorage cross-tab storage sync", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("updates value when another tab writes a valid JSON value for the hook's own key", async () => {
    const { result } = renderHook(() => useLocalStorage<string>("solo.key", "initial"));
    await waitFor(() => expect(result.current[2]).toBe(true));
    expect(result.current[0]).toBe("initial");

    act(() => {
      dispatchStorage({ key: "solo.key", newValue: JSON.stringify("from-other-tab") });
    });
    expect(result.current[0]).toBe("from-other-tab");
  });

  it("ignores a storage event for a different key", async () => {
    const { result } = renderHook(() => useLocalStorage<string>("solo.key", "initial"));
    await waitFor(() => expect(result.current[2]).toBe(true));

    act(() => {
      dispatchStorage({ key: "other.key", newValue: JSON.stringify("nope") });
    });
    expect(result.current[0]).toBe("initial");
  });

  it("resets to initial when another tab removes the key (newValue null)", async () => {
    window.localStorage.setItem("solo.key", JSON.stringify("present"));
    const { result } = renderHook(() => useLocalStorage<string>("solo.key", "initial"));
    await waitFor(() => expect(result.current[2]).toBe(true));
    expect(result.current[0]).toBe("present");

    act(() => {
      dispatchStorage({ key: "solo.key", newValue: null });
    });
    expect(result.current[0]).toBe("initial");
  });

  it("ignores a malformed newValue without throwing", async () => {
    const { result } = renderHook(() => useLocalStorage<string>("solo.key", "initial"));
    await waitFor(() => expect(result.current[2]).toBe(true));

    act(() => {
      dispatchStorage({ key: "solo.key", newValue: "{not-json" });
    });
    expect(result.current[0]).toBe("initial");
  });

  it("honors a storage event for the configured legacyKey", async () => {
    const { result } = renderHook(() =>
      useLocalStorage<string>("new.key", "initial", "legacy.key"),
    );
    await waitFor(() => expect(result.current[2]).toBe(true));

    act(() => {
      dispatchStorage({ key: "legacy.key", newValue: JSON.stringify("from-legacy-tab") });
    });
    expect(result.current[0]).toBe("from-legacy-tab");
  });

  it("removes the storage listener on unmount", async () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { result, unmount } = renderHook(() => useLocalStorage<string>("solo.key", "initial"));
    await waitFor(() => expect(result.current[2]).toBe(true));

    unmount();
    expect(removeSpy).toHaveBeenCalledWith("storage", expect.any(Function));

    // Firing after unmount must not throw (listener is gone).
    expect(() => {
      dispatchStorage({ key: "solo.key", newValue: JSON.stringify("after-unmount") });
    }).not.toThrow();
  });
});
