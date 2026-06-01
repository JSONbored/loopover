import { cn } from "@/lib/utils";

export function GittensoryMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn(className)}
      aria-hidden
    >
      <defs>
        <linearGradient id="gm-g" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="1" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.4" />
        </linearGradient>
      </defs>
      <path
        d="M16 2 L29 9 V23 L16 30 L3 23 V9 Z"
        stroke="url(#gm-g)"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M10 12 L16 16 L22 12 M16 16 V23"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="16" cy="16" r="1.6" fill="currentColor" />
    </svg>
  );
}
