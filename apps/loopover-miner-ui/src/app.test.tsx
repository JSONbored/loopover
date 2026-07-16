import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { LedgersResult } from "./lib/ledgers";
import type { PortfolioQueueResult } from "./lib/portfolio-queue";
import type { RunHistoryResult } from "./lib/run-history";
import { IndexPage, OverviewView } from "./routes/index";

const runsOk: RunHistoryResult = {
  ok: true,
  rows: [
    { repoFullName: "acme/widgets", state: "discovering", updatedAt: "2026-07-10T06:00:00.000Z" },
    { repoFullName: "acme/gadgets", state: "idle", updatedAt: "2026-07-10T05:00:00.000Z" },
  ],
};
const portfolioOk: PortfolioQueueResult = {
  ok: true,
  summary: { total: 5, byStatus: { queued: 2, in_progress: 1, done: 2 }, repos: [], oldestQueuedAgeMs: null },
};
const claimsOk: LedgersResult = {
  ok: true,
  summary: {
    claims: { total: 4, byStatus: { active: 3, released: 1, expired: 0 } },
    events: { total: 0, byType: {}, recent: [] },
    governor: { total: 0, byEventType: {} },
  },
};

const statValue = (label: string) => screen.getByText(label).nextElementSibling?.textContent;

describe("OverviewView (#4853)", () => {
  it("summarizes run activity, portfolio queue, and claims from live data", () => {
    render(<OverviewView runs={runsOk} portfolio={portfolioOk} claims={claimsOk} />);
    expect(statValue("Repositories tracked")).toBe("2");
    expect(statValue("Currently working")).toBe("1"); // the idle repo is excluded
    expect(statValue("Total items")).toBe("5");
    expect(statValue("Queued")).toBe("2");
    expect(statValue("In progress")).toBe("1");
    expect(statValue("Done")).toBe("2");
    expect(statValue("Active")).toBe("3");
    expect(statValue("Total recorded")).toBe("4");
    // Oldest-queued age is omitted when null (empty queue), matching the CLI (#6185).
    expect(screen.queryByText("Oldest queued")).toBeNull();
  });

  it("renders the oldest-queued age in CLI-parity minutes when the queue has one (#6185)", () => {
    const portfolioWithAge: PortfolioQueueResult = {
      ok: true,
      summary: { total: 3, byStatus: { queued: 3, in_progress: 0, done: 0 }, repos: [], oldestQueuedAgeMs: 5_400_000 },
    };
    render(<OverviewView runs={runsOk} portfolio={portfolioWithAge} claims={claimsOk} />);
    // 5_400_000ms / 60000 = 90m, matching portfolio-dashboard.js's `Math.round(oldestQueuedAgeMs / 60000)m`.
    expect(statValue("Oldest queued")).toBe("90m");
  });

  it("shows an independent content-shaped loading skeleton per card before data arrives (#6509)", () => {
    render(<OverviewView runs={null} portfolio={null} claims={null} />);
    // Each card's loading surface is now a role="status" Skeleton placeholder, not a flat gray sentence.
    expect(screen.getByRole("status", { name: /loading run activity/i })).toBeTruthy();
    expect(screen.getByRole("status", { name: /loading the portfolio queue/i })).toBeTruthy();
    expect(screen.getByRole("status", { name: /loading the claim ledger/i })).toBeTruthy();
    // The pre-#6509 hand-rolled "Loading …" text is gone.
    expect(screen.queryByText(/Loading run state/i)).toBeNull();
  });

  it("degrades each card independently: an errored source shows a StateBoundary alert while the others still render", () => {
    render(
      <OverviewView
        runs={{ ok: false, error: "down" }}
        portfolio={portfolioOk}
        claims={{ ok: false, error: "down" }}
      />,
    );
    expect(screen.getAllByRole("alert")).toHaveLength(2); // runs + claims errored
    // The shared StateBoundary error surface, with this route's per-card copy (#6509).
    expect(screen.getByText(/Couldn't read run state/i)).toBeTruthy();
    expect(screen.getByText(/Couldn't read the claim ledger/i)).toBeTruthy();
    expect(statValue("Total items")).toBe("5"); // portfolio still renders
  });
});

describe("IndexPage (#4853)", () => {
  it("loads all three sources through injected loaders and renders the summary", async () => {
    render(
      <IndexPage
        loadRuns={async () => runsOk}
        loadPortfolio={async () => portfolioOk}
        loadClaims={async () => claimsOk}
        pollIntervalMs={100_000}
      />,
    );
    expect(screen.getByRole("heading", { name: "Overview" })).toBeTruthy();
    await waitFor(() => expect(statValue("Repositories tracked")).toBe("2"));
    expect(statValue("Total items")).toBe("5");
    expect(statValue("Active")).toBe("3");
  });
});
