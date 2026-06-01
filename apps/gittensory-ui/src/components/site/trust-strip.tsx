import { Lock, EyeOff, KeyRound, Code2 } from "lucide-react";

import { cn } from "@/lib/utils";

const items = [
  { icon: EyeOff, label: "Public-safe by default" },
  { icon: Code2, label: "Metadata-only, never source" },
  { icon: KeyRound, label: "No PAT input — Device Flow only" },
  { icon: Lock, label: "Private intelligence stays private" },
] as const;

/**
 * Reassurance strip pinned above the footer CTA on the homepage.
 * Reinforces the public/private boundary in one glance.
 */
export function TrustStrip({ className }: { className?: string }) {
  return (
    <ul
      className={cn(
        "grid grid-cols-2 gap-px overflow-hidden rounded-token border-hairline accent-grid-lines sm:grid-cols-4",
        className,
      )}
    >
      {items.map((it) => {
        const Icon = it.icon;
        return (
          <li
            key={it.label}
            className="flex items-center gap-2 bg-background px-3 py-3 text-token-xs text-muted-foreground"
          >
            <Icon className="size-3.5 shrink-0 text-mint" aria-hidden />
            <span className="truncate">{it.label}</span>
          </li>
        );
      })}
    </ul>
  );
}
