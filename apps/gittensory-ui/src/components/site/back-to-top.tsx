import { ArrowUp } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * Floating "back to top" button. Appears after the user scrolls past
 * `threshold` pixels. Respects reduced-motion (jumps without smooth scroll).
 */
export function BackToTop({ threshold = 600 }: { threshold?: number }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > threshold);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [threshold]);

  const click = () => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  };

  return (
    <button
      type="button"
      onClick={click}
      aria-label="Back to top"
      tabIndex={visible ? 0 : -1}
      className={cn(
        "fixed bottom-6 right-6 z-40 inline-flex h-10 w-10 items-center justify-center rounded-full border-hairline bg-background/90 text-muted-foreground shadow-lg backdrop-blur transition-all duration-200 motion-reduce:transition-none hover:text-foreground hover:border-strong active:scale-95 focus-ring",
        visible ? "opacity-100 translate-y-0" : "pointer-events-none opacity-0 translate-y-2",
      )}
    >
      <ArrowUp className="size-4" aria-hidden />
    </button>
  );
}
