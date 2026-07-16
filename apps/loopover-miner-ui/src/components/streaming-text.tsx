// Thin presentational renderer for a progressively-streamed chat response (#6516). It drives `useStreamingText`
// and renders the accumulated text; while streaming (and only when the user has NOT asked for reduced motion) it
// shows an animated caret as the sole visual smoothing on top of raw chunk arrival. Reduced motion is detected
// with `window.matchMedia("(prefers-reduced-motion: reduce)")` — the same technique `@loopover/ui-kit`'s
// `useIsMobile` uses — since this app deliberately has no `motion`/`framer-motion` dependency. Ships unwired: no
// backend call lives here; the only text source is whatever `ChunkSource` the caller passes in.
import * as React from "react";

import { useStreamingText, type ChunkSource } from "../lib/use-streaming-text";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** Tracks `prefers-reduced-motion: reduce`, updating live if the OS setting changes. Degrades to `false` in
 *  any environment without `window.matchMedia` (e.g. a non-DOM test) rather than throwing. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState<boolean>(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(REDUCED_MOTION_QUERY).matches
      : false,
  );

  React.useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = () => setReduced(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

export interface StreamingTextProps {
  /** The chunked text source to reveal; null renders nothing streaming (idle). */
  source: ChunkSource | null;
  className?: string;
}

export function StreamingText({ source, className }: StreamingTextProps) {
  const { text, status } = useStreamingText(source);
  const prefersReducedMotion = usePrefersReducedMotion();
  const showCaret = status === "streaming" && !prefersReducedMotion;

  return (
    <div
      className={className}
      role="log"
      aria-live={prefersReducedMotion ? "off" : "polite"}
      aria-busy={status === "streaming"}
      data-status={status}
    >
      {text}
      {showCaret ? (
        <span aria-hidden="true" className="ml-0.5 inline-block animate-pulse">
          ▋
        </span>
      ) : null}
    </div>
  );
}
