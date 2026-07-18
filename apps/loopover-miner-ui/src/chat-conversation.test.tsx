import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

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

  it("surfaces a backend failure through the message-list error state and re-enables the composer", async () => {
    const streamChatImpl = async function* (_messages: ChatWireMessage[]): AsyncGenerator<string> {
      yield* []; // yields nothing, then fails — models a backend/stream error mid-request
      throw new Error("connection refused");
    };
    render(<ChatConversation streamChatImpl={streamChatImpl} />);
    ask("hi");

    await waitFor(() => expect(screen.getByText(/Couldn't load the conversation/i)).toBeTruthy());
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
});
