import { useEffect, useState } from "react";

/**
 * Thin mint reading-progress bar pinned to the top of the viewport.
 * Pure CSS transform — cheap on scroll. Hidden under prefers-reduced-motion
 * is fine; the bar is informational, not animation.
 */
export function ReadingProgress() {
  const [pct, setPct] = useState(0);

  useEffect(() => {
    const calc = () => {
      const h = document.documentElement;
      const total = h.scrollHeight - h.clientHeight;
      setPct(total > 0 ? Math.min(100, Math.max(0, (h.scrollTop / total) * 100)) : 0);
    };
    calc();
    window.addEventListener("scroll", calc, { passive: true });
    window.addEventListener("resize", calc);
    return () => {
      window.removeEventListener("scroll", calc);
      window.removeEventListener("resize", calc);
    };
  }, []);

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-50 h-[2px] bg-transparent"
    >
      <div
        className="h-full origin-left bg-mint transition-transform duration-100 motion-reduce:transition-none"
        style={{ transform: `scaleX(${pct / 100})`, width: "100%" }}
      />
    </div>
  );
}
