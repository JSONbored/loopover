import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ChatConversation } from "./components/chat/conversation";
import type { ChatWireMessage } from "./lib/chat-stream";

const sendButton = () => screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;

function ask(question: string) {
  fireEvent.change(screen.getByRole("textbox"), { target: { value: question } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

/** A promise plus its resolver, for gating a stream open across an assertion. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("ChatConversation (#6518)", () => {
  it("renders the empty conversation state with an enabled composer before any question", () => {
    render(
      <ChatConversation
        streamChatImpl={async function* () {
          /* no messages */
        }}
      />,
    );
    expect(screen.getByText(/No messages yet/i)).toBeTruthy();
    expect(sendButton().disabled).toBe(false);
  });

  it("sends the composed question to the backend as wire-shaped history", async () => {
    const seen: ChatWireMessage[][] = [];
    const streamChatImpl = async function* (messages: ChatWireMessage[]) {
      seen.push(messages);
      yield "ok";
    };
    render(<ChatConversation streamChatImpl={streamChatImpl} />);
    ask("what is stuck?");
    await waitFor(() => expect(screen.getByText("ok")).toBeTruthy());
    expect(seen[0]).toEqual([{ role: "user", content: "what is stuck?" }]);
  });

  it("disables the composer while a response streams, commits the answer, and re-enables it", async () => {
    const gate = deferred();
    const streamChatImpl = async function* (_messages: ChatWireMessage[]) {
      yield "Hel";
      await gate.promise;
      yield "lo";
    };
    render(<ChatConversation streamChatImpl={streamChatImpl} />);
    ask("hi");

    // The question shows immediately and the composer is locked for the whole in-flight window.
    await waitFor(() => expect(sendButton().disabled).toBe(true));
    expect(screen.getByText("hi")).toBeTruthy();

    gate.resolve();

    // On completion the streamed answer is committed into the list and the composer re-enables.
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    expect(screen.getByText("Hello")).toBeTruthy();
  });

  it("surfaces a backend failure as an inline system note and re-enables the composer (#7077)", async () => {
    const streamChatImpl = async function* (_messages: ChatWireMessage[]): AsyncGenerator<string> {
      yield* []; // yields nothing, then fails — models a backend/stream error mid-request
      throw new Error("connection refused");
    };
    render(<ChatConversation streamChatImpl={streamChatImpl} />);
    ask("hi");

    await waitFor(() => expect(screen.getByText(/latest response failed to complete/i)).toBeTruthy());
    expect(screen.getByText("hi")).toBeTruthy();
    expect(screen.queryByText(/Couldn't load the conversation/i)).toBeNull();
    expect(sendButton().disabled).toBe(false);
  });

  it("REGRESSION (#7078): shows the typing indicator after submit until the first streamed chunk, then clears it", async () => {
    const gate = deferred();
    const streamChatImpl = async function* (_messages: ChatWireMessage[]) {
      // Hold the stream open with no text so the pre-first-chunk composing window is observable.
      await gate.promise;
      yield "Hello";
    };
    render(<ChatConversation streamChatImpl={streamChatImpl} />);
    ask("what is stuck?");

    await waitFor(() => expect(screen.getByRole("status", { name: /is typing/i })).toBeTruthy());
    expect(screen.getByText("what is stuck?")).toBeTruthy();
    expect(sendButton().disabled).toBe(true);

    gate.resolve();

    await waitFor(() => expect(screen.getByText("Hello")).toBeTruthy());
    expect(screen.queryByRole("status", { name: /is typing/i })).toBeNull();
  });

  it("REGRESSION (#7077): a second-turn failure leaves the first successful turn visible", async () => {
    let calls = 0;
    const streamChatImpl = async function* (_messages: ChatWireMessage[]): AsyncGenerator<string> {
      calls += 1;
      if (calls === 1) {
        yield "first answer";
        return;
      }
      throw new Error("connection refused");
    };
    render(<ChatConversation streamChatImpl={streamChatImpl} />);
    ask("first question");
    await waitFor(() => expect(screen.getByText("first answer")).toBeTruthy());

    ask("second question");
    await waitFor(() => expect(screen.getByText(/latest response failed to complete/i)).toBeTruthy());
    expect(screen.getByText("first question")).toBeTruthy();
    expect(screen.getByText("first answer")).toBeTruthy();
    expect(screen.getByText("second question")).toBeTruthy();
    expect(screen.queryByText(/Couldn't load the conversation/i)).toBeNull();
    expect(sendButton().disabled).toBe(false);
  });

  it("REGRESSION (#7077): partial streamed text is preserved after a mid-stream failure", async () => {
    const streamChatImpl = async function* (_messages: ChatWireMessage[]): AsyncGenerator<string> {
      yield "Hel";
      throw new Error("connection reset");
    };
    render(<ChatConversation streamChatImpl={streamChatImpl} />);
    ask("hi");

    await waitFor(() => expect(sendButton().disabled).toBe(false));
    expect(screen.getByText("Hel")).toBeTruthy();
    expect(screen.getByText(/latest response failed to complete/i)).toBeTruthy();
    expect(screen.queryByText(/Couldn't load the conversation/i)).toBeNull();
  });

  it("REGRESSION (#7075): a release-shaped message dispatches through the portfolio handler, not streamChat", async () => {
    let streamCalls = 0;
    const streamChatImpl = async function* (_messages: ChatWireMessage[]): AsyncGenerator<string> {
      streamCalls += 1;
      yield "should not stream";
    };
    const handlePortfolioQueueChatCommandImpl = vi.fn(async (text: string) => {
      expect(text).toBe("release acme/widgets");
      return {
        dispatched: true,
        messages: [
          {
            id: "sys-release",
            role: "system" as const,
            content: "Queue release succeeded for acme/widgets (issue:12).",
            timestamp: "2026-07-16T09:00:00.000Z",
          },
        ],
      };
    });

    render(
      <ChatConversation
        streamChatImpl={streamChatImpl}
        handlePortfolioQueueChatCommandImpl={handlePortfolioQueueChatCommandImpl}
      />,
    );
    ask("release acme/widgets");

    await waitFor(() => expect(handlePortfolioQueueChatCommandImpl).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/Queue release succeeded for acme\/widgets/i)).toBeTruthy());
    expect(screen.getByText("release acme/widgets")).toBeTruthy();
    expect(streamCalls).toBe(0);
    expect(sendButton().disabled).toBe(false);
  });

  it("REGRESSION (#7075): an ordinary question still reaches streamChat unchanged", async () => {
    const seen: ChatWireMessage[][] = [];
    const streamChatImpl = async function* (messages: ChatWireMessage[]) {
      seen.push(messages);
      yield "grounded answer";
    };
    const handlePortfolioQueueChatCommandImpl = vi.fn(async () => {
      throw new Error("must not dispatch portfolio actions for ordinary questions");
    });

    render(
      <ChatConversation
        streamChatImpl={streamChatImpl}
        handlePortfolioQueueChatCommandImpl={handlePortfolioQueueChatCommandImpl}
      />,
    );
    ask("what is stuck?");

    await waitFor(() => expect(screen.getByText("grounded answer")).toBeTruthy());
    expect(handlePortfolioQueueChatCommandImpl).not.toHaveBeenCalled();
    expect(seen[0]).toEqual([{ role: "user", content: "what is stuck?" }]);
  });

  it("REGRESSION (#7229): auto-scrolls the viewport as streamed chunks accumulate, unless scrolled up", async () => {
    const gate = deferred();
    const streamChatImpl = async function* (_messages: ChatWireMessage[]) {
      yield "Hel";
      await gate.promise;
      yield "lo";
    };
    const { container } = render(<ChatConversation streamChatImpl={streamChatImpl} />);
    const viewport = container.querySelector<HTMLElement>("[data-radix-scroll-area-viewport]")!;
    // jsdom does not lay out; fake an overflowing viewport so the scroll side effect is observable.
    Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 200 });

    ask("hi");

    // The first streamed chunk paints StreamingText inside the viewport footer -> the follow pins to bottom.
    await waitFor(() => expect(screen.getByText("Hel")).toBeTruthy());
    await waitFor(() => expect(viewport.scrollTop).toBe(1000));

    // The operator scrolls up mid-stream: the remaining chunks (and the committed answer) must not yank down.
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event("scroll"));
    gate.resolve();

    await waitFor(() => expect(screen.getByText("Hello")).toBeTruthy());
    expect(viewport.scrollTop).toBe(0);
  });
});
