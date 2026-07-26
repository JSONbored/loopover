import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the toast layer so the copy handlers' user-facing signal can be asserted directly.
// `toast` itself is called bare (SavedViews' remove flow, AgentRuns' rerun handler) as well as via
// `.success`/`.error` (the drawer's copy handlers) -- `base` backs the bare-call form so both shapes
// work against the same mock, while `success`/`error` stay the exact references existing assertions
// in this file already check.
const { success, error, base } = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  base: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: Object.assign(base, { success, error }) }));

import {
  DrawerSurface,
  RunsFilterBar,
  SavedViews,
  mapAgentRunBundle,
  mapAgentRunKind,
  mapSignalFidelity,
  type AgentRunBundle,
} from "./app.runs";

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

// #8701: mapSignalFidelity/mapAgentRunKind/mapAgentRunBundle/SavedViews previously had zero direct
// test coverage -- these lock in every branch so a future refactor can't silently regress them.
describe("mapSignalFidelity (#8701)", () => {
  it("maps complete to ready", () => {
    expect(mapSignalFidelity("complete")).toBe("ready");
  });

  it("maps degraded to degraded", () => {
    expect(mapSignalFidelity("degraded")).toBe("degraded");
  });

  it("maps blocked to blocked", () => {
    expect(mapSignalFidelity("blocked")).toBe("blocked");
  });

  it("falls through any other value to stale", () => {
    expect(mapSignalFidelity("unknown")).toBe("stale");
  });
});

describe("mapAgentRunKind (#8701)", () => {
  it("maps preflight_branch to preflight-branch", () => {
    expect(mapAgentRunKind("preflight_branch")).toBe("preflight-branch");
  });

  it("maps prepare_pr_packet to prepare-pr-packet", () => {
    expect(mapAgentRunKind("prepare_pr_packet")).toBe("prepare-pr-packet");
  });

  it("maps explain_blockers to explain-blockers", () => {
    expect(mapAgentRunKind("explain_blockers")).toBe("explain-blockers");
  });

  it("maps explain_branch_blockers to explain-blockers (the other half of the || branch)", () => {
    expect(mapAgentRunKind("explain_branch_blockers")).toBe("explain-blockers");
  });

  it("falls through null or any unrecognized kind to plan-next-work", () => {
    expect(mapAgentRunKind(null)).toBe("plan-next-work");
    expect(mapAgentRunKind("something_else")).toBe("plan-next-work");
  });
});

describe("mapAgentRunBundle (#8701)", () => {
  function buildBundle(overrides: Partial<AgentRunBundle> = {}): AgentRunBundle {
    return {
      run: {
        id: "run_1",
        objective: "test",
        actorLogin: "acme-bot",
        surface: "mcp",
        status: "completed",
        dataQualityStatus: "complete",
      },
      actions: [],
      contextSnapshots: [],
      summary: "did a thing",
      ...overrides,
    };
  }

  describe("repo fallback chain", () => {
    it("prefers actions[0].targetRepoFullName when present", () => {
      const bundle = buildBundle({
        actions: [{ actionType: "x", targetRepoFullName: "acme/from-action" }],
        run: { ...buildBundle().run, payload: { repoFullName: "acme/from-payload" } },
      });
      expect(mapAgentRunBundle(bundle).repo).toBe("acme/from-action");
    });

    it("falls back to payload.repoFullName when the action has none", () => {
      const bundle = buildBundle({
        actions: [{ actionType: "x" }],
        run: { ...buildBundle().run, payload: { repoFullName: "acme/from-payload" } },
      });
      expect(mapAgentRunBundle(bundle).repo).toBe("acme/from-payload");
    });

    it("falls back to payload.input.repoFullName when the action and payload both lack it", () => {
      const bundle = buildBundle({
        actions: [{ actionType: "x" }],
        run: { ...buildBundle().run, payload: { input: { repoFullName: "acme/from-input" } } },
      });
      expect(mapAgentRunBundle(bundle).repo).toBe("acme/from-input");
    });

    it('falls back to "unknown" when every referent is absent', () => {
      const bundle = buildBundle({ actions: [{ actionType: "x" }] });
      expect(mapAgentRunBundle(bundle).repo).toBe("unknown");
    });
  });

  describe("surface -> source/boundary mapping", () => {
    it("maps github_comment to the github-command source and public boundary", () => {
      const bundle = buildBundle({ run: { ...buildBundle().run, surface: "github_comment" } });
      const mapped = mapAgentRunBundle(bundle);
      expect(mapped.source).toBe("github-command");
      expect(mapped.boundary).toBe("public");
    });

    it("maps mcp to the private-mcp boundary", () => {
      const bundle = buildBundle({ run: { ...buildBundle().run, surface: "mcp" } });
      const mapped = mapAgentRunBundle(bundle);
      expect(mapped.source).toBe("mcp");
      expect(mapped.boundary).toBe("private-mcp");
    });

    it("maps api to the private-api boundary", () => {
      const bundle = buildBundle({ run: { ...buildBundle().run, surface: "api" } });
      const mapped = mapAgentRunBundle(bundle);
      expect(mapped.source).toBe("api");
      expect(mapped.boundary).toBe("private-api");
    });
  });

  describe("ruleset_snapshot fallback", () => {
    it("prefers scoringModelId when present", () => {
      const bundle = buildBundle({
        contextSnapshots: [{ scoringModelId: "model-x", decisionPackVersion: "v2" }],
      });
      expect(mapAgentRunBundle(bundle).ruleset_snapshot).toBe("model-x");
    });

    it("falls back to decisionPackVersion when scoringModelId is absent", () => {
      const bundle = buildBundle({ contextSnapshots: [{ decisionPackVersion: "v2" }] });
      expect(mapAgentRunBundle(bundle).ruleset_snapshot).toBe("v2");
    });

    it('falls back to "live" when no context snapshot carries either', () => {
      expect(mapAgentRunBundle(buildBundle()).ruleset_snapshot).toBe("live");
      expect(mapAgentRunBundle(buildBundle({ contextSnapshots: [{}] })).ruleset_snapshot).toBe(
        "live",
      );
    });
  });

  describe("snapshot replay construction", () => {
    it("pools counterfactuals across snapshots and builds both viewer perspectives per action", () => {
      const bundle = buildBundle({
        contextSnapshots: [{ payload: { counterfactualReasons: ["budget"] } }],
        actions: [
          {
            actionType: "x",
            payload: { recommendationSnapshot: { snapshotId: "snap_1" } },
          },
        ],
      });
      const { snapshotReplays } = mapAgentRunBundle(bundle);
      expect(snapshotReplays).toHaveLength(1);
      // buildSnapshotReplayView embeds the requested viewer directly into its result, so this proves
      // it was actually invoked once per viewer rather than one call result reused for both.
      expect(snapshotReplays[0].authenticated.viewer).toBe("authenticated");
      expect(snapshotReplays[0].publicSafe.viewer).toBe("public");
    });

    it("excludes an action whose recommendationSnapshot is not a plain object", () => {
      const arrayBundle = buildBundle({
        actions: [{ actionType: "x", payload: { recommendationSnapshot: [1, 2, 3] } }],
      });
      const missingBundle = buildBundle({ actions: [{ actionType: "x" }] });
      expect(mapAgentRunBundle(arrayBundle).snapshotReplays).toEqual([]);
      expect(mapAgentRunBundle(missingBundle).snapshotReplays).toEqual([]);
    });
  });
});

describe("SavedViews save/apply/remove (#8701)", () => {
  const defaultCurrent = { status: "all" as const, kind: "all" as const, q: "" };
  const activeCurrent = { status: "ready" as const, kind: "all" as const, q: "" };

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  function renderSavedViews(
    current: Parameters<typeof SavedViews>[0]["current"] = activeCurrent,
    onApply = vi.fn(),
  ) {
    render(<SavedViews current={current} onApply={onApply} />);
    return { onApply };
  }

  it("disables Save view while every filter is still at its default", async () => {
    renderSavedViews(defaultCurrent);
    await waitFor(() => expect(screen.getByRole("button", { name: /save view/i })).toBeTruthy());
    expect((screen.getByRole("button", { name: /save view/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("saves a view under a name, lists it, and confirms via toast", async () => {
    renderSavedViews();
    await waitFor(() => screen.getByRole("button", { name: /save view/i }));

    fireEvent.click(screen.getByRole("button", { name: /save view/i }));
    fireEvent.change(screen.getByPlaceholderText("View name"), {
      target: { value: "My triage view" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByRole("button", { name: "My triage view" })).toBeTruthy();
    expect(success).toHaveBeenCalledWith(
      "View saved",
      expect.objectContaining({ description: expect.stringContaining("My triage view") }),
    );
  });

  it("applies a saved view with its saved filter values", async () => {
    const { onApply } = renderSavedViews();
    await waitFor(() => screen.getByRole("button", { name: /save view/i }));

    fireEvent.click(screen.getByRole("button", { name: /save view/i }));
    fireEvent.change(screen.getByPlaceholderText("View name"), {
      target: { value: "My triage view" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    fireEvent.click(screen.getByRole("button", { name: "My triage view" }));
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ready", kind: "all", q: "" }),
    );
  });

  it("removes a saved view and confirms via toast", async () => {
    renderSavedViews();
    await waitFor(() => screen.getByRole("button", { name: /save view/i }));

    fireEvent.click(screen.getByRole("button", { name: /save view/i }));
    fireEvent.change(screen.getByPlaceholderText("View name"), {
      target: { value: "My triage view" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("button", { name: "My triage view" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove My triage view" }));

    expect(screen.queryByRole("button", { name: "My triage view" })).toBeNull();
    expect(base).toHaveBeenCalledWith(expect.stringContaining("My triage view"));
  });

  it("persists saved views across remounts via localStorage", async () => {
    const { unmount } = render(<SavedViews current={activeCurrent} onApply={vi.fn()} />);
    await waitFor(() => screen.getByRole("button", { name: /save view/i }));
    fireEvent.click(screen.getByRole("button", { name: /save view/i }));
    fireEvent.change(screen.getByPlaceholderText("View name"), {
      target: { value: "Persisted view" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    unmount();

    render(<SavedViews current={activeCurrent} onApply={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Persisted view" })).toBeTruthy(),
    );
  });
});
