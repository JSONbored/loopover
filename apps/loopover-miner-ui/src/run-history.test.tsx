import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchRunStates,
  forgeHostLabel,
  RUN_STATE_API_PATH,
  runStateRowKey,
  type RunHistoryResult,
  type RunStateRow,
} from "./lib/run-history";
import { RunHistoryPage, RunHistoryView } from "./routes/run-history";

const fixtureRows: RunStateRow[] = [
  {
    apiBaseUrl: "https://api.github.com",
    repoFullName: "acme/widgets",
    state: "preparing",
    updatedAt: "2026-07-10T06:00:00.000Z",
  },
  {
    apiBaseUrl: "https://api.github.com",
    repoFullName: "acme/gadgets",
    state: "idle",
    updatedAt: "2026-07-10T05:00:00.000Z",
  },
];

function manyRows(count: number): RunStateRow[] {
  return Array.from({ length: count }, (_, index) => ({
    apiBaseUrl: "https://api.github.com",
    repoFullName: `acme/repo-${index}`,
    state: "idle" as const,
    updatedAt: "2026-07-10T05:00:00.000Z",
  }));
}

describe("RunHistoryView (#4305, redesigned #6510)", () => {
  it("renders one table row per run-state fixture row with repo, forge, state badge, and last-updated", () => {
    render(<RunHistoryView result={{ ok: true, rows: fixtureRows }} />);
    expect(screen.getByRole("columnheader", { name: "Repository" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Forge" })).toBeTruthy();
    expect(screen.getByText("acme/widgets")).toBeTruthy();
    expect(screen.getAllByText("api.github.com")).toHaveLength(2);
    expect(screen.getByText("preparing")).toBeTruthy();
    expect(screen.getByText("acme/gadgets")).toBeTruthy();
    expect(screen.getByText("2026-07-10T05:00:00.000Z")).toBeTruthy();
    expect(screen.getAllByRole("row")).toHaveLength(3); // header + 2 fixture rows
  });

  it("REGRESSION (#7080): same repoFullName on two forge hosts renders as two distinct, labeled rows", () => {
    const colliding: RunStateRow[] = [
      {
        apiBaseUrl: "https://api.github.com",
        repoFullName: "acme/widgets",
        state: "preparing",
        updatedAt: "2026-07-10T06:00:00.000Z",
      },
      {
        apiBaseUrl: "https://github.example.corp/api/v3",
        repoFullName: "acme/widgets",
        state: "idle",
        updatedAt: "2026-07-10T05:00:00.000Z",
      },
    ];
    render(<RunHistoryView result={{ ok: true, rows: colliding }} />);
    expect(screen.getAllByText("acme/widgets")).toHaveLength(2);
    expect(screen.getByText("api.github.com")).toBeTruthy();
    expect(screen.getByText("github.example.corp")).toBeTruthy();
    expect(screen.getAllByRole("row")).toHaveLength(3); // header + both forge rows
  });

  it("renders a content-shaped loading skeleton (role=status), not the old flat loading text (#6510)", () => {
    render(<RunHistoryView result={null} />);
    expect(screen.getByRole("status", { name: /loading local run state/i })).toBeTruthy();
    expect(screen.queryByText("Loading local run state…")).toBeNull(); // the pre-#6510 sentence is gone
  });

  it("renders the shared StateBoundary error surface on an unreachable API (#6510)", () => {
    render(<RunHistoryView result={{ ok: false, error: "connection refused" }} />);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText(/Couldn't read local run state/i)).toBeTruthy();
  });

  it("renders the empty state via StateBoundary when there are no tracked repos (#6510)", () => {
    render(<RunHistoryView result={{ ok: true, rows: [] }} />);
    expect(screen.getByText(/No local run state yet/i)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("does not paginate at or below 20 rows — full table, no controls (#6510)", () => {
    render(<RunHistoryView result={{ ok: true, rows: manyRows(20) }} />);
    expect(screen.queryByRole("navigation", { name: /pagination/i })).toBeNull();
    expect(screen.getAllByRole("row")).toHaveLength(21); // header + all 20 rows shown
  });

  it("paginates client-side above 20 rows, paging without any refetch (#6510)", () => {
    render(<RunHistoryView result={{ ok: true, rows: manyRows(45) }} />);
    expect(screen.getByRole("navigation", { name: /pagination/i })).toBeTruthy();
    // page 1: first 20 rows only
    expect(screen.getAllByRole("row")).toHaveLength(21);
    expect(screen.getByText("acme/repo-0")).toBeTruthy();
    expect(screen.queryByText("acme/repo-20")).toBeNull();
    // page 2
    fireEvent.click(screen.getByRole("link", { name: "2" }));
    expect(screen.getByText("acme/repo-20")).toBeTruthy();
    expect(screen.queryByText("acme/repo-0")).toBeNull();
    // page 3 holds the remaining 5 rows (header + 5)
    fireEvent.click(screen.getByRole("link", { name: "3" }));
    expect(screen.getAllByRole("row")).toHaveLength(6);
  });
});

describe("RunHistoryPage (#4305)", () => {
  it("loads rows through the injected loader and renders them", async () => {
    const loadRunStates = async (): Promise<RunHistoryResult> => ({ ok: true, rows: fixtureRows });
    render(<RunHistoryPage loadRunStates={loadRunStates} />);
    expect(screen.getByRole("heading", { name: "Run history" })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("acme/widgets")).toBeTruthy());
  });

  describe("live refresh (#4856)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("polls the injected loader again on the configured interval, without a manual page reload", async () => {
      vi.useFakeTimers();
      const loadRunStates = vi.fn(async (): Promise<RunHistoryResult> => ({ ok: true, rows: fixtureRows }));
      render(<RunHistoryPage loadRunStates={loadRunStates} pollIntervalMs={1000} />);

      await vi.waitFor(() => expect(loadRunStates).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(loadRunStates).toHaveBeenCalledTimes(2));
    });
  });
});

describe("fetchRunStates (#4305)", () => {
  const jsonResponse = (status: number, payload: unknown) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => payload }) as unknown as Response;

  it("returns typed rows from a well-formed payload, requesting the local API path", async () => {
    let requested: string | undefined;
    const result = await fetchRunStates(async (input) => {
      requested = String(input);
      return jsonResponse(200, { rows: fixtureRows });
    });
    expect(requested).toBe(RUN_STATE_API_PATH);
    expect(result).toEqual({ ok: true, rows: fixtureRows });
  });

  it("surfaces a non-2xx response as a typed error", async () => {
    const result = await fetchRunStates(async () => jsonResponse(500, { error: "boom" }));
    expect(result).toEqual({ ok: false, error: "local run-state API responded 500" });
  });

  it("rejects a malformed payload shape (missing rows / bad row fields)", async () => {
    expect(await fetchRunStates(async () => jsonResponse(200, { rows: "nope" }))).toMatchObject({ ok: false });
    expect(
      await fetchRunStates(async () =>
        jsonResponse(200, { rows: [{ repoFullName: 1, state: "idle", updatedAt: "t" }] }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      await fetchRunStates(async () =>
        jsonResponse(200, {
          rows: [{ apiBaseUrl: "https://api.github.com", repoFullName: "a/b", state: "warp", updatedAt: "t" }],
        }),
      ),
    ).toMatchObject({ ok: false });
    // #7080: rows missing apiBaseUrl are rejected so the UI never silently drops forge identity.
    expect(
      await fetchRunStates(async () =>
        jsonResponse(200, { rows: [{ repoFullName: "a/b", state: "idle", updatedAt: "t" }] }),
      ),
    ).toMatchObject({ ok: false });
  });

  it("surfaces a thrown fetch (server not running) as a typed error, never a crash", async () => {
    const result = await fetchRunStates(async () => {
      throw new Error("connection refused");
    });
    expect(result).toEqual({ ok: false, error: "connection refused" });
  });
});

describe("forgeHostLabel / runStateRowKey (#7080)", () => {
  it("extracts the URL host and builds a composite row key", () => {
    expect(forgeHostLabel("https://api.github.com")).toBe("api.github.com");
    expect(forgeHostLabel("https://github.example.corp/api/v3")).toBe("github.example.corp");
    expect(forgeHostLabel("not-a-url")).toBe("not-a-url");
    expect(
      runStateRowKey({ apiBaseUrl: "https://api.github.com", repoFullName: "acme/widgets" }),
    ).toBe("https://api.github.com\0acme/widgets");
  });
});
