import { useEffect, useState } from "react";
import { useStreamingText, type ChunkSource } from "@/lib/use-streaming-text";

// prefers-reduced-motion detection via window.matchMedia + a `change` listener — the same technique
// packages/loopover-ui-kit/src/hooks/use-mobile.tsx uses. Kept internal (not exported) so this file only
// exports the component, satisfying react-refresh. This app has no `motion`/`framer-motion` dependency.
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/**
 * Thin presentational renderer for {@link useStreamingText}: shows the progressively-accumulated text and, while
 * streaming, a blinking caret. The reveal itself is never gated — only the caret animation is suppressed under
 * prefers-reduced-motion, so reduced-motion users still see the full text arrive, just without the animation.
 */
export function StreamingText({ source, className }: { source: ChunkSource | null; className?: string }) {
  const { text, status } = useStreamingText(source);
  const reducedMotion = usePrefersReducedMotion();
  return (
    <p className={className} data-status={status} aria-busy={status === "streaming"}>
      {text}
      {status === "streaming" && !reducedMotion ? (
        <span aria-hidden="true" className="ml-0.5 inline-block animate-pulse">
          ▍
        </span>
      ) : null}
    </p>
  );
}
