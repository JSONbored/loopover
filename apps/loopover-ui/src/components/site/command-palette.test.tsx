import { render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// #6812: the palette had no arrow-key/Enter navigation through results -- selecting a filtered result
// required the mouse or repeated Tab. This drives the real component's keyboard handling end to end.
const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

import { CommandPalette, type PaletteItem } from "@/components/site/command-palette";

const ITEMS: PaletteItem[] = [
  { label: "Overview", to: "/app", group: "App" },
  { label: "Miner command center", to: "/app/miner", group: "App" },
  { label: "Maintainer console", to: "/app/maintainer", group: "App" },
];

function openPalette() {
  render(<CommandPalette items={ITEMS} />);
  fireEvent.click(screen.getByRole("button", { name: "Open command palette" }));
  return screen.getByPlaceholderText("Search the app…");
}

describe("CommandPalette (#6812)", () => {
  afterEach(() => {
    navigate.mockClear();
  });

  it("marks up the results as an accessible listbox with the first result highlighted by default", () => {
    const input = openPalette();
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    const listbox = screen.getByRole("listbox", { name: "Command palette results" });
    expect(listbox.id).toBeTruthy();
    expect(input.getAttribute("aria-controls")).toBe(listbox.id);

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(3);
    expect(options[0]!.getAttribute("aria-selected")).toBe("true");
    expect(options[1]!.getAttribute("aria-selected")).toBe("false");
    expect(input.getAttribute("aria-activedescendant")).toBe(options[0]!.id);
  });

  it("moves the highlight with ArrowDown/ArrowUp, wrapping at both ends", () => {
    const input = openPalette();
    const options = screen.getAllByRole("option");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(options[1]!.getAttribute("aria-selected")).toBe("true");
    expect(input.getAttribute("aria-activedescendant")).toBe(options[1]!.id);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" }); // wraps past the last option back to the first
    expect(options[0]!.getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(input, { key: "ArrowUp" }); // wraps backward past the first option to the last
    expect(options[2]!.getAttribute("aria-selected")).toBe("true");
  });

  it("navigates to the highlighted result on Enter", () => {
    const input = openPalette();
    fireEvent.keyDown(input, { key: "ArrowDown" }); // highlight "Miner command center"
    fireEvent.keyDown(input, { key: "Enter" });

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith({ to: "/app/miner" });
  });

  it("filters results and resets the highlight to the first match, then Enter navigates to it", () => {
    const input = openPalette();
    fireEvent.keyDown(input, { key: "ArrowDown" }); // highlight index 1 before filtering
    fireEvent.change(input, { target: { value: "maintainer" } });

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]!.textContent).toContain("Maintainer console");
    expect(options[0]!.getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(navigate).toHaveBeenCalledWith({ to: "/app/maintainer" });
  });

  it("does not navigate on Enter when no result matches the filter", () => {
    const input = openPalette();
    fireEvent.change(input, { target: { value: "no such route anywhere" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No matches")).toBeTruthy();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("syncs the highlight to mouse hover", () => {
    const input = openPalette();
    const options = screen.getAllByRole("option");
    fireEvent.mouseEnter(options[2]!);
    expect(options[2]!.getAttribute("aria-selected")).toBe("true");
    expect(input.getAttribute("aria-activedescendant")).toBe(options[2]!.id);
  });
});
