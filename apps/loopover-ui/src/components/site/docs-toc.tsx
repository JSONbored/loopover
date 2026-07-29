import { useEffect, useState } from "react";
import { useLocation } from "@tanstack/react-router";

import { cn } from "@/lib/utils";

interface Heading {
  id: string;
  text: string;
  level: 2 | 3;
}

/** A stable empty list, so a route with no headings does not hand the renderer a fresh array each time. */
const EMPTY_HEADINGS: readonly Heading[] = Object.freeze([]);

/** localStorage so the rail recalls the last section across full reloads and tabs. */
const STORE_PREFIX = "docs-toc:v2:";

/**
 * Right-rail "On this page" table of contents.
 * Auto-scans the nearest <article> for h2 / h3 elements, assigns slug ids
 * if missing, and tracks the active section via IntersectionObserver.
 */
export function DocsToc() {
  // Both the headings and the active id belong to ONE route, so both are stored under that route's path
  // (#9588). Navigating therefore clears them by derivation -- a previous route's headings can never be
  // read, and aria-current can never linger on one -- instead of two setState calls at the top of the
  // effect below. The effect still runs: reading the rendered DOM and subscribing an IntersectionObserver
  // is external-system work, which is exactly what an effect is for.
  const [toc, setToc] = useState<{ path: string; items: readonly Heading[]; active: string }>({
    path: "",
    items: [],
    active: "",
  });
  const location = useLocation();
  const storageKey = `${STORE_PREFIX}${location.pathname}`;

  const forThisPath = toc.path === location.pathname ? toc : null;
  const items = forThisPath?.items ?? EMPTY_HEADINGS;
  const active = forThisPath?.active ?? "";

  useEffect(() => {
    const article = document.querySelector("article.prose-docs");
    if (!article) return;
    const nodes = Array.from(article.querySelectorAll<HTMLHeadingElement>("h2, h3"));
    const headings: Heading[] = nodes.map((node) => {
      if (!node.id) {
        node.id =
          (node.textContent ?? "")
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/(^-|-$)/g, "") || `h-${Math.random().toString(36).slice(2, 7)}`;
      }
      // Scroll-margin so anchored sections clear the sticky header.
      node.style.scrollMarginTop = "5rem";
      return {
        id: node.id,
        text: node.textContent ?? node.id,
        level: (node.tagName === "H2" ? 2 : 3) as 2 | 3,
      };
    });
    let activeId = "";

    // No headings: nothing to record. The derived read above already yields an empty list for a path
    // this state does not cover, which is exactly the "no TOC on this route" case.
    if (headings.length === 0) return;

    // Restore last-active section for this route (display only — does not scroll the page).
    // localStorage persists across full reloads and new tabs.
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (saved && headings.some((h) => h.id === saved)) activeId = saved;
    } catch {
      /* noop */
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) {
          const id = visible[0].target.id;
          setToc((current) =>
            current.active === id && current.path === location.pathname
              ? current
              : { path: location.pathname, items: headings, active: id },
          );
          try {
            window.localStorage.setItem(storageKey, id);
          } catch {
            /* noop */
          }
        }
      },
      { rootMargin: "-80px 0px -65% 0px", threshold: [0, 1] },
    );
    setToc({ path: location.pathname, items: headings, active: activeId });
    nodes.forEach((n) => observer.observe(n));
    return () => observer.disconnect();
  }, [storageKey, location.pathname]);

  if (items.length < 2) return null;

  return (
    <nav aria-label="On this page" className="text-token-sm">
      <div className="mb-3 font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
        On this page
      </div>
      <ul className="space-y-1.5 border-l border-border">
        {items.map((h) => {
          const isActive = active === h.id;
          return (
            <li key={h.id} className={cn(h.level === 3 && "pl-3")}>
              <a
                href={`#${h.id}`}
                aria-current={isActive ? "location" : undefined}
                onClick={() => {
                  setToc({ path: location.pathname, items, active: h.id });
                  try {
                    window.localStorage.setItem(storageKey, h.id);
                  } catch {
                    /* noop */
                  }
                }}
                className={cn(
                  "-ml-px block min-w-0 truncate rounded-r-token border-l border-transparent py-0.5 pl-3 text-token-sm transition-[color,border-color,background-color] duration-200 motion-reduce:transition-none focus-ring",
                  isActive
                    ? "border-mint bg-mint/5 text-mint"
                    : "text-muted-foreground hover:text-foreground",
                  h.level === 3 && "text-[12px]",
                )}
              >
                {h.text}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
