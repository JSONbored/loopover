import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DocsToc, type TocHeading } from "./docs-toc";

// #9872: the rail used to scan the rendered `article.prose-docs` for h2/h3 and read the result into state
// from an effect. It renders the page's COMPILED toc now, so these drive it the way the app does -- by
// handing it items -- and pin the properties the DOM scrape used to provide implicitly.

vi.mock("@tanstack/react-router", () => ({
  useLocation: () => ({ pathname: "/docs/example" }),
  useChildMatches: () => [],
}));

const items: TocHeading[] = [
  { id: "first", text: "First section", level: 2 },
  { id: "second", text: "Second section", level: 2 },
  { id: "nested", text: "Nested", level: 3 },
];

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords() {
        return [];
      }
      root = null;
      rootMargin = "";
      thresholds = [];
    },
  );
});

describe("DocsToc (#9872)", () => {
  it("renders one link per compiled toc entry, anchored to its id", () => {
    render(<DocsToc items={items} />);
    expect(screen.getByRole("link", { name: "First section" }).getAttribute("href")).toBe("#first");
    expect(screen.getByRole("link", { name: "Nested" }).getAttribute("href")).toBe("#nested");
  });

  it("renders a heading's inline markup instead of flattening it", () => {
    // The concrete gain over the DOM scrape, which read `textContent`: 29 of this repo's docs headings
    // carry inline code, and the rail used to show them as bare text.
    render(
      <DocsToc
        items={[
          { id: "a", text: <code>wantedPaths</code>, level: 3 },
          { id: "b", text: "Plain", level: 2 },
        ]}
      />,
    );
    expect(screen.getByRole("link", { name: "wantedPaths" }).querySelector("code")).not.toBeNull();
  });

  it("indents depth-3 entries and leaves depth-2 flush", () => {
    render(<DocsToc items={items} />);
    expect(screen.getByRole("link", { name: "Nested" }).closest("li")?.className).toContain("pl-3");
    expect(
      screen.getByRole("link", { name: "First section" }).closest("li")?.className,
    ).not.toContain("pl-3");
  });

  it("renders nothing for a page with fewer than two headings — a one-item rail is noise", () => {
    const { container } = render(<DocsToc items={[items[0]!]} />);
    expect(container.firstChild).toBeNull();
    expect(render(<DocsToc items={[]} />).container.firstChild).toBeNull();
  });

  it("marks the remembered section current on first render, without an effect", () => {
    // Restored during render from localStorage rather than set from an effect, which is what lets
    // react-hooks/set-state-in-effect go back to `error`.
    window.localStorage.setItem("docs-toc:v2:/docs/example", "second");
    render(<DocsToc items={items} />);
    expect(screen.getByRole("link", { name: "Second section" }).getAttribute("aria-current")).toBe(
      "location",
    );
    expect(
      screen.getByRole("link", { name: "First section" }).getAttribute("aria-current"),
    ).toBeNull();
  });

  it("ignores a remembered section that is not on this page", () => {
    window.localStorage.setItem("docs-toc:v2:/docs/example", "from-a-different-page");
    render(<DocsToc items={items} />);
    for (const item of items)
      expect(
        screen.getByRole("link", { name: String(item.text) }).getAttribute("aria-current"),
      ).toBeNull();
  });

  it("survives localStorage throwing (Safari private mode)", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(() => render(<DocsToc items={items} />)).not.toThrow();
    getItem.mockRestore();
  });
});
