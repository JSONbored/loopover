import { Moon, Sun } from "lucide-react";

import { useTheme } from "@/lib/theme-preference";
import { cn } from "@/lib/utils";

export {
  THEME_NOFLASH_SCRIPT,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from "@/lib/theme-preference";

export function ThemeToggle({ className }: { className?: string }) {
  const { resolved, toggle, hydrated } = useTheme();

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={resolved === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      aria-pressed={resolved === "dark"}
      className={cn(
        "inline-flex h-8 w-8 items-center justify-center rounded-token text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-ring",
        className,
      )}
    >
      {!hydrated ? (
        <span className="size-4" aria-hidden />
      ) : resolved === "dark" ? (
        <Sun className="size-4" aria-hidden />
      ) : (
        <Moon className="size-4" aria-hidden />
      )}
    </button>
  );
}
