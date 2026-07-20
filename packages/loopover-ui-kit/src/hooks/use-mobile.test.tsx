import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useIsMobile } from "./use-mobile";

// jsdom implements neither window.matchMedia nor a settable innerWidth trigger, so stub matchMedia (capturing its
// `change` listeners) and drive innerWidth directly — the standard shadcn use-mobile test setup.
function stubMatchMedia() {
  const listeners = new Set<() => void>();
  const mql = {
    matches: false,
    media: "",
    addEventListener: (_type: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_type: string, cb: () => void) => listeners.delete(cb),
  };
  vi.stubGlobal("matchMedia", vi.fn(() => mql));
  return { fireChange: () => { for (const cb of [...listeners]) cb(); } };
}

function setInnerWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useIsMobile", () => {
  it("is true below the 768px breakpoint and false at/above it", () => {
    stubMatchMedia();

    setInnerWidth(500);
    const { result: mobile } = renderHook(() => useIsMobile());
    expect(mobile.current).toBe(true);

    setInnerWidth(1024);
    const { result: desktop } = renderHook(() => useIsMobile());
    expect(desktop.current).toBe(false);
  });

  it("flips when a matchMedia `change` event fires after innerWidth crosses the breakpoint", () => {
    const { fireChange } = stubMatchMedia();

    setInnerWidth(1024);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);

    setInnerWidth(400);
    act(() => {
      fireChange();
    });
    expect(result.current).toBe(true);
  });
});
