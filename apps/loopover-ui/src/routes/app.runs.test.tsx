import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the toast layer so the copy handlers' user-facing signal can be asserted directly. The base
// export is itself callable (SavedViews' remove flow uses bare toast(...)) while keeping the
// success/error channels the existing copy-button tests assert on.
const { toastBase, success, error } = vi.hoisted(() => {
  const success = vi.fn();
  const error = vi.fn();
  return { toastBase: Object.assign(vi.fn(), { success, error }), success, error };
});
vi.mock("sonner", () => ({ toast: toastBase }));

import {
  DrawerSurface,
  mapAgentRunBundle,
  mapAgentRunKind,
  mapSignalFidelity,
  RunsFilterBar,
  SavedViews,
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

// ---------------------------------------------------------------------------------------------------
// #8701: app.runs.tsx's pure mapping helpers (mapSignalFidelity, mapAgentRunKind, mapAgentRunBundle)
// and the SavedViews save/apply/remove flow previously had zero direct test coverage.
// ---------------------------------------------------------------------------------------------------

describe("mapSignalFidelity (#8701)", () => {
  it("maps every data-quality status, including the unknown fallthrough", () => {
    expect(mapSignalFidelity("complete")).toBe("ready");
    expect(mapSignalFidelity("degraded")).toBe("degraded");
    expect(mapSignalFidelity("blocked")).toBe("blocked");
    expect(mapSignalFidelity("unknown")).toBe("stale");
  });
});

describe("mapAgentRunKind (#8701)", () => {
  it("maps each backend kind to its UI kind", () => {
    expect(mapAgentRunKind("preflight_branch")).toBe("preflight-branch");
    expect(mapAgentRunKind("prepare_pr_packet")).toBe("prepare-pr-packet");
    expect(mapAgentRunKind("explain_blockers")).toBe("explain-blockers");
    expect(mapAgentRunKind("explain_branch_blockers")).toBe("explain-blockers");
  });

  it("defaults everything else — including null — to plan-next-work", () => {
    expect(mapAgentRunKind(null)).toBe("plan-next-work");
    expect(mapAgentRunKind("something_new")).toBe("plan-next-work");
  });
});

type Bundle = Parameters<typeof mapAgentRunBundle>[0];

function buildBundle(overrides?: {
  run?: Partial<Bundle["run"]>;
  actions?: Bundle["actions"];
  contextSnapshots?: Bundle["contextSnapshots"];
}): Bundle {
  return {
    run: {
      id: "run_9",
      objective: "triage",
      actorLogin: "octocat",
      surface: "mcp",
      status: "completed",
      dataQualityStatus: "complete",
      payload: {
        kind: "preflight_branch",
        repoFullName: "payload/repo",
        input: { repoFullName: "input/repo" },
      },
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-21T00:00:00.000Z",
      ...overrides?.run,
    },
    actions: overrides?.actions ?? [
      {
        actionType: "recommend",
        targetRepoFullName: "target/repo",
        recommendation: "Open the preflight branch",
        payload: { recommendationSnapshot: { decision: "approve" } },
      },
    ],
    contextSnapshots: overrides?.contextSnapshots ?? [
      {
        scoringModelId: "model-1",
        decisionPackVersion: "dp-2",
        payload: { counterfactualReasons: [] },
      },
    ],
    summary: "one ranked action",
  };
}

describe("mapAgentRunBundle (#8701)", () => {
  it("prefers the first action's targetRepoFullName for the repo", () => {
    expect(mapAgentRunBundle(buildBundle()).repo).toBe("target/repo");
  });

  it("falls back to payload.repoFullName when the action repo is absent or blank", () => {
    const bundle = buildBundle({
      actions: [{ actionType: "recommend", targetRepoFullName: "   " }],
    });
    expect(mapAgentRunBundle(bundle).repo).toBe("payload/repo");
  });

  it("falls back to payload.input.repoFullName when the payload repo is also absent", () => {
    const bundle = buildBundle({
      run: { payload: { input: { repoFullName: "input/repo" } } },
      actions: [{ actionType: "recommend" }],
    });
    expect(mapAgentRunBundle(bundle).repo).toBe("input/repo");
  });

  it('resolves "unknown" when every level of the repo fallback chain is absent', () => {
    const bundle = buildBundle({
      run: { payload: { input: "not-a-record" } },
      actions: [],
    });
    expect(mapAgentRunBundle(bundle).repo).toBe("unknown");
  });

  it("maps surface to source and boundary for each surface", () => {
    expect(mapAgentRunBundle(buildBundle())).toMatchObject({
      source: "mcp",
      boundary: "private-mcp",
    });
    expect(mapAgentRunBundle(buildBundle({ run: { surface: "github_comment" } }))).toMatchObject({
      source: "github-command",
      boundary: "public",
    });
    expect(mapAgentRunBundle(buildBundle({ run: { surface: "api" } }))).toMatchObject({
      source: "api",
      boundary: "private-api",
    });
  });

  it("routes kind and data quality through the mapping helpers", () => {
    const mapped = mapAgentRunBundle(buildBundle({ run: { dataQualityStatus: "degraded" } }));
    expect(mapped.kind).toBe("preflight-branch");
    expect(mapped.signal_fidelity).toBe("degraded");
  });

  it("resolves the ruleset snapshot from scoringModelId, then decisionPackVersion, then live", () => {
    expect(mapAgentRunBundle(buildBundle()).ruleset_snapshot).toBe("model-1");
    expect(
      mapAgentRunBundle(
        buildBundle({
          contextSnapshots: [{ scoringModelId: null, decisionPackVersion: "dp-2" }],
        }),
      ).ruleset_snapshot,
    ).toBe("dp-2");
    expect(mapAgentRunBundle(buildBundle({ contextSnapshots: [] })).ruleset_snapshot).toBe("live");
  });

  it("falls back from createdAt to updatedAt to a fresh timestamp for created_at", () => {
    expect(mapAgentRunBundle(buildBundle()).created_at).toBe("2026-07-20T00:00:00.000Z");
    expect(mapAgentRunBundle(buildBundle({ run: { createdAt: null } })).created_at).toBe(
      "2026-07-21T00:00:00.000Z",
    );
    const nowIso = mapAgentRunBundle(
      buildBundle({ run: { createdAt: null, updatedAt: null } }),
    ).created_at;
    expect(Number.isNaN(Date.parse(nowIso))).toBe(false);
  });

  it("keeps only string recommendations and counts ranked actions", () => {
    const bundle = buildBundle({
      actions: [
        { actionType: "recommend", targetRepoFullName: "target/repo", recommendation: "Do X" },
        { actionType: "recommend", recommendation: null },
        { actionType: "recommend", recommendation: "   " },
      ],
    });
    const mapped = mapAgentRunBundle(bundle);
    expect(mapped.ranked_actions).toBe(3);
    expect(mapped.recommendations).toEqual(["Do X"]);
  });

  it("builds an authenticated and public-safe replay pair per object recommendationSnapshot only", () => {
    const bundle = buildBundle({
      actions: [
        {
          actionType: "recommend",
          targetRepoFullName: "target/repo",
          payload: { recommendationSnapshot: { decision: "approve" } },
        },
        { actionType: "recommend", payload: { recommendationSnapshot: "not-an-object" } },
        { actionType: "recommend", payload: { recommendationSnapshot: ["array"] } },
        { actionType: "recommend", payload: {} },
      ],
      contextSnapshots: [
        // A non-array counterfactualReasons payload is ignored rather than crashing the pooling.
        { scoringModelId: "model-1", payload: { counterfactualReasons: "not-an-array" } },
      ],
    });
    const mapped = mapAgentRunBundle(bundle);
    expect(mapped.snapshotReplays).toHaveLength(1);
    expect(mapped.snapshotReplays[0]?.authenticated).toBeTruthy();
    expect(mapped.snapshotReplays[0]?.publicSafe).toBeTruthy();
  });
});

describe("SavedViews save/apply/remove flow (#8701)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  const current = { status: "ready" as const, kind: "all" as const, q: "" };

  it("saves the current filters as a named view, lists it, applies it, and removes it", async () => {
    const onApply = vi.fn();
    render(<SavedViews current={current} onApply={onApply} />);

    // Empty state first: no saved views yet.
    expect(screen.getByText("Save current filters as a named view.")).toBeTruthy();

    // Save: open the naming form, type a name, submit.
    fireEvent.click(screen.getByRole("button", { name: /save view/i }));
    fireEvent.change(screen.getByPlaceholderText("View name"), {
      target: { value: "Ready runs" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // The view chip appears, the empty state is gone, and the save is announced + persisted.
    const viewButton = await screen.findByRole("button", { name: "Ready runs" });
    expect(screen.queryByText("Save current filters as a named view.")).toBeNull();
    expect(success).toHaveBeenCalledWith("View saved", {
      description: "“Ready runs” pinned to your filters.",
    });
    const stored = JSON.parse(window.localStorage.getItem("loopover.runs.views") ?? "[]");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ name: "Ready runs", status: "ready", kind: "all", q: "" });

    // Apply: clicking the chip hands the saved filters back to the parent.
    fireEvent.click(viewButton);
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0]?.[0]).toMatchObject({ status: "ready", kind: "all", q: "" });

    // Remove: the chip disappears, the removal is announced, and storage is emptied.
    fireEvent.click(screen.getByRole("button", { name: "Remove Ready runs" }));
    expect(screen.queryByRole("button", { name: "Ready runs" })).toBeNull();
    expect(toastBase).toHaveBeenCalledWith("Removed “Ready runs”");
    expect(JSON.parse(window.localStorage.getItem("loopover.runs.views") ?? "[]")).toEqual([]);
  });

  it("ignores a whitespace-only name and disables saving when no filter is active", () => {
    render(
      <SavedViews current={{ status: "all", kind: "all", q: "" }} onApply={() => undefined} />,
    );
    // No active filters — the save affordance is disabled.
    expect((screen.getByRole("button", { name: /save view/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("does not save a blank name", () => {
    render(<SavedViews current={current} onApply={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: /save view/i }));
    fireEvent.change(screen.getByPlaceholderText("View name"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(success).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("loopover.runs.views")).toBeNull();
  });
});
