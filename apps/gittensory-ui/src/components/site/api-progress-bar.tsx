import { useEffect, useState } from "react";

import { useApiStatus } from "@/lib/api/status";

/**
 * 1px top progress bar that animates while any API request is in flight.
 * Reduced-motion users see a static bar instead of the indeterminate sweep.
 */
export function ApiProgressBar() {
  const { inFlight, status } = useApiStatus();
  const active = inFlight > 0 || status === "loading";
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (active) {
      setVisible(true);
      return;
    }
    const t = window.setTimeout(() => setVisible(false), 240);
    return () => clearTimeout(t);
  }, [active]);

  if (!visible) return null;

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-[60] h-[2px] overflow-hidden"
    >
      <div
        className={
          "h-full bg-gradient-to-r from-transparent via-mint to-transparent " +
          (active
            ? "animate-[api-progress_1.1s_linear_infinite] motion-reduce:animate-none motion-reduce:bg-mint/60"
            : "opacity-0 transition-opacity duration-200")
        }
        style={{ width: "40%" }}
      />
      <style>{`
        @keyframes api-progress {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(350%); }
        }
      `}</style>
    </div>
  );
}
