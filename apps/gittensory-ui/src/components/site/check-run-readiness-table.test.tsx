import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CheckRunReadinessTable } from "@/components/site/check-run-readiness-table";
import {
  resolveCheckRunReadinessView,
  shouldShowCheckRunReadinessTable,
  type CheckRunReadinessTableData,
} from "@/components/site/check-run-readiness-model";

const SAMPLE: CheckRunReadinessTableData = {
  readinessBand: "developing",
  components: [
    {
      key: "validation",
      label: "Validation posture",
      band: "partial",
      evidence: "Test plan noted but not verified.",
      action: "Run the documented test plan.",
    },
  ],
};

describe("shouldShowCheckRunReadinessTable", () => {
  it("shows at standard and deep, hides at minimal", () => {
    expect(shouldShowCheckRunReadinessTable("minimal")).toBe(false);
    expect(shouldShowCheckRunReadinessTable("standard")).toBe(true);
    expect(shouldShowCheckRunReadinessTable("deep")).toBe(true);
  });
});

describe("resolveCheckRunReadinessView", () => {
  it("returns null below standard detail level even when readiness is present", () => {
    expect(resolveCheckRunReadinessView({ detailLevel: "minimal", readiness: SAMPLE })).toBeNull();
  });

  it("returns null for an empty readiness component set at standard (both gate-off and gate-on shapes)", () => {
    const empty: CheckRunReadinessTableData = { readinessBand: "early", components: [] };
    expect(resolveCheckRunReadinessView({ detailLevel: "standard", readiness: empty })).toBeNull();
    expect(resolveCheckRunReadinessView({ detailLevel: "deep", readiness: empty })).toBeNull();
  });

  it("returns the readiness payload at standard when components are present", () => {
    expect(resolveCheckRunReadinessView({ detailLevel: "standard", readiness: SAMPLE })).toEqual(SAMPLE);
  });
});

describe("CheckRunReadinessTable", () => {
  it("renders the table at standard detail level", () => {
    render(<CheckRunReadinessTable detailLevel="standard" readiness={SAMPLE} />);
    expect(screen.getByText("Context check readiness")).toBeTruthy();
    expect(screen.getByText("Validation posture")).toBeTruthy();
    expect(screen.getByText("Test plan noted but not verified.")).toBeTruthy();
    expect(screen.getByText("Developing")).toBeTruthy();
    expect(screen.getByText("Partial")).toBeTruthy();
  });

  it("hides the table at minimal detail level", () => {
    render(<CheckRunReadinessTable detailLevel="minimal" readiness={SAMPLE} />);
    expect(screen.queryByText("Context check readiness")).toBeNull();
  });

  it("hides the table when the readiness component set is empty", () => {
    render(
      <CheckRunReadinessTable
        detailLevel="standard"
        readiness={{ readinessBand: "early", components: [] }}
      />,
    );
    expect(screen.queryByText("Context check readiness")).toBeNull();
  });
});
