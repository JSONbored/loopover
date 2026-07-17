import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({}),
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ClientSetupTabs } from "./index";

const STORAGE_KEY = "gt:install-tab";

function selectedTabName(): string | null {
  return screen.getByRole("tab", { selected: true }).textContent;
}

describe("homepage install-tab SSR-safe hydration (#6814)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("renders the same markup with or without a saved tab, so hydration cannot mismatch", () => {
    // The real invariant. The server has no `window` and always emits "miners"; the client's first render
    // must agree. Reading localStorage in a useState initializer broke that for a returning visitor,
    // because the initializer ran during the very first render. renderToString is the only way to observe
    // that first paint -- testing-library's render() wraps in act(), which flushes the mount effect before
    // any assertion can see the pre-effect markup.
    const withoutSaved = renderToString(<ClientSetupTabs />);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify("cursor"));
    const withSaved = renderToString(<ClientSetupTabs />);
    expect(withSaved).toBe(withoutSaved);
    expect(withSaved).toContain('aria-selected="true"');
  });

  it("applies the saved tab after mount, once hydration is safely past", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify("cursor"));
    render(<ClientSetupTabs />);
    await waitFor(() => expect(selectedTabName()).toContain("Cursor"));
  });

  it("stays on the default tab when nothing is saved", async () => {
    render(<ClientSetupTabs />);
    expect(selectedTabName()).toContain("Miners");
    // Give the mount-time read a chance to land before asserting it changed nothing.
    await waitFor(() => expect(selectedTabName()).toContain("Miners"));
  });

  it("persists a clicked tab so the next visit restores it", async () => {
    render(<ClientSetupTabs />);
    fireEvent.click(screen.getByRole("tab", { name: /Claude/i }));
    await waitFor(() => expect(selectedTabName()).toContain("Claude"));
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify("claude"));
  });

  it("falls back to the default when the stored value is unreadable", async () => {
    // Pre-#6814 the tab was written as a bare string. "cursor" is not valid JSON, so the hook's read throws
    // and the component degrades to the default -- a one-time reset for a returning visitor rather than a
    // broken tab. Deliberately a NON-default value: storing "miners" here would pass even if the fallback
    // were broken.
    window.localStorage.setItem(STORAGE_KEY, "cursor");
    render(<ClientSetupTabs />);
    await waitFor(() => expect(selectedTabName()).toContain("Miners"));
    // And the reset is self-healing: the next write lands in the hook's JSON format.
    fireEvent.click(screen.getByRole("tab", { name: /Codex/i }));
    await waitFor(() => expect(window.localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify("codex")));
  });
});
