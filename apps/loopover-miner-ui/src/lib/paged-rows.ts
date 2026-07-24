import { useState } from "react";

/** Rows per page a table shows once it grows past this many rows; below it the full list renders unpaginated. */
export const PAGE_SIZE = 20;

export interface PagedRows<T> {
  /** The current page's slice of `rows` (the full list when `isPaginated` is false). */
  visible: T[];
  /** True once `rows` exceeds `pageSize`; the pager is only meant to render in this case. */
  isPaginated: boolean;
  /** The active page index, always clamped into `[0, pageCount - 1]`. */
  page: number;
  /** Total number of pages (at least 1). */
  pageCount: number;
  /** Sets the desired page index; it is clamped on the next render. */
  setPage: (n: number) => void;
}

/**
 * Generic client-side pager shared across the miner-ui tables (#8306): slices `rows` into
 * `pageSize`-sized pages and exposes only the current page's `visible` slice plus the state a pager needs.
 * Below `pageSize` rows the full list renders unpaginated (`isPaginated === false`). The returned `page`
 * is clamped via `Math.min(page, pageCount - 1)`, so it stays valid even after `rows` shrinks below the
 * current page's start index.
 */
export function usePagedRows<T>(rows: T[], pageSize: number = PAGE_SIZE): PagedRows<T> {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const isPaginated = rows.length > pageSize;
  const safePage = Math.min(page, pageCount - 1);
  const visible = isPaginated ? rows.slice(safePage * pageSize, safePage * pageSize + pageSize) : rows;
  return { visible, isPaginated, page: safePage, pageCount, setPage };
}
