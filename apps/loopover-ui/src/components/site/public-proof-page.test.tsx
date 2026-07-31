import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PublicProofPage, type ProofSummary } from "./public-proof-page";

// #9569: the public proof page.
//
// What is worth testing here is not that cards render — it is the JUDGEMENT the page encodes, because every
// one of these states is a place where a plausible implementation says something untrue:
//
//   • a repo below the sample floor must show its decision COUNT and no rate. Hiding the count with the
//     figure, or printing 0%, both misrepresent "we have 7 decisions, too few to claim a rate".
//   • not-yet-anchored and empty-ledger are NEUTRAL. A page that renders a new repo as an error is lying in
//     the more damaging direction than one that says nothing.
//   • a genuinely BROKEN ledger is the one state that must read as a problem, and must name where it broke.
//   • an opted-out repo (404) is an empty state, not an error state — different ARIA role, different meaning.
//   • the boundary statement comes from the PAYLOAD. Hardcoding it here would let a screenshot or embed shed
//     the caveat while keeping the numbers.

const summary = (over: Partial<ProofSummary> = {}): ProofSummary => ({
  schemaVersion: 1,
  repoFullName: "acme/widgets",
  decisionCount: 128,
  accuracy: {
    state: "published",
    accuracy: 0.964,
    decided: 112,
    confirmed: 108,
    interval: { lo: 0.912, hi: 0.987 },
  },
  ledger: {
    state: "verified",
    tipSeq: 128,
    totalCount: 128,
    checkedAt: "2026-07-31T12:00:00.000Z",
  },
  anchor: {
    state: "anchored",
    backend: "rekor",
    seq: 128,
    rowHash: "a".repeat(64),
    at: "2026-07-30T00:00:00.000Z",
  },
  sampleRecords: [
    {
      pullNumber: 42,
      action: "merge",
      reasonCode: "gate_pass",
      decidedAt: "2026-07-30T10:00:00.000Z",
      recordDigest: "b".repeat(64),
    },
  ],
  boundary:
    "This page proves what was decided and that the record is intact. It does not prove the decisions were correct.",
  ...over,
});

/** Renders with fetch stubbed to one response, then waits for the query to settle. */
async function renderPage(response: { status: number; body?: unknown }): Promise<void> {
  vi.stubGlobal("fetch", async () =>
    response.status === 200
      ? new Response(JSON.stringify(response.body), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      : new Response(JSON.stringify({ error: "not_found" }), {
          status: response.status,
          headers: { "content-type": "application/json" },
        }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PublicProofPage owner="acme" repo="widgets" />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.queryByText(/acme\/widgets/)).toBeTruthy());
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PublicProofPage (#9569)", () => {
  it("shows the accuracy WITH its denominator and interval, never as a bare percentage", async () => {
    await renderPage({ status: 200, body: summary() });
    await waitFor(() => expect(screen.getByText("96.4%")).toBeTruthy());
    // The denominator and the interval are what make the number arguable rather than promotional.
    expect(screen.getByText(/108 of 112 decisions confirmed/)).toBeTruthy();
    expect(screen.getByText(/91\.2%–98\.7%/)).toBeTruthy();
  });

  it("REGRESSION: below the sample floor it publishes the COUNT and no rate", async () => {
    await renderPage({
      status: 200,
      body: summary({ accuracy: { state: "insufficient_data", decided: 7, minimumDecisions: 20 } }),
    });
    await waitFor(() => expect(screen.getByText(/7 decisions so far/)).toBeTruthy());
    expect(screen.getByText(/fewer than the 20 needed/)).toBeTruthy();
    // The failure mode this guards: rendering a fabricated 0% for "no data".
    expect(screen.queryByText("0%")).toBeNull();
  });

  it("renders not-yet-anchored as a NEUTRAL state, not an error", async () => {
    await renderPage({ status: 200, body: summary({ anchor: { state: "not_yet_anchored" } }) });
    await waitFor(() => expect(screen.getByText("Not yet anchored")).toBeTruthy());
    expect(screen.getByText(/The chain is still self-verifying/)).toBeTruthy();
  });

  it("renders an empty ledger as a new repository, not a failing one", async () => {
    await renderPage({
      status: 200,
      body: summary({ ledger: { state: "empty", checkedAt: "2026-07-31T12:00:00.000Z" } }),
    });
    await waitFor(() => expect(screen.getByText("No decisions recorded yet")).toBeTruthy());
    expect(screen.getByText(/not a failing one/)).toBeTruthy();
  });

  it("REGRESSION: a BROKEN ledger is stated as a problem, naming the row and the kind", async () => {
    // The one state that must not be softened — and the kind of break is the actionable half.
    await renderPage({
      status: 200,
      body: summary({
        ledger: {
          state: "broken",
          tipSeq: 128,
          totalCount: 128,
          checkedAt: "2026-07-31T12:00:00.000Z",
          brokenAtSeq: 57,
          brokenKind: "row_hash_mismatch",
        },
      }),
    });
    await waitFor(() => expect(screen.getByText("Ledger verification failed")).toBeTruthy());
    expect(screen.getByText(/sequence 57 of 128 \(row_hash_mismatch\)/)).toBeTruthy();
  });

  it("says an unavailable verification is not a claim that anything is wrong", async () => {
    await renderPage({
      status: 200,
      body: summary({ ledger: { state: "unavailable", checkedAt: "2026-07-31T12:00:00.000Z" } }),
    });
    await waitFor(() => expect(screen.getByText("Ledger state unavailable")).toBeTruthy());
    expect(screen.getByText(/not a claim that anything is wrong/)).toBeTruthy();
  });

  it("INVARIANT: renders the boundary statement from the payload, not from this component", async () => {
    // Carried in the response so an embed or screenshot cannot shed the caveat while keeping the figures.
    const boundary = "A bespoke boundary sentence that exists only in this fixture.";
    await renderPage({ status: 200, body: summary({ boundary }) });
    await waitFor(() => expect(screen.getByText(boundary)).toBeTruthy());
  });

  it("treats an opted-out repo (404) as EMPTY, not as an error", async () => {
    // Different meaning and a different ARIA role: telling an opted-out repo that something broke would be
    // wrong, and would invite someone to go looking for a fault that does not exist.
    await renderPage({ status: 404 });
    await waitFor(() => expect(screen.getByText(/No public proof page/)).toBeTruthy());
    expect(screen.queryByText(/Proof summary unavailable/)).toBeNull();
  });

  it("shows sample records with a digest that can be checked", async () => {
    await renderPage({ status: 200, body: summary() });
    await waitFor(() => expect(screen.getByText("#42")).toBeTruthy());
    expect(screen.getByText("gate_pass")).toBeTruthy();
    // Truncated for the eye, complete in the title — a shortened digest with no way back to the full value
    // cannot be checked against anything.
    expect(screen.getByTitle("b".repeat(64))).toBeTruthy();
  });

  it("omits the sample-records card entirely when there are none", async () => {
    await renderPage({ status: 200, body: summary({ sampleRecords: [] }) });
    await waitFor(() => expect(screen.getByText("Decisions")).toBeTruthy());
    expect(screen.queryByText("Sample decision records")).toBeNull();
  });
});
