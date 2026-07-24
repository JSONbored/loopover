import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PAGE_SIZE, usePagedRows } from "./paged-rows";

describe("usePagedRows (#8306)", () => {
  it("does not paginate an empty list — one page, empty slice, no clamping", () => {
    const { result } = renderHook(() => usePagedRows<number>([], 2));
    expect(result.current.isPaginated).toBe(false);
    expect(result.current.pageCount).toBe(1);
    expect(result.current.page).toBe(0);
    expect(result.current.visible).toEqual([]);
  });

  it("returns the full list unpaginated when rows fit within a single page (at or below the size)", () => {
    // Exactly `pageSize` rows is still a single page: the `rows.length > pageSize` boundary is exclusive.
    const rows = [0, 1, 2, 3];
    const { result } = renderHook(() => usePagedRows(rows, 4));
    expect(result.current.isPaginated).toBe(false);
    expect(result.current.pageCount).toBe(1);
    expect(result.current.visible).toBe(rows);
  });

  it("slices rows across multiple pages and follows setPage", () => {
    const rows = [0, 1, 2, 3, 4];
    const { result } = renderHook(() => usePagedRows(rows, 2));
    expect(result.current.isPaginated).toBe(true);
    expect(result.current.pageCount).toBe(3);
    expect(result.current.page).toBe(0);
    expect(result.current.visible).toEqual([0, 1]);

    act(() => result.current.setPage(2));
    expect(result.current.page).toBe(2);
    expect(result.current.visible).toEqual([4]);
  });

  it("clamps the active page when rows shrink below the current page's start index", () => {
    const { result, rerender } = renderHook(({ rows }: { rows: number[] }) => usePagedRows(rows, 2), {
      initialProps: { rows: [0, 1, 2, 3, 4, 5] },
    });
    act(() => result.current.setPage(2));
    expect(result.current.page).toBe(2);
    expect(result.current.visible).toEqual([4, 5]);

    // The list shrinks to a single page's worth of rows: the stale page-2 index clamps back to the last page.
    rerender({ rows: [0, 1, 2] });
    expect(result.current.pageCount).toBe(2);
    expect(result.current.page).toBe(1);
    expect(result.current.visible).toEqual([2]);
  });

  it("defaults the page size to PAGE_SIZE (20) when no size is passed", () => {
    const rows = Array.from({ length: 25 }, (_, index) => index);
    const { result } = renderHook(() => usePagedRows(rows));
    expect(PAGE_SIZE).toBe(20);
    expect(result.current.isPaginated).toBe(true);
    expect(result.current.pageCount).toBe(2);
    expect(result.current.visible).toHaveLength(20);
    expect(result.current.visible[0]).toBe(0);
    expect(result.current.visible[19]).toBe(19);
  });
});
