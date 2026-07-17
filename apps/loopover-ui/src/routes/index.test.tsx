import { render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { ClientSetupTabs } from "./index";

// #6813: ClientSetupTabs (the homepage install-snippet tabs) rendered a hand-rolled role="tablist" with
// no onKeyDown -- every other tabbed UI in this codebase gets arrow-key/Home/End navigation for free from
// the shared Radix-backed Tabs primitive. This is the regression test for that gap.

describe("ClientSetupTabs keyboard navigation (#6813)", () => {
  // ClientSetupTabs persists the active tab to localStorage ("gt:install-tab") and reads it back as the
  // initial state on mount -- without clearing it, a later test's initial "miners" tab assumption breaks
  // because an earlier test in this file left a different tab persisted.
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("ArrowRight moves to and activates the next tab, wrapping past the last", () => {
    render(<ClientSetupTabs />);
    const minerTab = screen.getByRole("tab", { name: /Miner CLI/i });
    const codexTab = screen.getByRole("tab", { name: /Codex/i });
    minerTab.focus();

    fireEvent.keyDown(minerTab, { key: "ArrowRight" });

    expect(document.activeElement).toBe(codexTab);
    expect(codexTab.getAttribute("aria-selected")).toBe("true");
    expect(minerTab.getAttribute("aria-selected")).toBe("false");

    // Arrow through the remaining tabs (claude, cursor, remote) and wrap back to the first (miners).
    fireEvent.keyDown(codexTab, { key: "ArrowRight" });
    fireEvent.keyDown(screen.getByRole("tab", { name: /Claude Desktop/i }), { key: "ArrowRight" });
    fireEvent.keyDown(screen.getByRole("tab", { name: /Cursor/i }), { key: "ArrowRight" });
    const remoteTab = screen.getByRole("tab", { name: /Remote MCP/i });
    fireEvent.keyDown(remoteTab, { key: "ArrowRight" });

    expect(document.activeElement).toBe(minerTab);
    expect(minerTab.getAttribute("aria-selected")).toBe("true");
  });

  it("ArrowLeft moves to the previous tab, wrapping before the first", () => {
    render(<ClientSetupTabs />);
    const minerTab = screen.getByRole("tab", { name: /Miner CLI/i });
    minerTab.focus();

    fireEvent.keyDown(minerTab, { key: "ArrowLeft" });

    const remoteTab = screen.getByRole("tab", { name: /Remote MCP/i });
    expect(document.activeElement).toBe(remoteTab);
    expect(remoteTab.getAttribute("aria-selected")).toBe("true");
  });

  it("Home jumps to the first tab and End jumps to the last", () => {
    render(<ClientSetupTabs />);
    const cursorTab = screen.getByRole("tab", { name: /Cursor/i });
    cursorTab.focus();

    fireEvent.keyDown(cursorTab, { key: "End" });
    const remoteTab = screen.getByRole("tab", { name: /Remote MCP/i });
    expect(document.activeElement).toBe(remoteTab);
    expect(remoteTab.getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(remoteTab, { key: "Home" });
    const minerTab = screen.getByRole("tab", { name: /Miner CLI/i });
    expect(document.activeElement).toBe(minerTab);
    expect(minerTab.getAttribute("aria-selected")).toBe("true");
  });

  it("keeps only the active tab in the page tab order (roving tabindex)", () => {
    render(<ClientSetupTabs />);
    const minerTab = screen.getByRole("tab", { name: /Miner CLI/i });
    const codexTab = screen.getByRole("tab", { name: /Codex/i });

    expect(minerTab.getAttribute("tabIndex")).toBe("0");
    expect(codexTab.getAttribute("tabIndex")).toBe("-1");

    fireEvent.keyDown(minerTab, { key: "ArrowRight" });

    expect(minerTab.getAttribute("tabIndex")).toBe("-1");
    expect(codexTab.getAttribute("tabIndex")).toBe("0");
  });

  it("a non-navigation key is left untouched (no tab change)", () => {
    render(<ClientSetupTabs />);
    const minerTab = screen.getByRole("tab", { name: /Miner CLI/i });
    minerTab.focus();

    fireEvent.keyDown(minerTab, { key: "a" });

    expect(minerTab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(minerTab);
  });

  it("clicking a tab still activates it (native button behavior, unaffected by the keyboard handler)", () => {
    render(<ClientSetupTabs />);
    const codexTab = screen.getByRole("tab", { name: /Codex/i });

    fireEvent.click(codexTab);

    expect(codexTab.getAttribute("aria-selected")).toBe("true");
  });
});
