import { use, useEffect, useState, type ReactNode } from "react";
import { useChildMatches, useLocation } from "@tanstack/react-router";

import { docsClientLoader } from "@/lib/docs-client-loader";
import { cn } from "@/lib/utils";

/** One rail entry. `text` is a ReactNode, not a string: fumadocs compiles a heading's inline markup into
 *  the toc, so a heading like `### \`wantedPaths\` (string list)` keeps its code formatting here instead of
 *  being flattened the way reading `textContent` off the DOM did. */
export interface TocHeading {
  id: string;
  text: ReactNode;
  level: number;
}

/** How many animation frames to keep looking for the page's headings before giving up. ~2s at 60fps: long
 *  enough for a slow content chunk, short enough that a toc entry whose heading never renders cannot leave
 *  a frame loop running for the life of the page. */
const MAX_ATTACH_FRAMES = 120;

/** localStorage so the rail recalls the last section across full reloads and tabs. */
const STORE_PREFIX = "docs-toc:v2:";

/** The last-active section recorded for this route, when it still matches a heading on the page. */
function restoreActive(storageKey: string, items: readonly TocHeading[]): string {
  try {
    const saved = window.localStorage.getItem(storageKey);
    return saved && items.some((item) => item.id === saved) ? saved : "";
  } catch {
    return "";
  }
}

function remember(storageKey: string, id: string): void {
  try {
    window.localStorage.setItem(storageKey, id);
  } catch {
    /* noop */
  }
}

/**
 * Right-rail "On this page" list. PURE with respect to its items: it renders what it is handed and never
 * inspects the document to discover them.
 *
 * It used to scan the rendered `article.prose-docs` for `h2, h3`, back-fill ids onto any heading missing
 * one, and read the result into state from an effect (#9872). That was the app's last
 * `react-hooks/set-state-in-effect` site -- the reason the rule sat at `warn` -- and it was fragile
 * independently of lint: the rail was a function of the rendered markup, so a styling change to the article
 * wrapper silently emptied it.
 *
 * The effect that remains subscribes an IntersectionObserver, which is real external-system work and
 * exactly what an effect is for. It sets state only from the observer CALLBACK (an event), never in the
 * effect body.
 */
export function DocsToc({ items }: { items: readonly TocHeading[] }) {
  const location = useLocation();
  const storageKey = `${STORE_PREFIX}${location.pathname}`;

  // Keyed by pathname so a navigation clears the previous route's active id by derivation rather than by a
  // setState at the top of an effect -- the same pattern #9588 used for the headings themselves.
  const [activeState, setActiveState] = useState<{ path: string; id: string }>({
    path: "",
    id: "",
  });
  const active =
    activeState.path === location.pathname ? activeState.id : restoreActive(storageKey, items);

  useEffect(() => {
    if (items.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const first = visible[0];
        if (!first) return;
        setActiveState({ path: location.pathname, id: first.target.id });
        remember(storageKey, first.target.id);
      },
      { rootMargin: "-80px 0px -65% 0px", threshold: [0, 1] },
    );

    // The headings are rendered by the PAGE, which resolves in its own Suspense boundary -- independent of
    // the one this rail resolves in. A single up-front `getElementById` sweep would therefore observe
    // nothing, PERMANENTLY, on any commit where the rail lands before the article: the deps below do not
    // change when the content later appears, so the effect never re-runs to pick it up.
    //
    // In practice both boundaries suspend on the same cached promise and usually commit together, so this
    // is a guard against an ordering hazard rather than a fix for an observed failure -- I was not able to
    // exercise IntersectionObserver in a headless pane to prove it either way. Attaching across frames
    // costs nothing when the headings are already there (one pass, no rAF scheduled) and removes the
    // failure mode entirely when they are not. Bounded, so a toc entry whose heading never renders cannot
    // leave a frame loop running for the life of the page.
    let frame = 0;
    let attempts = 0;
    const attached = new Set<string>();
    const attach = () => {
      for (const item of items) {
        if (attached.has(item.id)) continue;
        const node = document.getElementById(item.id);
        if (node === null) continue;
        attached.add(item.id);
        observer.observe(node);
      }
      attempts += 1;
      if (attached.size < items.length && attempts < MAX_ATTACH_FRAMES)
        frame = requestAnimationFrame(attach);
    };
    attach();

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [items, storageKey, location.pathname]);

  if (items.length < 2) return null;

  return (
    <nav aria-label="On this page" className="text-token-sm">
      <div className="mb-3 font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
        On this page
      </div>
      <ul className="space-y-1.5 border-l border-border">
        {items.map((heading) => {
          const isActive = active === heading.id;
          return (
            <li key={heading.id} className={cn(heading.level >= 3 && "pl-3")}>
              <a
                href={`#${heading.id}`}
                aria-current={isActive ? "location" : undefined}
                onClick={() => {
                  setActiveState({ path: location.pathname, id: heading.id });
                  remember(storageKey, heading.id);
                }}
                className={cn(
                  "-ml-px block min-w-0 truncate rounded-r-token border-l border-transparent py-0.5 pl-3 text-token-sm transition-[color,border-color,background-color] duration-200 motion-reduce:transition-none focus-ring",
                  isActive
                    ? "border-mint bg-mint/5 text-mint"
                    : "text-muted-foreground hover:text-foreground",
                  heading.level >= 3 && "text-[12px]",
                )}
              >
                {heading.text}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** The compiled-MDX toc shape fumadocs produces (`TOCItemType`), narrowed to what the rail reads. */
type CompiledTocItem = { title: ReactNode; url: string; depth: number };

/**
 * Reads the CURRENT docs page's compiled toc and renders the rail from it.
 *
 * The toc cannot travel through the route loader: `title` is a ReactNode, and 29 of this repo's 451 docs
 * headings carry inline markup (`### \`wantedPaths\` ...`), so those entries are React elements and do not
 * survive the server-function JSON boundary. It is read on the client instead, from the same
 * `docsClientLoader` cache the page content already resolves through -- so this adds no second fetch.
 *
 * `useChildMatches` supplies the compiled file path, which only the MDX route's loader has. A docs route
 * without one (the index page, the API-reference spike) yields no toc and the rail renders nothing; see the
 * layout for why that is deliberate rather than a regression.
 */
export function DocsTocFromMdx() {
  const childMatches = useChildMatches();
  const path = childMatches
    .map((match) => (match.loaderData as { path?: unknown } | undefined)?.path)
    .find((value): value is string => typeof value === "string");
  if (path === undefined) return null;
  return <ResolvedToc path={path} />;
}

function ResolvedToc({ path }: { path: string }) {
  // `use()` on the loader's own cached promise: the content component resolves the identical entry, so this
  // suspends only if the rail renders before the page's own content has loaded.
  const loaded = use(docsClientLoader.preload(path)) as { toc?: CompiledTocItem[] };
  const items: TocHeading[] = (loaded.toc ?? []).map((item) => ({
    id: item.url.replace(/^#/, ""),
    text: item.title,
    level: item.depth,
  }));
  return <DocsToc items={items} />;
}
