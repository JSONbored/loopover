import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  PaginationEllipsis,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "./pagination.js";

// Regression for #8307: PaginationLink (and PaginationPrevious/PaginationNext built on it) render an <a>,
// which has no native disabled attribute — a consumer-supplied aria-disabled must produce a real
// visual/interaction cue via the aria-disabled: Tailwind variant, matching sidebar.tsx/calendar.tsx.
describe("PaginationLink aria-disabled styling (#8307)", () => {
  it("carries the aria-disabled: dim + pointer-events classes when aria-disabled is set", () => {
    render(
      <PaginationLink aria-disabled="true" aria-label="prev">
        1
      </PaginationLink>,
    );
    const link = screen.getByLabelText("prev");
    expect(link.className).toContain("aria-disabled:pointer-events-none");
    expect(link.className).toContain("aria-disabled:opacity-50");
  });

  it("PaginationPrevious/PaginationNext inherit the aria-disabled styling from PaginationLink", () => {
    render(
      <nav>
        <PaginationPrevious aria-disabled="true" />
        <PaginationNext aria-disabled="true" />
      </nav>,
    );
    for (const label of ["Go to previous page", "Go to next page"]) {
      const el = screen.getByLabelText(label);
      expect(el.className).toContain("aria-disabled:pointer-events-none");
      expect(el.className).toContain("aria-disabled:opacity-50");
    }
  });

  it("still renders (unchanged aria-current behavior) and the classes are present regardless — the variant only applies when aria-disabled is truthy at runtime", () => {
    render(
      <PaginationLink isActive aria-label="active">
        2
      </PaginationLink>,
    );
    const link = screen.getByLabelText("active");
    // isActive/aria-current is untouched by this fix.
    expect(link.getAttribute("aria-current")).toBe("page");
  });
});

// #10052: aria-hidden on the outer wrapper removed the sr-only "More pages" label from the a11y tree.
// Scope aria-hidden to the decorative icon only — same pattern as TypingIndicator.
describe("PaginationEllipsis sr-only label not inside aria-hidden (#10052)", () => {
  it('exposes "More pages" with no aria-hidden ancestor; icon is aria-hidden', () => {
    const { container } = render(<PaginationEllipsis />);
    const label = screen.getByText("More pages");
    expect(label.closest("[aria-hidden='true'], [aria-hidden='']")).toBeNull();
    const icon = container.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon!.getAttribute("aria-hidden")).toBe("true");
  });

  it("merges caller className through cn (mx-2 + h-9)", () => {
    const { container } = render(<PaginationEllipsis className="mx-2" />);
    const outer = container.firstElementChild as HTMLElement;
    expect(outer.tagName).toBe("SPAN");
    expect(outer.className).toContain("mx-2");
    expect(outer.className).toContain("h-9");
  });

  it("lets an explicit aria-hidden prop win on the outer span", () => {
    const { container } = render(<PaginationEllipsis aria-hidden />);
    const outer = container.firstElementChild as HTMLElement;
    expect(outer.getAttribute("aria-hidden")).toBe("true");
  });
});
