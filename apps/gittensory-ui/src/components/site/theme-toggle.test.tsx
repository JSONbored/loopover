import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ThemeToggle } from "@/components/site/theme-toggle";
import { applyThemePreference } from "@/lib/theme-preference";

describe("theme toggle", () => {
  afterEach(() => {
    document.documentElement.classList.add("dark");
    document.documentElement.style.colorScheme = "dark";
    window.localStorage.clear();
  });

  it("toggles between light and dark themes", () => {
    applyThemePreference("dark");
    render(<ThemeToggle />);

    const button = screen.getByRole("button", { name: "Switch to light theme" });
    fireEvent.click(button);

    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(screen.getByRole("button", { name: "Switch to dark theme" })).toBeTruthy();
  });
});
