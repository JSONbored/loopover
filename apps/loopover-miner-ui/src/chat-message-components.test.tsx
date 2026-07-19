import { render, screen, waitFor } from "@testing-library/react";
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
    // separate StreamingText outside this list) never mutate `messages`.
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

describe("MessageList (#7229) — auto-follow the newest content", () => {
  const line = (id: string, content: string): ChatMessage => ({
    id,
    role: "assistant",
    content,
    timestamp: "2026-07-16T08:00:00.000Z",
  });

  // jsdom does not lay out; scrollHeight/clientHeight default to 0. Fake an overflowing viewport so the
  // scroll-position side effect is observable (scrollTop is a real writable/readable property in jsdom).
  function fakeOverflow(viewport: HTMLElement, scrollHeight = 1000, clientHeight = 200): void {
    Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: scrollHeight });
    Object.defineProperty(viewport, "clientHeight", { configurable: true, value: clientHeight });
  }

  const viewportOf = (container: HTMLElement) =>
    container.querySelector<HTMLElement>("[data-radix-scroll-area-viewport]")!;

  it("scrolls to the bottom when a new message is committed and the reader is at the bottom", async () => {
    const initial = [line("a1", "one"), line("a2", "two")];
    const { container, rerender } = render(<MessageList messages={initial} />);
    const viewport = viewportOf(container);
    fakeOverflow(viewport);

    rerender(<MessageList messages={[...initial, line("a3", "three")]} />);

    await waitFor(() => expect(viewport.scrollTop).toBe(1000));
  });

  it("leaves the scroll position alone when the reader has scrolled up (#7229)", async () => {
    const initial = [line("a1", "one"), line("a2", "two")];
    const { container, rerender } = render(<MessageList messages={initial} />);
    const viewport = viewportOf(container);
    fakeOverflow(viewport);

    // The operator scrolls up to re-read history: a following message must not yank them back down.
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event("scroll"));

    rerender(<MessageList messages={[...initial, line("a3", "three")]} />);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(viewport.scrollTop).toBe(0);
  });

  it("follows a growing footer (the live streaming render) while pinned to the bottom", async () => {
    const initial = [line("a1", "one")];
    const { container, rerender } = render(<MessageList messages={initial} />);
    const viewport = viewportOf(container);
    fakeOverflow(viewport);

    // A streaming footer whose text keeps growing is the second trigger the same follow mechanism covers.
    rerender(<MessageList messages={initial} footer={<p data-testid="stream">partial</p>} />);
    await waitFor(() => expect(viewport.scrollTop).toBe(1000));

    viewport.scrollTop = 0;
    rerender(<MessageList messages={initial} footer={<p data-testid="stream">partial answer</p>} />);
    await waitFor(() => expect(viewport.scrollTop).toBe(1000));
    expect(screen.getByTestId("stream").textContent).toBe("partial answer");
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
