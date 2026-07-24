import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TablePagination } from "./table-pagination";

describe("TablePagination (#8306)", () => {
  it("renders a numbered link per page and disables Previous on the first page", () => {
    const onPageChange = vi.fn();
    render(<TablePagination page={0} pageCount={3} onPageChange={onPageChange} />);

    expect(screen.getByRole("navigation", { name: /pagination/i })).toBeTruthy();
    expect(screen.getByRole("link", { name: "1" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "3" })).toBeTruthy();

    // On the first page Previous is aria-disabled; Next is not.
    expect(screen.getByRole("link", { name: /go to previous page/i }).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("link", { name: /go to next page/i }).getAttribute("aria-disabled")).toBe("false");
  });

  it("invokes onPageChange for numbered, Next and Previous clicks (clamping at the low boundary)", () => {
    const onPageChange = vi.fn();
    render(<TablePagination page={0} pageCount={3} onPageChange={onPageChange} />);

    fireEvent.click(screen.getByRole("link", { name: "2" }));
    expect(onPageChange).toHaveBeenLastCalledWith(1);

    fireEvent.click(screen.getByRole("link", { name: /go to next page/i }));
    expect(onPageChange).toHaveBeenLastCalledWith(1);

    // Previous from page 0 clamps to 0 rather than going negative.
    fireEvent.click(screen.getByRole("link", { name: /go to previous page/i }));
    expect(onPageChange).toHaveBeenLastCalledWith(0);
  });

  it("disables Next on the last page and clamps Next at the high boundary", () => {
    const onPageChange = vi.fn();
    render(<TablePagination page={2} pageCount={3} onPageChange={onPageChange} />);

    expect(screen.getByRole("link", { name: /go to previous page/i }).getAttribute("aria-disabled")).toBe("false");
    expect(screen.getByRole("link", { name: /go to next page/i }).getAttribute("aria-disabled")).toBe("true");

    // Next from the last page clamps to the last page rather than overshooting pageCount - 1.
    fireEvent.click(screen.getByRole("link", { name: /go to next page/i }));
    expect(onPageChange).toHaveBeenLastCalledWith(2);

    fireEvent.click(screen.getByRole("link", { name: /go to previous page/i }));
    expect(onPageChange).toHaveBeenLastCalledWith(1);
  });
});
