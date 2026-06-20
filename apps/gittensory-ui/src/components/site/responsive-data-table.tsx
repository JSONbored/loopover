import { type ReactNode } from "react";

import { cn } from "@/lib/utils";

export type ResponsiveTableColumn<T> = {
  id: string;
  header: string;
  headerClassName?: string;
  cellClassName?: string;
  cell: (row: T) => ReactNode;
};

type ResponsiveDataTableProps<T> = {
  caption: string;
  columns: ResponsiveTableColumn<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  emptyMessage?: string;
  className?: string;
  tableClassName?: string;
};

/** Desktop table (md+) with a stacked card list on narrow viewports (#794). */
export function ResponsiveDataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  emptyMessage,
  className,
  tableClassName,
}: ResponsiveDataTableProps<T>) {
  if (rows.length === 0) {
    return emptyMessage ? (
      <p className="text-token-xs text-muted-foreground">{emptyMessage}</p>
    ) : null;
  }

  return (
    <>
      <div
        className={cn("hidden overflow-x-auto md:block", className)}
        role="region"
        aria-label={caption}
        tabIndex={0}
      >
        <table className={cn("min-w-[36rem] w-full text-left text-token-sm", tableClassName)}>
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b-hairline font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
              {columns.map((column) => (
                <th
                  key={column.id}
                  scope="col"
                  className={cn("py-2 pr-3 font-normal last:pr-0", column.headerClassName)}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr
                key={rowKey(row, index)}
                className="border-b-hairline last:border-b-0 transition-colors hover:bg-muted/40"
              >
                {columns.map((column) => (
                  <td
                    key={column.id}
                    className={cn("py-2 pr-3 align-top last:pr-0", column.cellClassName)}
                  >
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="space-y-3 md:hidden" aria-label={caption}>
        {rows.map((row, index) => (
          <li
            key={rowKey(row, index)}
            className="rounded-token border-hairline bg-background/40 p-3 transition-colors hover:border-strong"
          >
            <dl className="space-y-2">
              {columns.map((column) => (
                <div
                  key={column.id}
                  className="grid grid-cols-[minmax(5.5rem,34%)_1fr] gap-x-3 gap-y-1"
                >
                  <dt className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                    {column.header}
                  </dt>
                  <dd className={cn("min-w-0 text-token-sm", column.cellClassName)}>
                    {column.cell(row)}
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}
