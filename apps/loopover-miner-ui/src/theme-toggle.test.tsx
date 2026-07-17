import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeToggle } from "./components/theme-toggle";

describe("ThemeToggle (#6508)", () => {
  beforeEach(() => {
    // The app boots dark by default (index.html's no-flash script), so start each case from that state.
    document.documentElement.classList.add("dark");
    document.documentElement.style.colorScheme = "dark";
    localStorage.clear();
  });
  afterEach(() => {
    document.documentElement.classList.remove("dark");
    document.documentElement.style.colorScheme = "";
    localStorage.clear();
  });

  it("labels the button to switch AWAY from the current theme (dark shows 'Switch to light mode')", () => {
    render(<ThemeToggle />);
    expect(screen.getByRole("button", { name: "Switch to light mode" })).toBeTruthy();
  });

  it("shows 'Switch to dark mode' when the dark class is absent", () => {
    document.documentElement.classList.remove("dark");
    render(<ThemeToggle />);
    expect(screen.getByRole("button", { name: "Switch to dark mode" })).toBeTruthy();
  });

  it("on click: toggles the .dark class, colorScheme, persisted value, and label (dark → light → dark)", () => {
    render(<ThemeToggle />);

    fireEvent.click(screen.getByRole("button", { name: "Switch to light mode" }));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(localStorage.getItem("loopover.miner_theme")).toBe("light");
    expect(screen.getByRole("button", { name: "Switch to dark mode" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Switch to dark mode" }));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(localStorage.getItem("loopover.miner_theme")).toBe("dark");
    expect(screen.getByRole("button", { name: "Switch to light mode" })).toBeTruthy();
  });
});
