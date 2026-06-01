import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

export interface Crumb {
  to?: string;
  label: string;
}

/**
 * Consistent breadcrumb rail used on /app, /docs, /api headers.
 * The last crumb is always rendered as the current page (no link).
 */
export function Breadcrumbs({ items, className }: { items: Crumb[]; className?: string }) {
  return (
    <nav
      aria-label="Breadcrumb"
      className={cn("flex items-center gap-1.5 text-token-xs", className)}
    >
      <ol className="flex flex-wrap items-center gap-1.5">
        {items.map((c, i) => {
          const last = i === items.length - 1;
          return (
            <li key={`${c.label}-${i}`} className="flex items-center gap-1.5">
              {i > 0 && <ChevronRight aria-hidden className="size-3 text-muted-foreground/60" />}
              {!last && c.to ? (
                <Link
                  to={c.to}
                  className="rounded-token text-muted-foreground transition-colors duration-150 hover:text-foreground focus-ring"
                >
                  {c.label}
                </Link>
              ) : (
                <span
                  aria-current={last ? "page" : undefined}
                  className={cn(last ? "font-medium text-foreground" : "text-muted-foreground")}
                >
                  {c.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
