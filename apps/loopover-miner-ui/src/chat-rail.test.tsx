import { fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The TanStack Router lib is not under test here — RootShell's own rail-state persistence is. Stub Link so the
// shell renders in isolation without a live RouterProvider (Link would otherwise throw for lack of a router
// context). The routed page is passed to RootShell as `children` in these tests.
vi.mock("@tanstack/react-router", async () => {
  const react = await import("react");
  return {
    createRootRoute: (options: unknown) => ({ options }),
    Outlet: () => null,
    Link: ({ children, to, ...rest }: { children?: React.ReactNode; to?: unknown }) =>
      react.createElement("a", { href: typeof to === "string" ? to : "#", ...rest }, children),
  };
});

// Stateful stub so the #7792 close/reopen test can assert in-rail React state survives the mobile sheet cycle
// without standing up the real chat backend / streaming stack.
vi.mock("./components/chat/conversation", () => ({
  ChatConversation: () => {
    const [draft, setDraft] = React.useState("");
    return <input aria-label="chat draft" value={draft} onChange={(event) => setDraft(event.target.value)} />;
  },
}));

import { ChatRail } from "./components/chat-rail";
import { RootShell } from "./routes/__root";

const originalInnerWidth = window.innerWidth;

// useIsMobile decides off window.innerWidth and needs window.matchMedia to exist (jsdom omits it). Set both so
// the same setViewport() call drives the docked-vs-sheet branch deterministically.
function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: width < 768,
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
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: originalInnerWidth });
  vi.unstubAllGlobals();
});

describe("ChatRail (#6513)", () => {
  it("docks a complementary panel (not a sheet) on a wide viewport when open", () => {
    setViewport(1200);
    render(<ChatRail open onOpenChange={vi.fn()} />);

    const panel = screen.getByRole("complementary", { name: /chat/i });
    expect(panel.getAttribute("data-state")).toBe("open");
    expect(screen.queryByRole("dialog")).toBeNull(); // docked, not the mobile sheet
  });

  it("hides the docked panel from the a11y tree when collapsed, keeping the toggle visible", () => {
    setViewport(1200);
    render(<ChatRail open={false} onOpenChange={vi.fn()} />);

    expect(screen.queryByRole("complementary")).toBeNull(); // collapsed → hidden
    expect(screen.getByRole("button", { name: /show chat/i })).toBeTruthy();
  });

  it("the toggle requests an open/close change on a wide viewport", () => {
    setViewport(1200);
    const onOpenChange = vi.fn();
    const { rerender } = render(<ChatRail open={false} onOpenChange={onOpenChange} />);

    fireEvent.click(screen.getByRole("button", { name: /show chat/i }));
    expect(onOpenChange).toHaveBeenLastCalledWith(true);

    rerender(<ChatRail open onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByRole("button", { name: /hide chat/i }));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("uses the ui-kit Sheet slide-over (not the docked panel) below the mobile breakpoint", () => {
    setViewport(400);
    render(<ChatRail open onOpenChange={vi.fn()} />);

    expect(screen.getByRole("dialog")).toBeTruthy(); // Sheet content
    expect(screen.queryByRole("complementary")).toBeNull(); // never the docked panel on mobile
  });

  it("preserves chat draft state across a mobile sheet close/reopen cycle (#7792)", () => {
    setViewport(400);
    const onOpenChange = vi.fn();
    const { rerender } = render(<ChatRail open onOpenChange={onOpenChange} />);

    const draft = screen.getByRole("textbox", { name: /chat draft/i });
    fireEvent.change(draft, { target: { value: "still typing…" } });
    expect((draft as HTMLInputElement).value).toBe("still typing…");

    // Close the sheet (same open=false transition accidental tap-outside / Escape / toggle would cause).
    rerender(<ChatRail open={false} onOpenChange={onOpenChange} />);
    // forceMount keeps the dialog content in the tree even while closed.
    expect(screen.getByRole("dialog", { hidden: true })).toBeTruthy();

    // Reopen — draft must still be there (RailBody never unmounted).
    rerender(<ChatRail open onOpenChange={onOpenChange} />);
    expect((screen.getByRole("textbox", { name: /chat draft/i }) as HTMLInputElement).value).toBe("still typing…");
  });
});

describe("RootShell chat-rail integration (#6513)", () => {
  it("mounts exactly one rail toggle and renders the routed content", () => {
    setViewport(1200);
    render(
      <RootShell>
        <div>Overview page</div>
      </RootShell>,
    );

    expect(screen.getByText("Overview page")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /chat/i })).toHaveLength(1); // mounted once
  });

  it("keeps the rail's open state across a simulated client-side navigation", () => {
    setViewport(1200);
    const { rerender } = render(
      <RootShell>
        <div>Overview page</div>
      </RootShell>,
    );

    fireEvent.click(screen.getByRole("button", { name: /show chat/i }));
    expect(screen.getByRole("complementary", { name: /chat/i })).toBeTruthy();

    // Navigate: the Outlet content swaps while RootShell stays mounted.
    rerender(
      <RootShell>
        <div>Portfolio page</div>
      </RootShell>,
    );
    expect(screen.getByText("Portfolio page")).toBeTruthy();
    expect(screen.queryByText("Overview page")).toBeNull();

    // Rail state survived the navigation.
    expect(screen.getByRole("complementary", { name: /chat/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /hide chat/i })).toBeTruthy();
  });
});
