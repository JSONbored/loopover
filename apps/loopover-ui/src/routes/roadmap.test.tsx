import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

// jsdom has no IntersectionObserver; RoadmapPage wraps its content in <Reveal>, a framer-motion
// viewport-triggered animation that needs one to mount. No other test in this file tree renders
// Reveal yet, so there's no existing global stub to reuse -- a minimal no-op observer is enough,
// since the tests here only assert on rendered link hrefs, not the reveal animation itself.
class MockIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);

// Stub TanStack Router the same way install.permissions.test.tsx does: Link becomes a plain <a>
// carrying the resolved `to` as its href, so the rendered destination can be asserted directly.
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({}),
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

import { RoadmapPage } from "./roadmap";

// #8669: the "Phase 3: repo owner intake console" card linked to /app/repos, which defaults to the
// Maintainer console tab (app.repos.tsx:27) with no search param -- the opposite surface from what
// the card describes. Locks in the fix to the dedicated /app/owner route, and guards that no other
// phase's link moved as a side effect.
describe("RoadmapPage phase links (#8669)", () => {
  it("routes the repo owner intake console card to the dedicated Owner workspace, not the Maintainer tab", () => {
    render(<RoadmapPage />);
    const link = screen.getByRole("link", { name: /Open repos console/i });
    expect(link.getAttribute("href")).toBe("/app/owner");
  });

  it("leaves the maintainer trust card's link unchanged (sibling regression guard)", () => {
    render(<RoadmapPage />);
    const link = screen.getByRole("link", { name: /Open maintainer console/i });
    expect(link.getAttribute("href")).toBe("/app/maintainer");
  });
});
