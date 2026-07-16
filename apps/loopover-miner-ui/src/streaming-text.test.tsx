import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StreamingText } from "./components/streaming-text";
import type { ChunkSource } from "./lib/use-streaming-text";

afterEach(() => vi.unstubAllGlobals());

function mockReducedMotion(reduced: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduced && query.includes("reduce"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

/** Caller-driven chunk source so a test can hold the component in its "streaming" state to assert the caret. */
function deferredSource() {
  const queued: string[] = [];
  let release: (() => void) | null = null;
  let finished = false;
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
      if (finished) return;
      await gate();
    }
  }
  return {
    source: (() => gen()) as ChunkSource,
    push: async (chunk: string) => act(async () => (queued.push(chunk), wake())),
    finish: async () => act(async () => ((finished = true), wake())),
  };
}

const caret = () => document.querySelector("span[aria-hidden='true']");

describe("StreamingText (#6516)", () => {
  it("renders an idle paragraph with no text when given no source", () => {
    mockReducedMotion(false);
    const { container } = render(<StreamingText source={null} />);
    expect(container.querySelector("p")?.getAttribute("data-status")).toBe("idle");
    expect(container.textContent).toBe("");
  });

  it("reveals accumulated text and shows an animated caret while streaming (full motion)", async () => {
    mockReducedMotion(false);
    const src = deferredSource();
    render(<StreamingText source={src.source} />);
    await src.push("typing…");
    await waitFor(() => expect(screen.getByText(/typing…/)).toBeTruthy());
    expect(caret()).not.toBeNull(); // still streaming → caret present under full motion
  });

  it("suppresses the caret under prefers-reduced-motion but still reaches the full text and done", async () => {
    mockReducedMotion(true);
    const src = deferredSource();
    render(<StreamingText source={src.source} />);
    await src.push("no caret here");
    await waitFor(() => expect(screen.getByText(/no caret here/)).toBeTruthy());
    expect(caret()).toBeNull(); // reduced motion → no animated caret even mid-stream

    await src.finish();
    await waitFor(() => expect(document.querySelector("p")?.getAttribute("data-status")).toBe("done"));
    expect(document.querySelector("p")?.textContent).toContain("no caret here");
  });
});
