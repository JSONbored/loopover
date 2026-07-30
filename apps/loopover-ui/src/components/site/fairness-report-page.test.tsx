import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api/request", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  notifyApiFailure: vi.fn(),
  notifyApiRecovered: vi.fn(),
}));
vi.mock("@/lib/api/origin", () => ({ getApiOrigin: () => "https://api.example.test" }));

// Mirrors proof-of-power-stats.test.tsx: <Link> needs a real router context; render a plain <a>.
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    ...props
  }: {
    to: string;
    children: ReactNode;
    className?: string;
    "aria-label"?: string;
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

import { FairnessReportPage } from "./fairness-report-page";
import type { PublicStats } from "./proof-of-power-stats-model";

function renderWithClient(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const FIXTURE: PublicStats = {
  // The wire always carries rulePrecision (#8230/#8231). A fixture without it is not a payload the
  // current backend can produce -- the one test that needs that shape strips it explicitly.
  automationRate: {
    weeks: [],
    decided: 0,
    automated: 0,
    automationRatePct: null,
    provenanceHorizon: "2026-07-29T00:00:00.000Z",
  },
  reviewParity: {
    windowStart: "2026-07-22T00:00:00.000Z",
    windowEnd: "2026-07-29T00:00:00.000Z",
    verdicts: 0,
    reevaluations: 0,
    reevaluationRatePct: null,
    byReason: [],
    byAuthorClass: [],
    byProject: [],
  },
  rulePrecision: {
    windowDays: 90,
    rules: [],
    reversals: { reopened: 0, reverted: 0, superseded: 0 },
    latestBacktestRun: null,
  },
  generatedAt: "2026-07-20T00:00:00.000Z",
  updatedAt: "2026-07-20T00:00:00.000Z",
  totals: {
    handled: 100,
    reviewed: 100,
    merged: 60,
    closed: 30,
    commented: 10,
    ignored: 0,
    manual: 0,
    error: 0,
    reversed: 2,
    filteredPct: 40,
    accuracyPct: 97.8,
    accuracyWindowDays: 90,
    minutesSaved: 2000,
  },
  weekly: { reviewed: 10, merged: 6 },
  byProject: [{ project: "owner/repo", reviewed: 100, merged: 60, closed: 30, accuracyPct: 95.5 }],
  fleetAccuracy: {
    accuracyPct: 92,
    // Every #8829/#9168 field the wire always carries. The fixture used to omit them, which the
    // hand-typed interface allowed and the real payload never does.
    accuracyCiPct: null,
    mergePrecisionPct: null,
    mergePrecisionCiPct: null,
    closePrecisionPct: null,
    closePrecisionCiPct: null,
    coveragePct: null,
    decidedCount: null,
    guaranteed: { close: null, merge: null },
    instanceCount: 4,
    basis: "fleet",
    windowDays: 90,
    gamingFlagsCaught: 1,
  },
  fleetAccuracyTrend: [{ weekStart: "2026-07-13", verdicts: 40, accuracyPct: 92.5 }],
  accuracyTrend: [
    { weekStart: "2026-07-13", merged: 30, closed: 15, reversed: 1, accuracyPct: 97.8 },
  ],
  reuseRateTrend: [],
  reviewVolumeTrend: [],
};

describe("FairnessReportPage (#fairness-analytics)", () => {
  afterEach(() => {
    apiFetch.mockReset();
  });

  it("renders the measured per-rule precision table with the insufficient-data null state — never 0% (#8231)", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      data: {
        ...FIXTURE,
        rulePrecision: {
          windowDays: 90,
          rules: [
            { ruleId: "linked_issue_scope_mismatch", decided: 42, confirmed: 40, precision: 0.952 },
            { ruleId: "slop_gate_score", decided: 3, confirmed: 3, precision: null },
          ],
          reversals: { reopened: 2, reverted: 1, superseded: 0 },
          latestBacktestRun: { corpusChecksum: "a".repeat(64), at: "2026-07-22T00:00:00.000Z" },
        },
      },
      durationMs: 10,
    });
    renderWithClient(<FairnessReportPage />);

    await waitFor(() => expect(screen.getByText("Measured accuracy per rule")).toBeTruthy());
    expect(screen.getByText("linked_issue_scope_mismatch")).toBeTruthy();
    expect(screen.getByText("95.2%")).toBeTruthy();
    // The below-floor rule renders the deliberate null state — the literal words, not a zero.
    expect(screen.getAllByText("insufficient data").length).toBeGreaterThanOrEqual(2); // the explainer + the table cell
    expect(screen.queryByText("0%")).toBeNull();
    // The reproducibility freeze point surfaces the truncated corpus checksum.
    expect(screen.getByText(/Reproducibility freeze point/)).toBeTruthy();
    expect(screen.getByText(/aaaaaaaaaaaaaaaa…/)).toBeTruthy();
    // And the walkthrough link points at the docs page.
    // Both the per-rule precision block and the review-parity block (#9744) invite the reader to
    // reproduce their numbers, so there is deliberately more than one of these links.
    expect(screen.getAllByRole("link", { name: /verify this review/i }).length).toBeGreaterThan(0);
  });

  it("hides the per-rule section entirely when the API response predates rulePrecision (deployment skew) or has no rules (#8231)", async () => {
    // Deliberately NOT a PublicStats: an older deployed Worker omits the field entirely, which the current
    // schema no longer describes. The cast is the point of the test -- the UI must not throw on that payload.
    const { rulePrecision: _omitted, ...withoutRulePrecision } = FIXTURE;
    apiFetch.mockResolvedValue({ ok: true, data: withoutRulePrecision, durationMs: 10 });
    renderWithClient(<FairnessReportPage />);
    await waitFor(() =>
      expect(screen.getByText("Is ORB treating contributors fairly?")).toBeTruthy(),
    );
    expect(screen.queryByText("Measured accuracy per rule")).toBeNull();
  });

  it("renders a content-shaped loading skeleton", () => {
    apiFetch.mockReturnValue(new Promise(() => {}));
    const { container } = renderWithClient(<FairnessReportPage />);
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(1);
  });

  it("renders an accessible error state (role=alert) with a retry that refetches", async () => {
    apiFetch.mockResolvedValue({
      ok: false,
      kind: "http",
      status: 503,
      message: "unavailable",
      durationMs: 10,
    });
    renderWithClient(<FairnessReportPage />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText("Fairness report unavailable")).toBeTruthy();

    apiFetch.mockResolvedValueOnce({ ok: true, data: FIXTURE, status: 200, durationMs: 10 });
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    await waitFor(() =>
      expect(screen.getByText("Is ORB treating contributors fairly?")).toBeTruthy(),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders the empty-state copy when nothing has been reviewed yet", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      data: { ...FIXTURE, totals: { ...FIXTURE.totals, handled: 0 } },
      status: 200,
      durationMs: 10,
    });
    renderWithClient(<FairnessReportPage />);

    await waitFor(() => expect(screen.getByText("Fairness report unavailable")).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("prefers the live fleet accuracy over the own-ledger number, and shows the anti-gaming + reviewed cards", async () => {
    apiFetch.mockResolvedValue({ ok: true, data: FIXTURE, status: 200, durationMs: 10 });
    renderWithClient(<FairnessReportPage />);

    await waitFor(() => expect(screen.getByText("Decision accuracy")).toBeTruthy());
    // fleetAccuracy (92%), not the own-ledger totals.accuracyPct (97.8%) -- scoped to the stat card specifically,
    // since 97.8% legitimately also appears in the trend table below regardless of which headline is shown.
    const accuracyCard = screen.getByText("Decision accuracy").closest("div")!.parentElement!;
    expect(accuracyCard.textContent).toContain("92%");
    expect(accuracyCard.textContent).not.toContain("97.8%");
    expect(screen.getByText("Anti-gaming flags caught")).toBeTruthy();
    const gamingCard = screen.getByText("Anti-gaming flags caught").closest("div")!.parentElement!;
    expect(gamingCard.textContent).toContain("1");
    expect(screen.getByText("PRs reviewed")).toBeTruthy();
    expect(screen.getByText("By repository")).toBeTruthy();
    expect(screen.getByText("Weekly trend")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("falls back to the own-ledger accuracy when the fleet has no eligible instances", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      data: {
        ...FIXTURE,
        fleetAccuracy: {
          accuracyPct: null,
          instanceCount: 0,
          windowDays: 90,
          gamingFlagsCaught: 0,
        },
      },
      status: 200,
      durationMs: 10,
    });
    renderWithClient(<FairnessReportPage />);

    await waitFor(() => expect(screen.getByText("Decision accuracy")).toBeTruthy());
    const accuracyCard = screen.getByText("Decision accuracy").closest("div")!.parentElement!;
    expect(accuracyCard.textContent).toContain("97.8%");
    // The window comes from the payload: the headline used to say "lifetime" while the accuracy pairing
    // behind it has always been bounded by audit-log retention.
    expect(screen.getByText("2 human-reversed, last 90 days")).toBeTruthy();
  });

  it("explains a withheld accuracy instead of letting it read as a dash-shaped mystery", async () => {
    // Backend publishes null when no auto-action was ever recorded for a reversal to attach to; the page must
    // say that rather than leaving a bare "—" next to a healthy-looking volume.
    apiFetch.mockResolvedValue({
      ok: true,
      data: {
        ...FIXTURE,
        byProject: [
          { project: "owner/repo", reviewed: 100, merged: 60, closed: 30, accuracyPct: null },
        ],
        accuracyTrend: [
          { weekStart: "2026-07-13", merged: 30, closed: 15, reversed: 0, accuracyPct: null },
        ],
      },
      status: 200,
      durationMs: 10,
    });
    renderWithClient(<FairnessReportPage />);

    await waitFor(() => expect(screen.getByText("By repository")).toBeTruthy());
    const notes = screen.getAllByText(/not measurable on this deployment, not 100%/);
    expect(notes.length).toBe(2); // one under each affected table
  });

  it("#9676: renders the fleet trend as its own section, never merged into the own-ledger table", async () => {
    apiFetch.mockResolvedValue({ ok: true, data: FIXTURE, status: 200, durationMs: 10 });
    renderWithClient(<FairnessReportPage />);

    await waitFor(() => expect(screen.getByText("Weekly trend — self-hosted fleet")).toBeTruthy());
    // Two distinct sections, so a reader can never read one population's number off the other's row.
    expect(screen.getByText("Weekly trend")).toBeTruthy();
    expect(screen.getByText("Decisions scored")).toBeTruthy();
    expect(screen.getByText("92.5%")).toBeTruthy();
  });

  it("#9676: hides the fleet trend entirely when no week has a scored verdict", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      data: {
        ...FIXTURE,
        fleetAccuracyTrend: [{ weekStart: "2026-07-13", verdicts: null, accuracyPct: null }],
      },
      status: 200,
      durationMs: 10,
    });
    renderWithClient(<FairnessReportPage />);

    await waitFor(() => expect(screen.getByText("Weekly trend")).toBeTruthy());
    expect(screen.queryByText("Weekly trend — self-hosted fleet")).toBeNull();
  });

  it("does not show the unmeasurable-accuracy note when every accuracy is real", async () => {
    apiFetch.mockResolvedValue({ ok: true, data: FIXTURE, status: 200, durationMs: 10 });
    renderWithClient(<FairnessReportPage />);

    await waitFor(() => expect(screen.getByText("By repository")).toBeTruthy());
    expect(screen.queryByText(/not measurable on this deployment/)).toBeNull();
  });

  it("#9168: discloses a single-instance self-report rather than presenting it as fleet corroboration", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      data: {
        ...FIXTURE,
        fleetAccuracy: {
          ...FIXTURE.fleetAccuracy,
          instanceCount: 1,
          basis: "single_instance_self_report",
          decidedCount: 5225,
          accuracyCiPct: { lo: 93.9, hi: 95.2 },
        },
      },
      status: 200,
      durationMs: 10,
    });
    renderWithClient(<FairnessReportPage />);

    await waitFor(() => expect(screen.getByText("Decision accuracy")).toBeTruthy());
    expect(screen.getByText(/Self-reported by that single instance/).textContent).toContain(
      "5,225 decided",
    );
    expect(screen.getByText(/Self-reported by that single instance/).textContent).toContain(
      "93.9–95.2%",
    );
  });

  it("#9673: renders the fleet-methodology paragraph when basis is a genuine fleet aggregate", async () => {
    apiFetch.mockResolvedValue({ ok: true, data: FIXTURE, status: 200, durationMs: 10 });
    renderWithClient(<FairnessReportPage />);

    await waitFor(() => expect(screen.getByText("Decision accuracy")).toBeTruthy());
    expect(screen.getByText(/Why the fleet number, not just our own repos/)).toBeTruthy();
  });

  it("#9673: hides the fleet-methodology paragraph when basis is one instance's own self-report", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      data: {
        ...FIXTURE,
        fleetAccuracy: {
          ...FIXTURE.fleetAccuracy,
          instanceCount: 1,
          basis: "single_instance_self_report",
        },
      },
      status: 200,
      durationMs: 10,
    });
    renderWithClient(<FairnessReportPage />);

    await waitFor(() => expect(screen.getByText("Decision accuracy")).toBeTruthy());
    expect(screen.queryByText(/Why the fleet number, not just our own repos/)).toBeNull();
    // The card caption also drops the fleet framing rather than reporting "1 self-hosted instance" as corroboration.
    expect(
      screen.getByText(
        "self-reported by one self-hosted instance, not corroborated across operators, last 90 days",
      ),
    ).toBeTruthy();
  });

  it("REGRESSION #9673: a weekly trend row with merged/closed/reversed all null still renders as — without throwing", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      data: {
        ...FIXTURE,
        accuracyTrend: [
          {
            weekStart: "2026-01-05",
            merged: null,
            closed: null,
            reversed: null,
            accuracyPct: null,
          },
        ],
      },
      status: 200,
      durationMs: 10,
    });
    renderWithClient(<FairnessReportPage />);

    await waitFor(() => expect(screen.getByText("Weekly trend")).toBeTruthy());
    const row = screen.getByText("2026-01-05").closest("tr")!;
    expect(row.textContent).toBe("2026-01-05————");
  });

  it("#9068: renders the insufficient-instances state (not a fabricated zero) when gamingFlagsCaught is null", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      data: { ...FIXTURE, fleetAccuracy: { ...FIXTURE.fleetAccuracy, gamingFlagsCaught: null } },
      status: 200,
      durationMs: 10,
    });
    renderWithClient(<FairnessReportPage />);
    await waitFor(() => expect(screen.getByText("Anti-gaming flags caught")).toBeTruthy());
    const gamingCard = screen.getByText("Anti-gaming flags caught").closest("div")!.parentElement!;
    expect(gamingCard.textContent).toContain("—");
    expect(gamingCard.textContent).toContain("not enough registered instances");
  });

  it("REGRESSION: does not crash when the API response predates the fleetAccuracy field (old backend/new frontend deployment skew)", async () => {
    const { fleetAccuracy: _omitted, ...payloadWithoutFleetAccuracy } = FIXTURE;
    apiFetch.mockResolvedValue({
      ok: true,
      data: payloadWithoutFleetAccuracy,
      status: 200,
      durationMs: 10,
    });
    renderWithClient(<FairnessReportPage />);

    await waitFor(() => expect(screen.getByText("Decision accuracy")).toBeTruthy());
    const accuracyCard = screen.getByText("Decision accuracy").closest("div")!.parentElement!;
    expect(accuracyCard.textContent).toContain("97.8%"); // falls back to the own-ledger number
    expect(
      screen.getByText("Anti-gaming flags caught").closest("div")!.parentElement!.textContent,
    ).toContain("—");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // #9744: the two series #9743 computes, and the zero-state conventions they must honour.
  function parityFixture(over: Record<string, unknown>) {
    return {
      ok: true,
      durationMs: 10,
      data: {
        ...FIXTURE,
        reviewParity: {
          windowStart: "2026-07-22T00:00:00.000Z",
          windowEnd: "2026-07-29T00:00:00.000Z",
          verdicts: 0,
          reevaluations: 0,
          reevaluationRatePct: null,
          byReason: [],
          byAuthorClass: [],
          byProject: [],
          ...over,
        },
      },
    };
  }

  it("renders the re-evaluation reason table and the author-class parity table", async () => {
    apiFetch.mockResolvedValue(
      parityFixture({
        verdicts: 10,
        reevaluations: 3,
        reevaluationRatePct: 30,
        byReason: [{ reason: "scheduled_recheck", count: 3, shareOfVerdictsPct: 30 }],
        byAuthorClass: [
          {
            authorClass: "maintainer",
            verdicts: 4,
            pullRequests: 4,
            reviewsPerPr: 1,
            findingsPerPr: 2,
            findingsBasis: 4,
            closeRate: 0,
            holdRate: 25,
          },
          {
            authorClass: "contributor",
            verdicts: 6,
            pullRequests: 3,
            reviewsPerPr: 2,
            findingsPerPr: null,
            findingsBasis: 0,
            closeRate: 50,
            holdRate: 0,
          },
        ],
      }),
    );
    renderWithClient(<FairnessReportPage />);

    expect(await screen.findByText(/Re-evaluation and review parity/i)).toBeTruthy();
    expect(screen.getByText("scheduled_recheck")).toBeTruthy();
    expect(screen.getByText(/3 of 10 verdicts were re-evaluations/i)).toBeTruthy();
    expect(screen.getByText("maintainer")).toBeTruthy();
    expect(screen.getByText("contributor")).toBeTruthy();
    // The coverage a mean was earned at is published beside it, and an absent mean reads as
    // insufficient data rather than as 0.
    expect(screen.getByText(/n=4/)).toBeTruthy();
    expect(screen.getAllByText(/insufficient data/i).length).toBeGreaterThan(0);
  });

  it("renders an EMPTY window as a measured zero with its dates, not as missing data", async () => {
    apiFetch.mockResolvedValue(parityFixture({}));
    renderWithClient(<FairnessReportPage />);

    expect(await screen.findByText(/No verdicts recorded/i)).toBeTruthy();
    expect(screen.getByText(/measured zero over the dates above, not missing data/i)).toBeTruthy();
  });

  it("distinguishes 'no re-evaluations' from 'no verdicts' — both are measured zeros, not the same one", async () => {
    apiFetch.mockResolvedValue(
      parityFixture({
        verdicts: 5,
        reevaluationRatePct: 0,
        byAuthorClass: [
          {
            authorClass: "contributor",
            verdicts: 5,
            pullRequests: 5,
            reviewsPerPr: 1,
            findingsPerPr: 1,
            findingsBasis: 5,
            closeRate: 20,
            holdRate: 0,
          },
        ],
      }),
    );
    renderWithClient(<FairnessReportPage />);

    expect(await screen.findByText(/No re-evaluations recorded/i)).toBeTruthy();
    expect(screen.queryByText(/No verdicts recorded/i)).toBeNull();
  });

  // #9728: the automation-rate surface and its zero/reduced-basis states.
  function automationFixture(over: Record<string, unknown>) {
    return {
      ok: true,
      durationMs: 10,
      data: {
        ...FIXTURE,
        automationRate: {
          weeks: [],
          decided: 0,
          automated: 0,
          automationRatePct: null,
          provenanceHorizon: "2026-07-29T00:00:00.000Z",
          ...over,
        },
      },
    };
  }

  it("renders the headline rate, the weekly table, and the definition", async () => {
    apiFetch.mockResolvedValue(
      automationFixture({
        decided: 10,
        automated: 7,
        automationRatePct: 70,
        weeks: [
          {
            weekStart: "2026-07-27T00:00:00.000Z",
            decided: 10,
            automated: 7,
            manual: 3,
            automationRatePct: 70,
            basis: "full",
          },
        ],
      }),
    );
    renderWithClient(<FairnessReportPage />);

    expect(await screen.findByText(/Automation rate/i)).toBeTruthy();
    expect(screen.getByText(/70% automated/)).toBeTruthy();
    expect(screen.getByText(/7 of 10 pull requests/)).toBeTruthy();
    // The definition must be readable without opening source -- that is #9728's acceptance.
    expect(screen.getByText(/no human action/i)).toBeTruthy();
    expect(screen.getByText(/counts as manual even if it later merged/i)).toBeTruthy();
  });

  it("labels reduced-basis weeks and explains that they UNDER-count manual work", async () => {
    apiFetch.mockResolvedValue(
      automationFixture({
        decided: 4,
        automated: 4,
        automationRatePct: 100,
        weeks: [
          {
            weekStart: "2026-07-06T00:00:00.000Z",
            decided: 4,
            automated: 4,
            manual: 0,
            automationRatePct: 100,
            basis: "holds_only",
          },
        ],
      }),
    );
    renderWithClient(<FairnessReportPage />);

    expect(
      (await screen.findAllByText(/reduced basis/i)).length,
      "the row badge and the footnote both say it",
    ).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/under-count it rather than over-count it/i)).toBeTruthy();
  });

  it("renders an empty window as a measured zero, not as missing data", async () => {
    apiFetch.mockResolvedValue(automationFixture({}));
    renderWithClient(<FairnessReportPage />);

    expect(await screen.findByText(/No pull requests decided/i)).toBeTruthy();
    expect(screen.getByText(/measured zero, not missing data/i)).toBeTruthy();
  });
});
