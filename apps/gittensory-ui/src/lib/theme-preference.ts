import { useEffect } from "react";

import { useLocalStorage } from "@/lib/use-local-storage";

export type ThemePreference = "light" | "dark";

export const THEME_STORAGE_KEY = "gittensory.theme";

export const THEME_NOFLASH_SCRIPT = `
(function(){try{
  var t=localStorage.getItem("${THEME_STORAGE_KEY}")||"dark";
  var d=t!=="light";
  var r=document.documentElement;
  r.classList.toggle("dark",d);
  r.style.colorScheme=d?"dark":"light";
}catch(e){}})();
`;

export function applyThemePreference(preference: ThemePreference) {
  const dark = preference === "dark";
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

export function useTheme() {
  const [preference, setPreference, hydrated] = useLocalStorage<ThemePreference>(
    THEME_STORAGE_KEY,
    "dark",
  );

  useEffect(() => {
    if (!hydrated) return;
    applyThemePreference(preference);
  }, [preference, hydrated]);

  const resolved: ThemePreference = preference;
  const toggle = () => setPreference((current) => (current === "dark" ? "light" : "dark"));

  return { preference, resolved, setPreference, toggle, hydrated };
}
