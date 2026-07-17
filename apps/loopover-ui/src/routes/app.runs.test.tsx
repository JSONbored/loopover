import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the toast layer so the copy handlers' user-facing signal can be asserted directly.
const { success, error } = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success, error } }));

import { DrawerSurface, RunsFilterBar } from "./app.runs";

const run = {
  id: "run_1",
  source: "mcp",
  kind: "plan-next-work",
  repo: "JSONbored/loopover",
  ranked_actions: 3,
  ruleset_snapshot: "rs_2026_07",
  signal_fidelity: "ready",
  boundary: "advisory",
  created_at: "2026-07-17T00:00:00.000Z",
  snapshotReplays: [],
} as unknown as Parameters<typeof DrawerSurface>[0]["run"];

// The exact text the drawer renders into its Inputs <pre> -- the copy button must hand the clipboard
// this and nothing else.
const expectedJson = JSON.stringify(
  { repo: "JSONbored/loopover", source: "mcp", kind: "plan-next-work" },
  null,
  2,
);

function renderDrawer() {
  return render(
    <DrawerSurface
      run={run}
      filtered={[run]}
      onSelect={() => {}}
      onClose={() => {}}
      onRerun={() => {}}
    />,
  );
}

function mockClipboard(writeText: () => Promise<void>) {
  const spy = vi.fn(writeText);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: spy },
    configurable: true,
    writable: true,
  });
  return spy;
}

describe("run drawer Inputs copy button", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a copy affordance for the Inputs JSON block", () => {
    renderDrawer();
    // The regression this guards: the Inputs <pre> shipped with no copy button at all, unlike every
    // other code/JSON block in the app.
    expect(screen.getByRole("button", { name: "Copy inputs JSON" })).toBeTruthy();
  });

  it("copies exactly the JSON shown in the Inputs block", async () => {
    const writeText = mockClipboard(() => Promise.resolve());
    const { container } = renderDrawer();

    fireEvent.click(screen.getByRole("button", { name: "Copy inputs JSON" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expectedJson));
    // The rendered <pre> and the clipboard payload come from one hoisted string, so they cannot drift.
    // Compared against textContent rather than getByText because the latter collapses the JSON's
    // newlines and indentation, which is precisely what must match here.
    expect(container.querySelector("pre")?.textContent).toBe(expectedJson);
  });

  it("reports success through the same toast channel as the drawer's other copy actions", async () => {
    mockClipboard(() => Promise.resolve());
    renderDrawer();

    fireEvent.click(screen.getByRole("button", { name: "Copy inputs JSON" }));

    await waitFor(() =>
      expect(success).toHaveBeenCalledWith("Inputs copied", {
        description: "plan-next-work inputs are ready to paste.",
      }),
    );
    expect(error).not.toHaveBeenCalled();
  });

  it("surfaces a toast instead of throwing when the clipboard write is rejected", async () => {
    // A permission-denied clipboard rejects; the handler's catch arm is the branch that keeps a denied
    // copy from becoming an unhandled rejection.
    mockClipboard(() => Promise.reject(new Error("denied")));
    renderDrawer();

    fireEvent.click(screen.getByRole("button", { name: "Copy inputs JSON" }));

    await waitFor(() => expect(error).toHaveBeenCalledWith("Couldn't copy inputs"));
    expect(success).not.toHaveBeenCalled();
  });

  it("leaves the existing Permalink copy action untouched", async () => {
    const writeText = mockClipboard(() => Promise.resolve());
    renderDrawer();

    fireEvent.click(screen.getByRole("button", { name: /permalink/i }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining("selected=run_1")),
    );
    expect(success).toHaveBeenCalledWith("Permalink copied", expect.anything());
  });
});

// #6818: the filter bar previously had NO reset affordance — a "Clear filters" button existed only inside the
// `filtered.length === 0` empty state, so an operator whose filters still matched at least one run had no way to
// clear them without hand-editing the URL. These lock in the persistent control in the bar itself.
describe("Agent Runs filter bar persistent reset (#6818)", () => {
  const noop = () => undefined;
  const renderBar = (over: Partial<Parameters<typeof RunsFilterBar>[0]> = {}) =>
    render(
      <RunsFilterBar
        status="all"
        kind="all"
        q=""
        hasActiveFilters={false}
        onStatusChange={noop}
        onKindChange={noop}
        onQChange={noop}
        onReset={noop}
        {...over}
      />,
    );

  it("renders the reset control in the bar itself, not only in the zero-results empty state", () => {
    renderBar();
    expect(screen.getByRole("button", { name: "Reset filters" })).toBeTruthy();
  });

  it("disables the reset while every filter is still at its default", () => {
    renderBar();
    expect(
      (screen.getByRole("button", { name: "Reset filters" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("enables the reset as soon as any filter is non-default", () => {
    for (const active of [
      { status: "ready" as const },
      { kind: "plan-next-work" as const },
      { q: "acme" },
    ]) {
      const { unmount } = renderBar({ hasActiveFilters: true, ...active });
      expect(
        (screen.getByRole("button", { name: "Reset filters" }) as HTMLButtonElement).disabled,
      ).toBe(false);
      unmount();
    }
  });

  it("clears every filter through one shared handler when clicked", () => {
    const onReset = vi.fn();
    renderBar({ hasActiveFilters: true, status: "ready", onReset });
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});
