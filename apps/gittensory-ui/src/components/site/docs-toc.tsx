import { useEffect, useState } from "react";
import { useLocation } from "@tanstack/react-router";

import { cn } from "@/lib/utils";

interface Heading {
  id: string;
  text: string;
  level: 2 | 3;
}

/** localStorage so the rail recalls the last section across full reloads and tabs. */
const STORE_PREFIX = "docs-toc:v2:";

/**
 * Right-rail "On this page" table of contents.
 * Auto-scans the nearest <article> for h2 / h3 elements, assigns slug ids
 * if missing, and tracks the active section via IntersectionObserver.
 */
export function DocsToc() {
  const [items, setItems] = useState<Heading[]>([]);
  const [active, setActive] = useState<string>("");
  const location = useLocation();
  const storageKey = `${STORE_PREFIX}${location.pathname}`;

  useEffect(() => {
    // Reset visible active when the path changes so aria-current never lingers
    // on a heading from the previous route.
    setActive("");
    setItems([]);

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
    setItems(headings);

    if (headings.length === 0) return;

    // Restore last-active section for this route (display only — does not scroll the page).
    // localStorage persists across full reloads and new tabs.
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (saved && headings.some((h) => h.id === saved)) setActive(saved);
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
          setActive(id);
          try {
            window.localStorage.setItem(storageKey, id);
          } catch {
            /* noop */
          }
        }
      },
      { rootMargin: "-80px 0px -65% 0px", threshold: [0, 1] },
    );
    nodes.forEach((n) => observer.observe(n));
    return () => observer.disconnect();
  }, [storageKey]);

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
                  setActive(h.id);
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
