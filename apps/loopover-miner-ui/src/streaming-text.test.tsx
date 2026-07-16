import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StreamingText } from "./components/streaming-text";
import type { StreamingTextSource } from "./lib/use-streaming-text";

/** jsdom has no matchMedia, and the component reads it on mount -- stub it per test so both the reduced-motion
 *  and the default path are exercised deliberately rather than by whatever jsdom happens to default to. */
function stubReducedMotion(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
}

const source: StreamingTextSource = async function* () {
  yield "Queue is ";
  yield "healthy.";
};

/** Fails on the first pull. A plain AsyncIterable rather than an `async function*`, because a generator that
 *  only throws has no `yield` and trips require-yield. */
const failing: StreamingTextSource = () => ({
  [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error("stream died")) }),
});

afterEach(() => vi.unstubAllGlobals());

describe("StreamingText (#6516)", () => {
  it("renders the accumulated answer as it streams in", async () => {
    stubReducedMotion(false);
    render(<StreamingText source={source} />);
    await waitFor(() => expect(screen.getByText("Queue is healthy.")).toBeTruthy());
  });

  it("marks the region live and busy only while streaming", async () => {
    stubReducedMotion(false);
    const { container } = render(<StreamingText source={source} />);
    const paragraph = container.querySelector("p")!;
    // aria-live so the reply is announced as it fills in; polite so it never interrupts the operator.
    expect(paragraph.getAttribute("aria-live")).toBe("polite");
    await waitFor(() => expect(paragraph.getAttribute("data-status")).toBe("done"));
    expect(paragraph.getAttribute("aria-busy")).toBe("false");
  });

  it("reaches the same final text under prefers-reduced-motion", async () => {
    stubReducedMotion(true);
    render(<StreamingText source={source} />);
    // End-state only, never timing -- the reduced-motion path must change presentation, not content.
    await waitFor(() => expect(screen.getByText("Queue is healthy.")).toBeTruthy());
  });

  it("drops the transition class under prefers-reduced-motion but keeps it otherwise", async () => {
    stubReducedMotion(true);
    const { container, unmount } = render(<StreamingText source={source} />);
    await waitFor(() => expect(screen.getByText("Queue is healthy.")).toBeTruthy());
    expect(container.querySelector("p")!.className).not.toContain("transition-opacity");
    unmount();

    stubReducedMotion(false);
    const withMotion = render(<StreamingText source={source} />);
    await waitFor(() => expect(screen.getByText("Queue is healthy.")).toBeTruthy());
    expect(withMotion.container.querySelector("p")!.className).toContain("transition-opacity");
  });

  it("surfaces a stream failure as an alert instead of a silent empty box", async () => {
    stubReducedMotion(false);
    render(<StreamingText source={failing} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("stream died");
  });

  it("renders an empty, idle region when there is no source yet", () => {
    stubReducedMotion(false);
    const { container } = render(<StreamingText source={null} />);
    const paragraph = container.querySelector("p")!;
    expect(paragraph.getAttribute("data-status")).toBe("idle");
    expect(paragraph.textContent).toBe("");
  });

  it("passes a caller className through alongside its own classes", () => {
    stubReducedMotion(false);
    const { container } = render(<StreamingText source={null} className="mt-2" />);
    expect(container.querySelector("p")!.className).toContain("mt-2");
  });
});
