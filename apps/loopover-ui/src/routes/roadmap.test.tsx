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

// #9182: the page was frozen at a stale snapshot referencing the closed v1 phase epics
// (#233-#238). Guards that those numbers never reappear, and that every rendered item links to
// its real, live GitHub issue instead.
describe("RoadmapPage content (#9182)", () => {
  it("never references the closed, ancient phase issues #233-#238", () => {
    render(<RoadmapPage />);
    for (const staleIssue of [233, 234, 235, 236, 237, 238]) {
      expect(
        screen.queryByRole("link", { name: new RegExp(`Issue #${staleIssue}\\b`) }),
      ).toBeNull();
    }
  });

  it("links every card to its real, open GitHub issue", () => {
    render(<RoadmapPage />);
    const expected: Record<string, number> = {
      "Rent-a-Loop: hosted development loops": 4778,
      "ORB cloud readiness": 4877,
      "Hosted AMS chat platform": 9184,
      "ORB maintainer chat platform": 9183,
      "Hosted bare-metal execution plane": 8534,
      "PostHog observability consolidation": 8286,
    };

    for (const [title, issue] of Object.entries(expected)) {
      const heading = screen.getByRole("heading", { name: title });
      // The card is the outer wrapper (the ".group" hover-target div), not the heading's
      // immediate parent (a plain flex row shared with the "Tracked" badge).
      const card = heading.closest("div.group");
      expect(card).not.toBeNull();
      const issueLink = card!.querySelector(
        `a[href="https://github.com/JSONbored/loopover/issues/${issue}"]`,
      );
      expect(issueLink).not.toBeNull();
    }
  });

  it("renders the three roadmap columns", () => {
    render(<RoadmapPage />);
    expect(screen.getByText("Now")).toBeTruthy();
    expect(screen.getByText("Next")).toBeTruthy();
    expect(screen.getByText("Later")).toBeTruthy();
  });

  it("links out to the live GitHub milestones list, not a closed roadmap issue", () => {
    render(<RoadmapPage />);
    const link = screen.getByRole("link", { name: /See all milestones/i });
    expect(link.getAttribute("href")).toBe("https://github.com/JSONbored/loopover/milestones");
  });
});
