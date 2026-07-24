import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "./pagination";

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
