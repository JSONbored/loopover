import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StreamingText } from "./components/streaming-text";
import type { ChunkSource } from "./lib/use-streaming-text";

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("StreamingText (#6516)", () => {
  it("renders the accumulated streamed text and marks completion", async () => {
    const source: ChunkSource = () =>
      (async function* () {
        yield "Hel";
        yield "lo";
      })();

    render(<StreamingText source={source} />);
    const log = screen.getByRole("log");

    await waitFor(() => expect(log.textContent).toContain("Hello"));
    await waitFor(() => expect(log.getAttribute("data-status")).toBe("done"));
  });

  it("stays idle and renders no text when the source is null", () => {
    render(<StreamingText source={null} />);
    const log = screen.getByRole("log");

    expect(log.getAttribute("data-status")).toBe("idle");
    expect(log.textContent).toBe("");
    expect(log.getAttribute("aria-busy")).toBe("false");
  });

  it("shows an animated caret only while streaming when motion is allowed", async () => {
    const held = new Promise<void>(() => {}); // never resolves — keeps the stream open
    const source: ChunkSource = () =>
      (async function* () {
        yield "typing";
        await held;
      })();

    render(<StreamingText source={source} />);
    const log = screen.getByRole("log");

    await waitFor(() => expect(log.textContent).toContain("typing"));
    expect(log.getAttribute("aria-busy")).toBe("true");
    expect(log.querySelector("[aria-hidden='true']")).not.toBeNull(); // caret present mid-stream
    expect(log.getAttribute("aria-live")).toBe("polite");
  });

  it("reaches the same final text under prefers-reduced-motion, with the live cue disabled", async () => {
    stubMatchMedia(true);
    const source: ChunkSource = () =>
      (async function* () {
        yield "Quiet ";
        yield "reveal";
      })();

    render(<StreamingText source={source} />);
    const log = screen.getByRole("log");

    await waitFor(() => expect(log.textContent).toBe("Quiet reveal")); // no caret text appended
    expect(log.getAttribute("data-status")).toBe("done");
    expect(log.getAttribute("aria-live")).toBe("off"); // reduced motion turns the live region off
  });
});
