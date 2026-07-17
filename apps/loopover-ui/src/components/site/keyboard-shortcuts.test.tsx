import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #6811: app-shell.tsx registers its own "g <key>" handler for /app/* SPA navigation. This site-wide
// handler used to fire alongside it unconditionally, racing a hard `window.location.assign` against the
// SPA navigation on the same "g r" / "g a" keystrokes. Control the reported route via a mocked useLocation.
const { useLocation } = vi.hoisted(() => ({ useLocation: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  useLocation: () => useLocation(),
}));

import { KeyboardShortcutsDialog } from "./keyboard-shortcuts";

function pressKeys(...keys: string[]) {
  for (const key of keys) {
    fireEvent.keyDown(window, { key });
  }
}

describe("KeyboardShortcutsDialog g-prefix navigation (#6811)", () => {
  let assign: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    assign = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, assign },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not hard-navigate on 'g r' while an /app/* route is mounted", () => {
    useLocation.mockReturnValue({ pathname: "/app/runs" });
    render(<KeyboardShortcutsDialog />);

    pressKeys("g", "r");

    // AppShell's own handler owns this keystroke on /app/* routes; the site-wide handler must stay inert.
    expect(assign).not.toHaveBeenCalled();
  });

  it("does not hard-navigate on 'g a' while an /app/* route is mounted", () => {
    useLocation.mockReturnValue({ pathname: "/app/analytics" });
    render(<KeyboardShortcutsDialog />);

    pressKeys("g", "a");

    expect(assign).not.toHaveBeenCalled();
  });

  it("still hard-navigates on 'g r' outside /app/*", () => {
    useLocation.mockReturnValue({ pathname: "/docs" });
    render(<KeyboardShortcutsDialog />);

    pressKeys("g", "r");

    expect(assign).toHaveBeenCalledWith("/api");
  });

  it("advertises the in-app destinations instead of the site-wide ones while on /app/*", () => {
    useLocation.mockReturnValue({ pathname: "/app/runs" });
    render(<KeyboardShortcutsDialog />);

    fireEvent.click(screen.getByRole("button", { name: "Open keyboard shortcuts" }));

    expect(screen.getByText("Go to runs")).toBeTruthy();
    expect(screen.queryByText("Go to API reference")).toBeNull();
  });

  it("advertises the site-wide destinations outside /app/*", () => {
    useLocation.mockReturnValue({ pathname: "/docs" });
    render(<KeyboardShortcutsDialog />);

    fireEvent.click(screen.getByRole("button", { name: "Open keyboard shortcuts" }));

    expect(screen.getByText("Go to API reference")).toBeTruthy();
    expect(screen.queryByText("Go to runs")).toBeNull();
  });
});
