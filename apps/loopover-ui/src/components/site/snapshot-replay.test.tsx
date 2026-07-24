import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SnapshotReplay, SnapshotReplayCard } from "@/components/site/snapshot-replay";
import type { SnapshotReplayView } from "@/lib/snapshot-replay";

// (#8386) Component coverage for the audience toggle + missing/withheld footers on snapshot replay.

const PRIVATE_REASON = "AUTHENTICATED_ONLY_REASON_TEXT";

function baseView(overrides: Partial<SnapshotReplayView> = {}): SnapshotReplayView {
  return {
    status: "populated",
    viewer: "authenticated",
    snapshotId: "snap-ui-1",
    actionType: "comment",
    target: { repoFullName: "Acme/Widget", pullNumber: 1, issueNumber: null },
    generatedAt: "2026-06-01T12:00:00.000Z",
    scoringModelId: "model-1",
    confidence: "high",
    freshness: "fresh",
    sources: [],
    evidenceGaps: [],
    evidenceComplete: true,
    staleReasons: [],
    counterfactuals: [
      {
        repoFullName: "Acme/Widget",
        recommendation: "approve",
        alternatives: [
          {
            alternative: "request_changes",
            group: "verdict",
            publicSummary: "Public summary visible to both audiences.",
            reason: PRIVATE_REASON,
            facts: ["secret-fact"],
            assumptions: ["secret-assumption"],
          },
        ],
      },
    ],
    withheldPrivateFields: [],
    notice: "All replayed evidence is fresh and complete.",
    ...overrides,
  };
}

describe("SnapshotReplayCard audience toggle (#8386)", () => {
  it("defaults to the authenticated view and switches to publicSafe without leaking private reason text", () => {
    const authenticated = baseView({ viewer: "authenticated" });
    const publicSafe = baseView({
      viewer: "public",
      counterfactuals: [
        {
          repoFullName: "Acme/Widget",
          recommendation: "approve",
          alternatives: [
            {
              alternative: "request_changes",
              group: "verdict",
              publicSummary: "Public summary visible to both audiences.",
              reason: null,
              facts: [],
              assumptions: [],
            },
          ],
        },
      ],
      withheldPrivateFields: ["counterfactual_detail"],
      notice: "Public-safe notice copy.",
    });

    render(<SnapshotReplayCard authenticated={authenticated} publicSafe={publicSafe} />);

    expect(screen.getByRole("button", { name: "Authenticated" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByText(PRIVATE_REASON)).toBeTruthy();
    expect(screen.getByText("Public summary visible to both audiences.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Public-safe" }));

    expect(screen.getByRole("button", { name: "Public-safe" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.queryByText(PRIVATE_REASON)).toBeNull();
    expect(screen.getByText("Public summary visible to both audiences.")).toBeTruthy();
    expect(screen.getByText(/Private detail withheld for this context/)).toBeTruthy();
    expect(screen.getByText(/counterfactual_detail/)).toBeTruthy();
  });
});

describe("SnapshotReplay rendering (#8386)", () => {
  it("renders only the notice for missing status — no detail sections", () => {
    render(
      <SnapshotReplay
        view={baseView({
          status: "missing",
          notice: "No decision snapshot is available to replay.",
          counterfactuals: [],
          withheldPrivateFields: ["counterfactual_detail"],
        })}
      />,
    );

    const root = screen.getByTestId("snapshot-replay");
    expect(root.getAttribute("data-status")).toBe("missing");
    expect(screen.getByText("No decision snapshot is available to replay.")).toBeTruthy();
    expect(screen.queryByText("Action")).toBeNull();
    expect(screen.queryByText("Why not the alternatives")).toBeNull();
    expect(screen.queryByText(/Private detail withheld/)).toBeNull();
  });

  it("renders the withheldPrivateFields footer only when the array is non-empty", () => {
    const { rerender } = render(<SnapshotReplay view={baseView({ withheldPrivateFields: [] })} />);
    expect(screen.queryByText(/Private detail withheld for this context/)).toBeNull();

    rerender(
      <SnapshotReplay view={baseView({ withheldPrivateFields: ["counterfactual_detail"] })} />,
    );
    expect(
      screen.getByText(/Private detail withheld for this context: counterfactual_detail/),
    ).toBeTruthy();
  });
});
