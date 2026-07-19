import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageList } from "./components/chat/message-list";
import { MessageBubble } from "./components/chat/message-bubble";
import { TypingIndicator } from "./components/chat/typing-indicator";
import { emptyConversation, multiTurnConversation, singleMessage, type ChatMessage } from "./components/chat/fixtures";

describe("MessageList (#6515) — StateBoundary branches", () => {
  it("renders one bubble per message in the populated state", () => {
    render(<MessageList messages={multiTurnConversation} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(multiTurnConversation.length);
    expect(screen.getByText(multiTurnConversation[0]!.content)).toBeTruthy();
  });

  it("shows the empty state (not a bare list) when there are no messages", () => {
    render(<MessageList messages={emptyConversation} />);
    expect(screen.getByText(/No messages yet/i)).toBeTruthy();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("shows the loading state", () => {
    render(<MessageList messages={emptyConversation} isLoading />);
    expect(screen.getByText(/Loading conversation/i)).toBeTruthy();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("shows the error state", () => {
    render(<MessageList messages={emptyConversation} isError />);
    expect(screen.getByText(/Couldn't load the conversation/i)).toBeTruthy();
  });

  it("renders the typing indicator (below the list) when composing, independent of message state", () => {
    render(<MessageList messages={singleMessage} composing />);
    expect(screen.getByRole("status", { name: /is typing/i })).toBeTruthy();
    // still renders the list itself
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("does not render the typing indicator when not composing", () => {
    render(<MessageList messages={singleMessage} />);
    expect(screen.queryByRole("status", { name: /is typing/i })).toBeNull();
  });
});

describe("MessageList (#7081) — message list is a polite live region for completed turns", () => {
  it("marks the message-list container as a polite additions-only live region", () => {
    render(<MessageList messages={multiTurnConversation} />);
    const list = screen.getByRole("list");
    expect(list.getAttribute("aria-live")).toBe("polite");
    // Polite (not assertive): chat answers are not interrupting content; additions-only so removals stay silent.
    expect(list.getAttribute("aria-relevant")).toBe("additions");
  });

  it("appends exactly one announceable node per completed turn", () => {
    const question: ChatMessage[] = [
      { id: "u1", role: "user", content: "what's stuck?", timestamp: "2026-07-16T08:00:00.000Z" },
    ];
    const { rerender } = render(<MessageList messages={question} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(1);

    // The completed assistant turn adds a single new list item into the live region -> one announcement.
    const answered: ChatMessage[] = [
      ...question,
      { id: "a1", role: "assistant", content: "first answer", timestamp: "2026-07-16T08:00:01.000Z" },
    ];
    rerender(<MessageList messages={answered} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("first answer")).toBeTruthy();

    // The next completed turn adds exactly one more — never a burst, because streaming chunks (rendered by the
    // footer StreamingText outside this live region but inside the same ScrollArea — #7229) never mutate
    // `messages`.
    const reAnswered: ChatMessage[] = [
      ...answered,
      { id: "u2", role: "user", content: "and now?", timestamp: "2026-07-16T08:00:02.000Z" },
      { id: "a2", role: "assistant", content: "second answer", timestamp: "2026-07-16T08:00:03.000Z" },
    ];
    rerender(<MessageList messages={reAnswered} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByText("second answer")).toBeTruthy();
  });

  it("leaves StateBoundary's own loading status region intact (no list live region rendered while loading)", () => {
    render(<MessageList messages={emptyConversation} isLoading />);
    expect(screen.getByText(/Loading conversation/i)).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });
});

describe("MessageList (#7229) — stick-to-bottom auto-scroll", () => {
  function mockViewportMetrics(
    viewport: HTMLElement,
    metrics: { scrollHeight: number; clientHeight: number; scrollTop?: number },
  ) {
    Object.defineProperty(viewport, "scrollHeight", { configurable: true, get: () => metrics.scrollHeight });
    Object.defineProperty(viewport, "clientHeight", { configurable: true, get: () => metrics.clientHeight });
    let top = metrics.scrollTop ?? 0;
    Object.defineProperty(viewport, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = value;
      },
    });
  }

  function getViewport(container: HTMLElement): HTMLElement {
    const viewport = container.querySelector("[data-radix-scroll-area-viewport]");
    if (!(viewport instanceof HTMLElement)) throw new Error("missing ScrollArea viewport");
    return viewport;
  }

  it("pins scrollTop to the bottom when messages grow while already near the bottom", () => {
    const question: ChatMessage[] = [{ id: "u1", role: "user", content: "q1", timestamp: "2026-07-16T08:00:00.000Z" }];
    const { container, rerender } = render(<MessageList messages={question} />);
    const viewport = getViewport(container);
    mockViewportMetrics(viewport, { scrollHeight: 400, clientHeight: 200, scrollTop: 200 });

    const answered: ChatMessage[] = [
      ...question,
      { id: "a1", role: "assistant", content: "a1", timestamp: "2026-07-16T08:00:01.000Z" },
    ];
    mockViewportMetrics(viewport, { scrollHeight: 600, clientHeight: 200, scrollTop: viewport.scrollTop });
    rerender(<MessageList messages={answered} />);
    expect(viewport.scrollTop).toBe(400); // scrollHeight - clientHeight
  });

  it("does not yank scrollTop when the operator has scrolled away from the bottom", () => {
    const question: ChatMessage[] = [{ id: "u1", role: "user", content: "q1", timestamp: "2026-07-16T08:00:00.000Z" }];
    const { container, rerender } = render(<MessageList messages={question} />);
    const viewport = getViewport(container);
    mockViewportMetrics(viewport, { scrollHeight: 600, clientHeight: 200, scrollTop: 0 });
    viewport.dispatchEvent(new Event("scroll"));

    const answered: ChatMessage[] = [
      ...question,
      { id: "a1", role: "assistant", content: "a1", timestamp: "2026-07-16T08:00:01.000Z" },
    ];
    mockViewportMetrics(viewport, { scrollHeight: 800, clientHeight: 200, scrollTop: 0 });
    rerender(<MessageList messages={answered} />);
    expect(viewport.scrollTop).toBe(0);
  });

  it("keeps pinning while a streaming footer grows (ResizeObserver path)", async () => {
    const { container, rerender } = render(
      <MessageList messages={singleMessage} footer={<div data-testid="stream-foot">hi</div>} />,
    );
    const viewport = getViewport(container);
    mockViewportMetrics(viewport, { scrollHeight: 300, clientHeight: 200, scrollTop: 100 });

    rerender(
      <MessageList
        messages={singleMessage}
        footer={<div data-testid="stream-foot">hi there, a longer streamed answer</div>}
      />,
    );
    mockViewportMetrics(viewport, { scrollHeight: 500, clientHeight: 200, scrollTop: viewport.scrollTop });
    // Re-trigger layout effect via composing toggle (footer already remounted).
    rerender(
      <MessageList
        messages={singleMessage}
        composing
        footer={<div data-testid="stream-foot">hi there, a longer streamed answer</div>}
      />,
    );
    expect(viewport.scrollTop).toBe(300);
  });
});

describe("MessageBubble (#6515) — role-color + avatar branches", () => {
  const base: ChatMessage = {
    id: "x",
    role: "assistant",
    content: "hello world",
    timestamp: "2026-07-16T08:00:00.000Z",
  };

  it("applies a distinct role-colored background per role, from theme tokens only", () => {
    const roleToClass: Record<ChatMessage["role"], string> = {
      user: "bg-primary",
      assistant: "bg-muted",
      system: "bg-secondary",
    };
    for (const [role, cls] of Object.entries(roleToClass) as [ChatMessage["role"], string][]) {
      const { unmount } = render(<MessageBubble message={{ ...base, role, content: `c-${role}` }} />);
      expect(screen.getByText(`c-${role}`).className).toContain(cls);
      unmount();
    }
  });

  it("renders the initials fallback from the author name (or role when unnamed)", () => {
    const { unmount } = render(<MessageBubble message={{ ...base, authorName: "operator" }} />);
    expect(screen.getByText("OP")).toBeTruthy();
    unmount();
    render(<MessageBubble message={base} />); // no authorName → falls back to the role
    expect(screen.getByText("AS")).toBeTruthy();
  });

  it("renders no <img> and shows the initials fallback when no avatarUrl is given", () => {
    const { container } = render(<MessageBubble message={base} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("AS")).toBeTruthy();
  });

  it("accepts an avatarUrl without breaking the fallback path", () => {
    // Radix AvatarImage mounts the real <img> only after it loads (which never happens in jsdom), so the
    // initials fallback is the state that renders here — exercising the avatarUrl-present branch safely.
    render(
      <MessageBubble message={{ ...base, role: "user", authorName: "operator", avatarUrl: "https://a.test/o.png" }} />,
    );
    expect(screen.getByText("OP")).toBeTruthy();
  });

  it("renders a machine-readable timestamp", () => {
    render(<MessageBubble message={base} />);
    const time = document.querySelector("time");
    expect(time?.getAttribute("dateTime")).toBe(base.timestamp);
  });
});

describe("TypingIndicator (#6515) — composing branches + accessible name", () => {
  it("renders a typing-specific accessible name (not 'loading') when composing", () => {
    render(<TypingIndicator composing authorName="LoopOver" />);
    const status = screen.getByRole("status", { name: /LoopOver is typing/i });
    expect(status).toBeTruthy();
    expect(status.getAttribute("aria-label")).toMatch(/typing/i);
    expect(status.getAttribute("aria-label")).not.toMatch(/loading/i);
  });

  it("renders nothing when not composing", () => {
    const { container } = render(<TypingIndicator composing={false} />);
    expect(container.firstChild).toBeNull();
  });
});
