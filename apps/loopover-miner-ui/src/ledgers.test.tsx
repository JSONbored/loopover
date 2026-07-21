import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchLedgers, LEDGERS_API_PATH, type LedgersResult, type LedgersSummary } from "./lib/ledgers";
import { type GovernorPauseState, type GovernorPauseStateResult } from "./lib/governor";
import { GovernorControlSection, LedgersPage, LedgersView } from "./routes/ledgers";
import { handleLedgersRequest, type LedgersApiDeps } from "../vite-ledgers-api";

// Test-local fixture factories (were lib exports reachable only from tests; moved here per #6187).
const emptyLedgersSummary = (): LedgersSummary => ({
  claims: { total: 0, byStatus: { active: 0, released: 0, expired: 0 } },
  events: { total: 0, byType: {}, recent: [] },
  governor: { total: 0, byEventType: {} },
});
const defaultGovernorPauseState = (): GovernorPauseState => ({ paused: false, reason: null, pausedAt: null });

const fixtureSummary: LedgersSummary = {
  claims: { total: 3, byStatus: { active: 2, released: 1, expired: 0 } },
  events: {
    total: 2,
    byType: { attempt_started: 1, attempt_succeeded: 1 },
    recent: [
      { eventType: "attempt_succeeded", repoFullName: "acme/widgets", createdAt: "2026-07-10T06:05:00.000Z" },
      { eventType: "attempt_started", repoFullName: "acme/widgets", createdAt: "2026-07-10T06:00:00.000Z" },
    ],
  },
  governor: { total: 2, byEventType: { rate_limit_deferred: 1, budget_deferred: 1 } },
};

// Raw store rows carrying excluded raw columns (the free-text claim `note`, and event/governor payloads) the
// summary must NEVER republish. The API structurally omits these fields entirely, so whatever they contain —
// including any secret — cannot surface; the sentinels below are deliberately NON-secret-shaped so the repo's own
// secret scanner never trips on this fixture, while still proving the raw fields are dropped.
const rawClaimRows = [
  {
    repoFullName: "private-org/watched-repo",
    issueNumber: 12,
    status: "active",
    claimedAt: "t1",
    note: "LEAK_CANARY_CLAIM_A",
  },
  {
    repoFullName: "private-org/watched-repo",
    issueNumber: 13,
    status: "released",
    claimedAt: "t2",
    note: "LEAK_CANARY_CLAIM_B",
  },
  { repoFullName: "private-org/other", issueNumber: 7, status: "active", claimedAt: "t3", note: null },
];
const rawEventRows = [
  {
    type: "attempt_started",
    repoFullName: "private-org/watched-repo",
    createdAt: "t1",
    payload: { detail: "LEAK_CANARY_EVENT_A" },
  },
  {
    type: "attempt_succeeded",
    repoFullName: "private-org/watched-repo",
    createdAt: "t2",
    payload_json: '{"detail":"LEAK_CANARY_EVENT_B"}',
  },
];
const rawGovernorRows = [
  {
    eventType: "rate_limit_deferred",
    repoFullName: "private-org/watched-repo",
    ts: "t1",
    payload: { detail: "LEAK_CANARY_GOV_A" },
  },
  {
    eventType: "budget_deferred",
    repoFullName: "private-org/watched-repo",
    ts: "t2",
    payload_json: '{"detail":"LEAK_CANARY_GOV_B"}',
  },
];

describe("emptyLedgersSummary (#4855)", () => {
  it("summarizes empty ledgers to zeros", () => {
    expect(emptyLedgersSummary()).toEqual({
      claims: { total: 0, byStatus: { active: 0, released: 0, expired: 0 } },
      events: { total: 0, byType: {}, recent: [] },
      governor: { total: 0, byEventType: {} },
    });
  });
});

function manyEventTypes(count: number): Record<string, number> {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [`event_type_${index}`, count - index]));
}

function manyRecentEvents(count: number): LedgersSummary["events"]["recent"] {
  return Array.from({ length: count }, (_, index) => ({
    eventType: `event_type_${index}`,
    repoFullName: index % 2 === 0 ? `acme/repo-${index}` : null,
    createdAt: index % 3 === 0 ? null : `2026-07-10T06:${String(index).padStart(2, "0")}:00.000Z`,
  }));
}

describe("LedgersView (#4855)", () => {
  it("renders claim status counts, the governor type table, the events-by-type table, and the recent-events feed", () => {
    render(<LedgersView result={{ ok: true, summary: fixtureSummary }} />);
    expect(screen.getByText("Active", { selector: "dt" }).nextSibling?.textContent).toBe("2");
    expect(screen.getByText("Released", { selector: "dt" }).nextSibling?.textContent).toBe("1");
    expect(screen.getByText("rate_limit_deferred")).toBeTruthy();
    // #6184: byType now renders its own aggregate table, so each event type appears twice -- once in that table
    // and once in the recent-events feed. getAllByText, not getByText, which would throw on the duplicate.
    expect(screen.getByText("Events by type (2)")).toBeTruthy();
    expect(screen.getAllByText("attempt_succeeded").length).toBe(2);
    expect(screen.getAllByText("attempt_started").length).toBe(2);
    expect(screen.getAllByText("acme/widgets").length).toBeGreaterThan(0);
  });

  it("renders a claims-by-status chart via the ui-kit ChartContainer (#6832)", () => {
    render(<LedgersView result={{ ok: true, summary: fixtureSummary }} />);
    expect(screen.getByLabelText("Claims by status chart")).toBeTruthy();
  });

  it("renders the fresh-install empty state when every ledger is empty", () => {
    render(<LedgersView result={{ ok: true, summary: emptyLedgersSummary() }} />);
    expect(screen.getByText(/No ledger activity yet/i)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("renders an error message when the local API is unreachable", () => {
    render(<LedgersView result={{ ok: false, error: "connection refused" }} />);
    expect(screen.getByRole("alert").textContent).toContain("connection refused");
  });

  it("renders a content-shaped loading skeleton (role=status), not the old flat loading text (#6512)", () => {
    render(<LedgersView result={null} />);
    expect(screen.getByRole("status", { name: /loading local ledgers/i })).toBeTruthy();
    expect(screen.queryByText("Loading local ledgers…")).toBeNull(); // the pre-#6512 sentence is gone
  });

  it("does not paginate count/feed tables at or below 20 rows (#6832)", () => {
    // Only events-by-type + recent feed are populated (20 each) so type labels stay unique across tables.
    const summary: LedgersSummary = {
      claims: { total: 1, byStatus: { active: 1, released: 0, expired: 0 } },
      events: {
        total: 20,
        byType: manyEventTypes(20),
        recent: manyRecentEvents(20),
      },
      governor: { total: 0, byEventType: {} },
    };
    render(<LedgersView result={{ ok: true, summary }} />);
    expect(screen.queryByRole("navigation", { name: /pagination/i })).toBeNull();
    // Each type appears twice (count table + recent feed); both ends of the range must be visible.
    expect(screen.getAllByText("event_type_0").length).toBe(2);
    expect(screen.getAllByText("event_type_19").length).toBe(2);
  });

  it("paginates the events-by-type CountTable client-side above 20 rows (#6832)", () => {
    const summary: LedgersSummary = {
      claims: { total: 1, byStatus: { active: 1, released: 0, expired: 0 } },
      events: {
        total: 45,
        byType: manyEventTypes(45),
        recent: [],
      },
      governor: { total: 0, byEventType: {} },
    };
    render(<LedgersView result={{ ok: true, summary }} />);
    expect(screen.getByRole("navigation", { name: /pagination/i })).toBeTruthy();
    // Sorted descending by count: event_type_0 has the highest count and appears first.
    expect(screen.getByText("event_type_0")).toBeTruthy();
    expect(screen.queryByText("event_type_20")).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "2" }));
    expect(screen.getByText("event_type_20")).toBeTruthy();
    expect(screen.queryByText("event_type_0")).toBeNull();
  });

  it("paginates the recent-events feed client-side above 20 rows, with null column fallbacks (#6832)", () => {
    const summary: LedgersSummary = {
      claims: { total: 1, byStatus: { active: 1, released: 0, expired: 0 } },
      events: {
        total: 45,
        byType: { attempt_started: 45 },
        recent: manyRecentEvents(45),
      },
      governor: { total: 0, byEventType: {} },
    };
    render(<LedgersView result={{ ok: true, summary }} />);
    expect(screen.getByRole("navigation", { name: /pagination/i })).toBeTruthy();
    expect(screen.getByText("event_type_0")).toBeTruthy();
    expect(screen.queryByText("event_type_20")).toBeNull();
    // Null repo/createdAt render as em-dashes (odd indices / multiples of 3 on page 1).
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("link", { name: "2" }));
    expect(screen.getByText("event_type_20")).toBeTruthy();
    expect(screen.queryByText("event_type_0")).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "3" }));
    expect(screen.getByText("event_type_40")).toBeTruthy();
  });

  it("paginates the governor-events CountTable independently of the events tables (#6832)", () => {
    const summary: LedgersSummary = {
      claims: { total: 1, byStatus: { active: 1, released: 0, expired: 0 } },
      events: { total: 0, byType: {}, recent: [] },
      governor: { total: 45, byEventType: manyEventTypes(45) },
    };
    render(<LedgersView result={{ ok: true, summary }} />);
    expect(screen.getByRole("navigation", { name: /pagination/i })).toBeTruthy();
    expect(screen.getByText("event_type_0")).toBeTruthy();
    expect(screen.queryByText("event_type_20")).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "2" }));
    expect(screen.getByText("event_type_20")).toBeTruthy();
    // Previous / Next buttons also advance the page (covers both onClick arms).
    fireEvent.click(screen.getByRole("link", { name: /go to previous page/i }));
    expect(screen.getByText("event_type_0")).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: /go to next page/i }));
    expect(screen.getByText("event_type_20")).toBeTruthy();
  });
});

describe("LedgersPage (#4855)", () => {
  const loadGovernorPauseStateDefault = async (): Promise<GovernorPauseStateResult> => ({
    ok: true,
    pauseState: defaultGovernorPauseState(),
  });

  it("loads the summary through the injected loader and renders it", async () => {
    const loadLedgers = async (): Promise<LedgersResult> => ({ ok: true, summary: fixtureSummary });
    render(<LedgersPage loadLedgers={loadLedgers} loadGovernorPauseState={loadGovernorPauseStateDefault} />);
    expect(screen.getByRole("heading", { name: "Ledgers" })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Active", { selector: "dt" }).nextSibling?.textContent).toBe("2"));
  });

  describe("governor control (#4857)", () => {
    const loadLedgersEmpty = async (): Promise<LedgersResult> => ({ ok: true, summary: emptyLedgersSummary() });

    it("loads the governor pause state through the injected loader on mount", async () => {
      const loadGovernorPauseState = async (): Promise<GovernorPauseStateResult> => ({
        ok: true,
        pauseState: { paused: true, reason: "bad PR", pausedAt: "2026-07-13T12:00:00.000Z" },
      });
      render(<LedgersPage loadLedgers={loadLedgersEmpty} loadGovernorPauseState={loadGovernorPauseState} />);
      await waitFor(() => expect(screen.getByText(/Paused since 2026-07-13T12:00:00.000Z \(bad PR\)/)).toBeTruthy());
    });

    it("clicking Pause governor calls the injected pause action and updates the displayed state from its result", async () => {
      const pausedResult: GovernorPauseStateResult = {
        ok: true,
        pauseState: { paused: true, reason: null, pausedAt: "2026-07-13T12:30:00.000Z" },
      };
      const pauseGovernorAction = vi.fn(async (): Promise<GovernorPauseStateResult> => pausedResult);
      render(
        <LedgersPage
          loadLedgers={loadLedgersEmpty}
          loadGovernorPauseState={loadGovernorPauseStateDefault}
          pauseGovernorAction={pauseGovernorAction}
        />,
      );
      await waitFor(() => expect(screen.getByText("Not paused")).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: "Pause governor" }));
      expect(pauseGovernorAction).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(screen.getByRole("button", { name: "Resume governor" })).toBeTruthy());
    });

    it("passes the typed pause reason through to the pause action (#6186)", async () => {
      const pausedResult: GovernorPauseStateResult = {
        ok: true,
        pauseState: { paused: true, reason: "deploying a hotfix", pausedAt: "2026-07-13T12:30:00.000Z" },
      };
      const pauseGovernorAction = vi.fn(async (): Promise<GovernorPauseStateResult> => pausedResult);
      render(
        <LedgersPage
          loadLedgers={loadLedgersEmpty}
          loadGovernorPauseState={loadGovernorPauseStateDefault}
          pauseGovernorAction={pauseGovernorAction}
        />,
      );
      await waitFor(() => expect(screen.getByText("Not paused")).toBeTruthy());
      fireEvent.change(screen.getByLabelText("Pause reason"), { target: { value: "deploying a hotfix" } });
      fireEvent.click(screen.getByRole("button", { name: "Pause governor" }));
      expect(pauseGovernorAction).toHaveBeenCalledWith("deploying a hotfix");
      await waitFor(() => expect(screen.getByRole("button", { name: "Resume governor" })).toBeTruthy());
    });

    it("passes undefined to the pause action when the reason field is left empty (#6186)", async () => {
      const pauseGovernorAction = vi.fn(async (): Promise<GovernorPauseStateResult> => ({
        ok: true,
        pauseState: { paused: true, reason: null, pausedAt: "2026-07-13T12:30:00.000Z" },
      }));
      render(
        <LedgersPage
          loadLedgers={loadLedgersEmpty}
          loadGovernorPauseState={loadGovernorPauseStateDefault}
          pauseGovernorAction={pauseGovernorAction}
        />,
      );
      await waitFor(() => expect(screen.getByText("Not paused")).toBeTruthy());
      expect((screen.getByLabelText("Pause reason") as HTMLInputElement).value).toBe("");
      fireEvent.click(screen.getByRole("button", { name: "Pause governor" }));
      expect(pauseGovernorAction).toHaveBeenCalledWith(undefined);
    });

    it("shows the reason input only while unpaused, not once the governor is paused (#6186)", async () => {
      render(
        <LedgersPage
          loadLedgers={loadLedgersEmpty}
          loadGovernorPauseState={async () => ({
            ok: true,
            pauseState: { paused: true, reason: "bad PR", pausedAt: "2026-07-13T12:00:00.000Z" },
          })}
        />,
      );
      await waitFor(() => expect(screen.getByRole("button", { name: "Resume governor" })).toBeTruthy());
      expect(screen.queryByLabelText("Pause reason")).toBeNull();
    });

    it("clicking Resume governor calls the injected resume action and updates the displayed state from its result", async () => {
      const initiallyPaused: GovernorPauseState = { paused: true, reason: null, pausedAt: "2026-07-13T12:00:00.000Z" };
      const resumeGovernorAction = vi.fn(async (): Promise<GovernorPauseStateResult> => ({
        ok: true,
        pauseState: defaultGovernorPauseState(),
      }));
      render(
        <LedgersPage
          loadLedgers={loadLedgersEmpty}
          loadGovernorPauseState={async () => ({ ok: true, pauseState: initiallyPaused })}
          resumeGovernorAction={resumeGovernorAction}
        />,
      );
      await waitFor(() => expect(screen.getByRole("button", { name: "Resume governor" })).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: "Resume governor" }));
      expect(resumeGovernorAction).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(screen.getByText("Not paused")).toBeTruthy());
    });

    it("disables the action button while the pause action is in flight, and re-enables it once it resolves", async () => {
      let resolveAction: (value: GovernorPauseStateResult) => void = () => undefined;
      const pauseGovernorAction = vi.fn(
        () =>
          new Promise<GovernorPauseStateResult>((resolve) => {
            resolveAction = resolve;
          }),
      );
      render(
        <LedgersPage
          loadLedgers={loadLedgersEmpty}
          loadGovernorPauseState={loadGovernorPauseStateDefault}
          pauseGovernorAction={pauseGovernorAction}
        />,
      );
      await waitFor(() => expect(screen.getByRole("button", { name: "Pause governor" })).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: "Pause governor" }));
      await waitFor(() =>
        expect((screen.getByRole("button", { name: "Pause governor" }) as HTMLButtonElement).disabled).toBe(true),
      );
      resolveAction({ ok: true, pauseState: { paused: true, reason: null, pausedAt: "2026-07-13T12:30:00.000Z" } });
      await waitFor(() =>
        expect((screen.getByRole("button", { name: "Resume governor" }) as HTMLButtonElement).disabled).toBe(false),
      );
    });

    it("renders an error message when the pause-state load fails, without breaking the ledgers section", async () => {
      render(
        <LedgersPage
          loadLedgers={loadLedgersEmpty}
          loadGovernorPauseState={async () => ({ ok: false, error: "connection refused" })}
        />,
      );
      await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("connection refused"));
      expect(screen.getByText(/No ledger activity yet/i)).toBeTruthy();
    });

    it("does not let a stale in-flight poll response revert a just-applied pause action (#7791)", async () => {
      // The exact race from the bug report: a poll GET is already in flight when the operator clicks Pause, the
      // action POST resolves first, and only THEN does the stale pre-pause poll resolve. The first (mount) poll
      // resolves "not paused" so the Pause button renders; the SECOND poll tick is a deferred left in flight
      // while we click and let the action land, then resolved by hand with the stale pre-pause state.
      let resolveStalePoll: (value: GovernorPauseStateResult) => void = () => undefined;
      let pollCall = 0;
      const loadGovernorPauseState = vi.fn((): Promise<GovernorPauseStateResult> => {
        pollCall += 1;
        if (pollCall === 1) return Promise.resolve({ ok: true, pauseState: defaultGovernorPauseState() });
        return new Promise<GovernorPauseStateResult>((resolve) => {
          resolveStalePoll = resolve;
        });
      });
      const pauseGovernorAction = vi.fn(async (): Promise<GovernorPauseStateResult> => ({
        ok: true,
        pauseState: { paused: true, reason: null, pausedAt: "2026-07-13T12:30:00.000Z" },
      }));
      render(
        <LedgersPage
          loadLedgers={loadLedgersEmpty}
          loadGovernorPauseState={loadGovernorPauseState}
          pauseGovernorAction={pauseGovernorAction}
          pollIntervalMs={20}
        />,
      );

      // First poll resolved "not paused" -> the Pause button is shown.
      await waitFor(() => expect(screen.getByRole("button", { name: "Pause governor" })).toBeTruthy());
      // Let the next poll tick fire and leave its GET in flight (deferred, unresolved).
      await waitFor(() => expect(pollCall).toBeGreaterThanOrEqual(2));

      // Operator clicks Pause; the action POST resolves first -> UI reflects "paused" (Resume button shown).
      fireEvent.click(screen.getByRole("button", { name: "Pause governor" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Resume governor" })).toBeTruthy());

      // Now the STALE second poll (started before the action) finally resolves with the pre-pause "not paused"
      // state. Without the ordering guard this clobbers the action's result; with it, the UI stays paused.
      resolveStalePoll({ ok: true, pauseState: defaultGovernorPauseState() });
      await Promise.resolve();
      await waitFor(() => expect(screen.getByRole("button", { name: "Resume governor" })).toBeTruthy());
      expect(screen.queryByRole("button", { name: "Pause governor" })).toBeNull();
    });
  });

  describe("live refresh (#7082)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("re-polls the ledger summary on the shared cadence, without any user action", async () => {
      vi.useFakeTimers();
      const loadLedgers = vi.fn(async (): Promise<LedgersResult> => ({ ok: true, summary: fixtureSummary }));
      render(
        <LedgersPage
          loadLedgers={loadLedgers}
          loadGovernorPauseState={loadGovernorPauseStateDefault}
          pollIntervalMs={1000}
        />,
      );
      await vi.waitFor(() => expect(loadLedgers).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(loadLedgers).toHaveBeenCalledTimes(2));
    });

    it("re-polls the governor pause-state on the shared cadence, without any user action", async () => {
      vi.useFakeTimers();
      const loadGovernorPauseState = vi.fn(loadGovernorPauseStateDefault);
      render(
        <LedgersPage
          loadLedgers={async () => ({ ok: true, summary: fixtureSummary })}
          loadGovernorPauseState={loadGovernorPauseState}
          pollIntervalMs={1000}
        />,
      );
      await vi.waitFor(() => expect(loadGovernorPauseState).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(loadGovernorPauseState).toHaveBeenCalledTimes(2));
    });
  });
});

describe("fetchLedgers (#4855)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const jsonResponse = (status: number, payload: unknown) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => payload }) as unknown as Response;

  it("returns a typed summary from a well-formed payload, requesting the local API path", async () => {
    let requested: string | undefined;
    const result = await fetchLedgers(async (input) => {
      requested = String(input);
      return jsonResponse(200, { summary: fixtureSummary });
    });
    expect(requested).toBe(LEDGERS_API_PATH);
    expect(result).toEqual({ ok: true, summary: fixtureSummary });
  });

  it("surfaces non-2xx, malformed payloads, and thrown fetches as typed errors", async () => {
    expect(await fetchLedgers(async () => jsonResponse(500, {}))).toEqual({
      ok: false,
      error: "local ledgers API responded 500",
    });
    expect(await fetchLedgers(async () => jsonResponse(200, { summary: { claims: { total: 1 } } }))).toMatchObject({
      ok: false,
    });
    expect(
      await fetchLedgers(async () => {
        throw new Error("connection refused");
      }),
    ).toEqual({ ok: false, error: "connection refused" });
  });

  it("#5963: in demo mode, returns a canned summary without ever calling fetch", async () => {
    vi.stubEnv("VITE_DEMO_MODE", "1");
    let called = false;
    const result = await fetchLedgers(async () => {
      called = true;
      return jsonResponse(200, { summary: emptyLedgersSummary() });
    });
    expect(called).toBe(false);
    expect(result.ok).toBe(true);
  });
});

describe("handleLedgersRequest (#4855)", () => {
  function deps(overrides: Partial<LedgersApiDeps> = {}): LedgersApiDeps {
    return {
      loadClaimLedgerModule: async () => ({
        resolveClaimLedgerDbPath: () => "/home/miner/.config/loopover-miner/claim-ledger.sqlite3",
        listClaims: () => rawClaimRows,
      }),
      loadEventLedgerModule: async () => ({
        resolveEventLedgerDbPath: () => "/home/miner/.config/loopover-miner/event-ledger.sqlite3",
        readEvents: () => rawEventRows,
      }),
      loadGovernorLedgerModule: async () => ({
        resolveGovernorLedgerDbPath: () => "/home/miner/.config/loopover-miner/governor-ledger.sqlite3",
        readGovernorEvents: () => rawGovernorRows,
      }),
      fileExists: () => true,
      ...overrides,
    };
  }

  it("aggregates the three ledgers to counts and a safe recent-events feed", async () => {
    const handled = await handleLedgersRequest("GET", "/api/ledgers", deps());
    expect(handled?.status).toBe(200);
    const body = JSON.parse(handled?.body ?? "{}") as { summary: LedgersSummary };
    expect(body.summary.claims).toEqual({ total: 3, byStatus: { active: 2, released: 1, expired: 0 } });
    expect(body.summary.governor).toEqual({ total: 2, byEventType: { rate_limit_deferred: 1, budget_deferred: 1 } });
    expect(body.summary.events.total).toBe(2);
    expect(body.summary.events.byType).toEqual({ attempt_started: 1, attempt_succeeded: 1 });
    expect(body.summary.events.recent[0]).toEqual({
      eventType: "attempt_succeeded",
      repoFullName: "private-org/watched-repo",
      createdAt: "t2",
    });
  });

  it("INVARIANT (canary): never republishes the claim note or any raw event/governor payload", async () => {
    const handled = await handleLedgersRequest("GET", "/api/ledgers", deps());
    const body = handled?.body ?? "";
    // Repo names are fine (already shown locally by the CLI's own dashboards), but every excluded raw column —
    // the free-text note and the event/governor payloads (whatever they hold) — must be structurally absent.
    for (const forbidden of [
      "LEAK_CANARY_CLAIM_A",
      "LEAK_CANARY_CLAIM_B",
      "LEAK_CANARY_EVENT_A",
      "LEAK_CANARY_EVENT_B",
      "LEAK_CANARY_GOV_A",
      "LEAK_CANARY_GOV_B",
      "payload",
      "note",
      "detail",
    ]) {
      expect(body).not.toContain(forbidden);
    }
  });

  it("serves an empty summary on a fresh install WITHOUT initializing any store", async () => {
    let touched = false;
    const handled = await handleLedgersRequest(
      "GET",
      "/api/ledgers",
      deps({
        fileExists: () => false,
        loadClaimLedgerModule: async () => ({
          resolveClaimLedgerDbPath: () => "/nowhere/claim-ledger.sqlite3",
          listClaims: () => {
            touched = true;
            return rawClaimRows;
          },
        }),
      }),
    );
    expect(handled).toEqual({ status: 200, body: JSON.stringify({ summary: emptyLedgersSummary() }) });
    expect(touched).toBe(false);
  });

  it("falls through (null) for other paths and non-GET methods", async () => {
    expect(await handleLedgersRequest("GET", "/api/portfolio-queue", deps())).toBeNull();
    expect(await handleLedgersRequest("POST", "/api/ledgers", deps())).toBeNull();
  });

  it("surfaces a store read failure as a 500 with a safe message", async () => {
    const handled = await handleLedgersRequest(
      "GET",
      "/api/ledgers",
      deps({
        loadGovernorLedgerModule: async () => {
          throw new Error("sqlite locked");
        },
      }),
    );
    expect(handled).toEqual({ status: 500, body: JSON.stringify({ error: "sqlite locked" }) });
  });
});

describe("GovernorControlSection pause-reason reset (#7079)", () => {
  const notPaused: GovernorPauseStateResult = { ok: true, pauseState: { paused: false, reason: null, pausedAt: null } };
  const pausedResult: GovernorPauseStateResult = {
    ok: true,
    pauseState: { paused: true, reason: "investigating flaky test", pausedAt: "2026-07-18T00:00:00.000Z" },
  };
  const control = (result: GovernorPauseStateResult, onPause = vi.fn()) => (
    <GovernorControlSection result={result} pending={false} onPause={onPause} onResume={vi.fn()} />
  );

  it("clears the reason after a successful pause, so a later resume→pause starts from a blank input", () => {
    const onPause = vi.fn();
    const { rerender } = render(control(notPaused, onPause));
    fireEvent.change(screen.getByLabelText("Pause reason"), { target: { value: "investigating flaky test" } });
    fireEvent.click(screen.getByRole("button", { name: "Pause governor" }));
    expect(onPause).toHaveBeenCalledWith("investigating flaky test");

    // The poll reflects the successful pause (paused: true), then the operator resumes back to the pause form.
    rerender(control(pausedResult, onPause));
    rerender(control(notPaused, onPause));
    expect((screen.getByLabelText("Pause reason") as HTMLInputElement).value).toBe("");
  });

  it("preserves the typed reason after a FAILED pause, so it can be retried without retyping", () => {
    const onPause = vi.fn();
    const { rerender } = render(control(notPaused, onPause));
    fireEvent.change(screen.getByLabelText("Pause reason"), { target: { value: "investigating flaky test" } });
    fireEvent.click(screen.getByRole("button", { name: "Pause governor" }));

    // The pause fails (ok: false): the reset must NOT fire. Re-render back to the form (a retry) and the reason stays.
    rerender(control({ ok: false, error: "governor state write failed" }, onPause));
    rerender(control(notPaused, onPause));
    expect((screen.getByLabelText("Pause reason") as HTMLInputElement).value).toBe("investigating flaky test");
  });
});
