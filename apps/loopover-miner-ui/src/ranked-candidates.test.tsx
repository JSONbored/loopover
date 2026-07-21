import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchRankedCandidates,
  formatScorePercent,
  RANKED_CANDIDATES_API_PATH,
  rankedCandidateRowKey,
  type RankedCandidateRow,
  type RankedCandidatesResult,
} from "./lib/ranked-candidates";
import { RankedCandidatesPage, RankedCandidatesView } from "./routes/ranked-candidates";

const fixtureRows: RankedCandidateRow[] = [
  {
    repoFullName: "acme/widgets",
    issueNumber: 214,
    title: "Add retry helper",
    htmlUrl: "https://github.com/acme/widgets/issues/214",
    rankScore: 0.81,
    laneFit: 0.9,
    freshness: 0.7,
    potential: 0.85,
    feasibility: 0.6,
    dupRisk: 0.1,
    rankedAt: "2026-07-13T12:00:00.000Z",
  },
  {
    repoFullName: "acme/gadgets",
    issueNumber: 9,
    title: "Fix flaky pagination test",
    htmlUrl: null,
    rankScore: 0.42,
    laneFit: 0.4,
    freshness: 0.3,
    potential: 0.5,
    feasibility: 0.45,
    dupRisk: 0.6,
    rankedAt: "2026-07-13T11:30:00.000Z",
  },
];

function manyRows(count: number): RankedCandidateRow[] {
  return Array.from({ length: count }, (_, index) => ({
    repoFullName: `acme/repo-${index}`,
    issueNumber: index,
    title: `Issue ${index}`,
    htmlUrl: null,
    rankScore: 0.5,
    laneFit: 0.5,
    freshness: 0.5,
    potential: 0.5,
    feasibility: 0.5,
    dupRisk: 0.5,
    rankedAt: "2026-07-13T11:30:00.000Z",
  }));
}

describe("RankedCandidatesView (#7675)", () => {
  it("renders one table row per candidate fixture row with the score breakdown columns", () => {
    render(<RankedCandidatesView result={{ ok: true, candidates: fixtureRows }} />);
    expect(screen.getByRole("columnheader", { name: "Issue" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Rank score" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Lane fit" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Freshness" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Potential" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Feasibility" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Dup risk" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Ranked at" })).toBeTruthy();
    expect(screen.getByText("acme/widgets#214 Add retry helper")).toBeTruthy();
    expect(screen.getByText("acme/gadgets#9 Fix flaky pagination test")).toBeTruthy();
    expect(screen.getByText("81%")).toBeTruthy(); // rankScore
    expect(screen.getByText("90%")).toBeTruthy(); // laneFit
    expect(screen.getAllByRole("row")).toHaveLength(3); // header + 2 fixture rows
  });

  it("links the issue title to htmlUrl when present, but renders plain text when htmlUrl is null", () => {
    render(<RankedCandidatesView result={{ ok: true, candidates: fixtureRows }} />);
    const link = screen.getByRole("link", { name: "acme/widgets#214 Add retry helper" });
    expect(link.getAttribute("href")).toBe("https://github.com/acme/widgets/issues/214");
    expect(screen.queryByRole("link", { name: "acme/gadgets#9 Fix flaky pagination test" })).toBeNull();
    expect(screen.getByText("acme/gadgets#9 Fix flaky pagination test").tagName).toBe("SPAN");
  });

  it("renders a content-shaped loading skeleton (role=status), not a flat loading message", () => {
    render(<RankedCandidatesView result={null} />);
    expect(screen.getByRole("status", { name: /loading ranked candidates/i })).toBeTruthy();
  });

  it("renders the shared StateBoundary error surface on an unreachable API", () => {
    render(<RankedCandidatesView result={{ ok: false, error: "connection refused" }} />);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText(/Couldn't read ranked candidates/i)).toBeTruthy();
  });

  it("renders the empty state via StateBoundary when there are no ranked candidates yet", () => {
    render(<RankedCandidatesView result={{ ok: true, candidates: [] }} />);
    expect(screen.getByText(/No ranked candidates yet/i)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("does not paginate at or below 20 rows — full table, no controls", () => {
    render(<RankedCandidatesView result={{ ok: true, candidates: manyRows(20) }} />);
    expect(screen.queryByRole("navigation", { name: /pagination/i })).toBeNull();
    expect(screen.getAllByRole("row")).toHaveLength(21); // header + all 20 rows shown
  });

  it("paginates client-side above 20 rows, paging without any refetch", () => {
    render(<RankedCandidatesView result={{ ok: true, candidates: manyRows(45) }} />);
    expect(screen.getByRole("navigation", { name: /pagination/i })).toBeTruthy();
    expect(screen.getAllByRole("row")).toHaveLength(21);
    expect(screen.getByText(/Issue 0$/)).toBeTruthy();
    expect(screen.queryByText(/Issue 20$/)).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "2" }));
    expect(screen.getByText(/Issue 20$/)).toBeTruthy();
    expect(screen.queryByText(/Issue 0$/)).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "3" }));
    expect(screen.getAllByRole("row")).toHaveLength(6); // header + remaining 5 rows
  });
});

describe("RankedCandidatesPage (#7675)", () => {
  it("loads candidates through the injected loader and renders them", async () => {
    const loadRankedCandidates = async (): Promise<RankedCandidatesResult> => ({
      ok: true,
      candidates: fixtureRows,
    });
    render(<RankedCandidatesPage loadRankedCandidates={loadRankedCandidates} />);
    expect(screen.getByRole("heading", { name: "Ranked candidates" })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("acme/widgets#214 Add retry helper")).toBeTruthy());
  });

  describe("live refresh", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("polls the injected loader again on the configured interval, without a manual page reload", async () => {
      vi.useFakeTimers();
      const loadRankedCandidates = vi.fn(async (): Promise<RankedCandidatesResult> => ({
        ok: true,
        candidates: fixtureRows,
      }));
      render(<RankedCandidatesPage loadRankedCandidates={loadRankedCandidates} pollIntervalMs={1000} />);

      await vi.waitFor(() => expect(loadRankedCandidates).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(loadRankedCandidates).toHaveBeenCalledTimes(2));
    });
  });
});

describe("fetchRankedCandidates (#7675)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const jsonResponse = (status: number, payload: unknown) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => payload }) as unknown as Response;

  it("returns typed candidates from a well-formed payload, requesting the local API path", async () => {
    let requested: string | undefined;
    const result = await fetchRankedCandidates(async (input) => {
      requested = String(input);
      return jsonResponse(200, { candidates: fixtureRows });
    });
    expect(requested).toBe(RANKED_CANDIDATES_API_PATH);
    expect(result).toEqual({ ok: true, candidates: fixtureRows });
  });

  it("surfaces a non-2xx response as a typed error", async () => {
    const result = await fetchRankedCandidates(async () => jsonResponse(500, { error: "boom" }));
    expect(result).toEqual({ ok: false, error: "local ranked-candidates API responded 500" });
  });

  it("rejects a malformed payload shape (missing candidates / bad row fields)", async () => {
    expect(await fetchRankedCandidates(async () => jsonResponse(200, { candidates: "nope" }))).toMatchObject({
      ok: false,
    });
    expect(
      await fetchRankedCandidates(async () =>
        jsonResponse(200, { candidates: [{ repoFullName: 1, issueNumber: "x" }] }),
      ),
    ).toMatchObject({ ok: false });
    // htmlUrl must be string or null -- anything else is rejected.
    expect(
      await fetchRankedCandidates(async () =>
        jsonResponse(200, {
          candidates: [{ ...fixtureRows[0], htmlUrl: 42 }],
        }),
      ),
    ).toMatchObject({ ok: false });
  });

  it("surfaces a thrown fetch (server not running) as a typed error, never a crash", async () => {
    const result = await fetchRankedCandidates(async () => {
      throw new Error("connection refused");
    });
    expect(result).toEqual({ ok: false, error: "connection refused" });
  });

  it("in demo mode, returns canned candidates without ever calling fetch", async () => {
    vi.stubEnv("VITE_DEMO_MODE", "1");
    let called = false;
    const result = await fetchRankedCandidates(async () => {
      called = true;
      return jsonResponse(200, { candidates: [] });
    });
    expect(called).toBe(false);
    expect(result.ok).toBe(true);
  });
});

describe("formatScorePercent / rankedCandidateRowKey (#7675)", () => {
  it("formats a 0..1 score fraction as a rounded whole-percent string", () => {
    expect(formatScorePercent(0.81)).toBe("81%");
    expect(formatScorePercent(0)).toBe("0%");
    expect(formatScorePercent(1)).toBe("100%");
    expect(formatScorePercent(0.005)).toBe("1%"); // rounds up
  });

  it("builds a stable composite row key from repoFullName + issueNumber", () => {
    expect(rankedCandidateRowKey({ repoFullName: "acme/widgets", issueNumber: 214 })).toBe("acme/widgets#214");
  });
});
