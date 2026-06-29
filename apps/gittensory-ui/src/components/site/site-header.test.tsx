import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FocusEvent, ReactNode } from "react";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    className,
    onClick,
    onFocus,
    onBlur,
    activeProps: _activeProps,
    inactiveProps: _inactiveProps,
    ...props
  }: {
    to: string;
    children: ReactNode;
    className?: string;
    onClick?: () => void;
    onFocus?: () => void;
    onBlur?: (event: FocusEvent<HTMLAnchorElement>) => void;
    activeProps?: unknown;
    inactiveProps?: unknown;
  }) => (
    <a
      href={to}
      className={className}
      onClick={onClick}
      onFocus={onFocus}
      onBlur={onBlur}
      {...props}
    >
      {children}
    </a>
  ),
}));

vi.mock("./mcp-version-badge", () => ({ McpVersionBadge: () => null }));
vi.mock("./mark", () => ({ GittensoryMark: () => null }));
vi.mock("./command-palette", () => ({ CommandPalette: () => null }));
vi.mock("./github-stats-chip", () => ({ GithubStatsChip: () => null }));
vi.mock("./keyboard-shortcuts", () => ({ KeyboardShortcutsDialog: () => null }));

import { SiteHeader } from "@/components/site/site-header";

function docsHoverHost(): HTMLElement {
  const docsLink = screen.getByRole("link", { name: /^docs$/i });
  const host = docsLink.closest(".relative");
  if (!host) throw new Error("docs hover host not found");
  return host;
}

describe("SiteHeader docs dropdown", () => {
  it("opens on hover and bridges the trigger gap with padding instead of margin", () => {
    render(<SiteHeader />);
    fireEvent.mouseEnter(docsHoverHost());

    expect(screen.getByRole("link", { name: /quickstart/i })).toBeTruthy();

    const bridge = screen.getByRole("link", { name: /quickstart/i }).closest(".absolute.top-full");
    expect(bridge).toBeTruthy();
    expect(bridge?.className).toContain("pt-3");
    expect(bridge?.className).not.toContain("mt-3");
  });

  it("keeps the dropdown mounted while the pointer moves into the padded bridge", () => {
    render(<SiteHeader />);
    const host = docsHoverHost();
    fireEvent.mouseEnter(host);

    const bridge = screen.getByRole("link", { name: /quickstart/i }).closest(".absolute.top-full");
    expect(bridge).toBeTruthy();
    fireEvent.mouseEnter(bridge!);

    expect(screen.getByRole("link", { name: /troubleshooting/i })).toBeTruthy();
  });

  it("closes the dropdown when the pointer leaves the docs hover host", () => {
    render(<SiteHeader />);
    const host = docsHoverHost();
    fireEvent.mouseEnter(host);
    expect(screen.getByRole("link", { name: /quickstart/i })).toBeTruthy();

    fireEvent.mouseLeave(host);
    expect(screen.queryByRole("link", { name: /quickstart/i })).toBeNull();
  });
});
