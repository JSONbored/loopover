import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createChatActionRegistry } from "../../../packages/loopover-miner/lib/chat-action-registry.js";
import { ChatConversation } from "./components/chat/conversation";
import { GOVERNOR_CHAT_ACTION_PENDING_MESSAGE } from "./lib/chat-governor-action-copy";
import type { ChatWireMessage } from "./lib/chat-stream";
import type { GovernorPauseState } from "./lib/governor";

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
});

describe("ChatConversation governor pause/resume chat actions (#8670)", () => {
  const pausedAt = "2026-07-16T10:00:00.000Z";
  const pausedState: GovernorPauseState = { paused: true, reason: null, pausedAt };
  const notPausedState: GovernorPauseState = { paused: false, reason: null, pausedAt: null };

  /** Real registry + real registration/dispatch wire; only the two HTTP clients are injected. */
  function governorHarness(overrides: { pauseState?: GovernorPauseState } = {}) {
    const registry = createChatActionRegistry();
    const pauseGovernorFn = vi.fn(async () => ({ ok: true as const, pauseState: overrides.pauseState ?? pausedState }));
    const resumeGovernorFn = vi.fn(async () => ({ ok: true as const, pauseState: notPausedState }));
    let streamCalls = 0;
    const streamChatImpl = async function* (_messages: ChatWireMessage[]): AsyncGenerator<string> {
      streamCalls += 1;
      yield "should not stream";
    };
    return {
      pauseGovernorFn,
      resumeGovernorFn,
      streamChatImpl,
      streamCalls: () => streamCalls,
      deps: { registry, pauseGovernorFn, resumeGovernorFn },
    };
  }

  it('END-TO-END: typing "pause the governor" fires the pause action and renders GovernorChatActionResult copy', async () => {
    const harness = governorHarness();
    render(<ChatConversation streamChatImpl={harness.streamChatImpl} governorChatDeps={harness.deps} />);
    ask("pause the governor");

    // The pause client actually fires — through registration + flag-gated dispatch, not a direct call…
    await waitFor(() => expect(harness.pauseGovernorFn).toHaveBeenCalledTimes(1));
    // …and the resolved result lands in the message list with GovernorChatActionResult's Ledgers-verbatim copy.
    await waitFor(() => expect(screen.getByText(`Paused since ${pausedAt}`)).toBeTruthy());
    expect(screen.getByText("pause the governor")).toBeTruthy();
    expect(harness.resumeGovernorFn).not.toHaveBeenCalled();
    expect(harness.streamCalls()).toBe(0);
    expect(sendButton().disabled).toBe(false);
  });

  it("passes a because-clause through to pauseGovernor as the structured reason param", async () => {
    const harness = governorHarness({
      pauseState: { paused: true, reason: "release traffic spiked", pausedAt },
    });
    render(<ChatConversation streamChatImpl={harness.streamChatImpl} governorChatDeps={harness.deps} />);
    ask("pause the governor because release traffic spiked");

    await waitFor(() => expect(harness.pauseGovernorFn).toHaveBeenCalledWith("release traffic spiked"));
    await waitFor(() => expect(screen.getByText(`Paused since ${pausedAt} (release traffic spiked)`)).toBeTruthy());
    expect(harness.streamCalls()).toBe(0);
  });

  it('typing "resume the governor" fires the resume action and renders the not-paused copy', async () => {
    const harness = governorHarness();
    render(<ChatConversation streamChatImpl={harness.streamChatImpl} governorChatDeps={harness.deps} />);
    ask("resume the governor");

    await waitFor(() => expect(harness.resumeGovernorFn).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText("Not paused")).toBeTruthy());
    expect(harness.pauseGovernorFn).not.toHaveBeenCalled();
    expect(harness.streamCalls()).toBe(0);
  });

  it("shows the pending governor copy (and locks the composer) while the round-trip is outstanding", async () => {
    const registry = createChatActionRegistry();
    let resolvePause!: (value: { ok: true; pauseState: GovernorPauseState }) => void;
    const pauseGovernorFn = vi.fn(
      () => new Promise<{ ok: true; pauseState: GovernorPauseState }>((resolve) => (resolvePause = resolve)),
    );
    const resumeGovernorFn = vi.fn(async () => ({ ok: true as const, pauseState: notPausedState }));
    render(
      <ChatConversation
        streamChatImpl={async function* () {
          /* never used */
        }}
        governorChatDeps={{ registry, pauseGovernorFn, resumeGovernorFn }}
      />,
    );
    ask("pause the governor");

    await waitFor(() => expect(screen.getByText(GOVERNOR_CHAT_ACTION_PENDING_MESSAGE)).toBeTruthy());
    expect(sendButton().disabled).toBe(true);

    resolvePause({ ok: true, pauseState: pausedState });

    await waitFor(() => expect(screen.getByText(`Paused since ${pausedAt}`)).toBeTruthy());
    expect(screen.queryByText(GOVERNOR_CHAT_ACTION_PENDING_MESSAGE)).toBeNull();
    expect(sendButton().disabled).toBe(false);
  });

  it("surfaces a non-executed dispatch (flag off / gated) as a system note instead of an empty turn", async () => {
    const runGovernorChatActionImpl = vi.fn(async () => ({ ok: false, status: "disabled", action: null }));
    render(
      <ChatConversation
        streamChatImpl={async function* () {
          /* never used */
        }}
        runGovernorChatActionImpl={runGovernorChatActionImpl}
      />,
    );
    ask("pause the governor");

    await waitFor(() => expect(screen.getByText("Couldn't run the governor action: disabled.")).toBeTruthy());
    expect(runGovernorChatActionImpl).toHaveBeenCalledTimes(1);
    expect(sendButton().disabled).toBe(false);
  });

  it("surfaces a thrown dispatch as the inline turn-failed note and re-enables the composer", async () => {
    const runGovernorChatActionImpl = vi.fn(async () => {
      throw new Error("connection refused");
    });
    render(
      <ChatConversation
        streamChatImpl={async function* () {
          /* never used */
        }}
        runGovernorChatActionImpl={runGovernorChatActionImpl}
      />,
    );
    ask("pause the governor");

    await waitFor(() => expect(screen.getByText(/latest response failed to complete/i)).toBeTruthy());
    expect(sendButton().disabled).toBe(false);
  });

  it("an ordinary governor QUESTION still streams through the read-only assistant, never a dispatch", async () => {
    const harness = governorHarness();
    const seen: ChatWireMessage[][] = [];
    const streamChatImpl = async function* (messages: ChatWireMessage[]) {
      seen.push(messages);
      yield "governor overview";
    };
    render(<ChatConversation streamChatImpl={streamChatImpl} governorChatDeps={harness.deps} />);
    ask("what is the governor status?");

    await waitFor(() => expect(screen.getByText("governor overview")).toBeTruthy());
    expect(harness.pauseGovernorFn).not.toHaveBeenCalled();
    expect(harness.resumeGovernorFn).not.toHaveBeenCalled();
    expect(seen[0]).toEqual([{ role: "user", content: "what is the governor status?" }]);
  });
});
