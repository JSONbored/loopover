import { useState } from "react";
import { Button } from "@loopover/ui-kit/components/button";

// Light/dark theme toggle for miner-ui (#6508). The shared @loopover/ui-kit theme.css already ships BOTH
// palettes (light tokens under :root, dark overrides under .dark), switched purely by whether a `.dark` class
// is present on <html> — so this control only flips that class, mirrors it into colorScheme (so native form
// controls follow the theme), and persists the choice. index.html's inline no-flash script reads the same
// persisted value to restore the theme before first paint.
const STORAGE_KEY = "loopover.miner_theme";

export function ThemeToggle() {
  const [isDark, setIsDark] = useState(() =>
    typeof document === "undefined" ? true : document.documentElement.classList.contains("dark"),
  );

  function toggle() {
    const nextIsDark = !isDark;
    const root = document.documentElement;
    root.classList.toggle("dark", nextIsDark);
    root.style.colorScheme = nextIsDark ? "dark" : "light";
    try {
      localStorage.setItem(STORAGE_KEY, nextIsDark ? "dark" : "light");
    } catch {
      // localStorage can throw (private mode / storage disabled); the in-page toggle still works this session.
    }
    setIsDark(nextIsDark);
  }

  return (
    <Button variant="outline" size="sm" onClick={toggle}>
      {isDark ? "Switch to light mode" : "Switch to dark mode"}
    </Button>
  );
}
