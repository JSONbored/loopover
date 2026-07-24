import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@loopover/ui-kit/components/pagination";

/**
 * Shared presentational pager for the miner-ui tables (#8306): numbered page links plus boundary
 * Previous/Next controls, with `aria-disabled` on the first/last page. Pair it with `usePagedRows`,
 * rendering it only when `isPaginated` is true. Built on the existing `@loopover/ui-kit`
 * `Pagination` primitives — the primitive itself is intentionally left unchanged here.
 */
export function TablePagination({
  page,
  pageCount,
  onPageChange,
}: {
  page: number;
  pageCount: number;
  onPageChange: (next: number) => void;
}) {
  return (
    <Pagination className="mt-4">
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious
            href="#"
            aria-disabled={page === 0}
            onClick={(event) => {
              event.preventDefault();
              onPageChange(Math.max(0, page - 1));
            }}
          />
        </PaginationItem>
        {Array.from({ length: pageCount }).map((_, index) => (
          <PaginationItem key={index}>
            <PaginationLink
              href="#"
              isActive={index === page}
              onClick={(event) => {
                event.preventDefault();
                onPageChange(index);
              }}
            >
              {index + 1}
            </PaginationLink>
          </PaginationItem>
        ))}
        <PaginationItem>
          <PaginationNext
            href="#"
            aria-disabled={page >= pageCount - 1}
            onClick={(event) => {
              event.preventDefault();
              onPageChange(Math.min(pageCount - 1, page + 1));
            }}
          />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}
