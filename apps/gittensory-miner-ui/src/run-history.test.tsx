import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchRunStates, RUN_STATE_API_PATH, type RunHistoryResult, type RunStateRow } from "./lib/run-history";
import { RunHistoryPage, RunHistoryView } from "./routes/run-history";

const fixtureRows: RunStateRow[] = [
  { repoFullName: "acme/widgets", state: "preparing", updatedAt: "2026-07-10T06:00:00.000Z" },
  { repoFullName: "acme/gadgets", state: "idle", updatedAt: "2026-07-10T05:00:00.000Z" },
];

describe("RunHistoryView (#4305)", () => {
  it("renders one table row per run-state fixture row with repo, state badge, and last-updated", () => {
    render(<RunHistoryView result={{ ok: true, rows: fixtureRows }} />);
    expect(screen.getByRole("columnheader", { name: "Repository" })).toBeTruthy();
    expect(screen.getByText("acme/widgets")).toBeTruthy();
    expect(screen.getByText("preparing")).toBeTruthy();
    expect(screen.getByText("acme/gadgets")).toBeTruthy();
    expect(screen.getByText("2026-07-10T05:00:00.000Z")).toBeTruthy();
    expect(screen.getAllByRole("row")).toHaveLength(3); // header + 2 fixture rows
  });

  it("renders the fresh-install empty state without erroring", () => {
    render(<RunHistoryView result={{ ok: true, rows: [] }} />);
    expect(screen.getByText(/No local run state yet/i)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("renders an error message when the local API is unreachable", () => {
    render(<RunHistoryView result={{ ok: false, error: "connection refused" }} />);
    expect(screen.getByRole("alert").textContent).toContain("connection refused");
  });

  it("renders the loading state before the first result arrives", () => {
    render(<RunHistoryView result={null} />);
    expect(screen.getByText(/Loading local run state/i)).toBeTruthy();
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
        jsonResponse(200, { rows: [{ repoFullName: "a/b", state: "warp", updatedAt: "t" }] }),
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
