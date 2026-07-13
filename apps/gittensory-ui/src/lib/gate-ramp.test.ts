import { describe, expect, it } from "vitest";

import {
  buildBlockingRampPatch,
  deriveGateRampPhase,
  isBlockingRampComplete,
  isGateRampActive,
  listRampGateTransitions,
  summarizeGateRamp,
} from "@/lib/gate-ramp";

const ADVISORY_SLICE = {
  reviewCheckMode: "required" as const,
  linkedIssueGateMode: "advisory" as const,
  duplicatePrGateMode: "advisory" as const,
  qualityGateMode: "advisory" as const,
};

const BLOCKING_SLICE = {
  ...ADVISORY_SLICE,
  linkedIssueGateMode: "block" as const,
  duplicatePrGateMode: "block" as const,
  qualityGateMode: "block" as const,
};

describe("gate-ramp helpers (#2218)", () => {
  it("treats reviewCheckMode disabled as inactive", () => {
    const disabled = { ...ADVISORY_SLICE, reviewCheckMode: "disabled" as const };
    expect(isGateRampActive(disabled)).toBe(false);
    expect(deriveGateRampPhase(disabled)).toBe("inactive");
  });

  it("treats reviewCheckMode visible or required as active", () => {
    expect(isGateRampActive(ADVISORY_SLICE)).toBe(true);
    expect(isGateRampActive({ ...ADVISORY_SLICE, reviewCheckMode: "visible" })).toBe(true);
  });

  it("detects advisory and blocking phases from the ramp trio", () => {
    expect(deriveGateRampPhase(ADVISORY_SLICE)).toBe("advisory");
    expect(isBlockingRampComplete(ADVISORY_SLICE)).toBe(false);
    expect(deriveGateRampPhase(BLOCKING_SLICE)).toBe("blocking");
    expect(isBlockingRampComplete(BLOCKING_SLICE)).toBe(true);
  });

  it("summarizeGateRamp exposes ramp affordances only in advisory phase", () => {
    const inactive = summarizeGateRamp({ ...ADVISORY_SLICE, reviewCheckMode: "disabled" });
    expect(inactive.label).toBe("Gate off");
    expect(inactive.canRampToBlocking).toBe(false);
    expect(inactive.isBlocking).toBe(false);

    const advisory = summarizeGateRamp(ADVISORY_SLICE);
    expect(advisory.label).toBe("Advisory");
    expect(advisory.canRampToBlocking).toBe(true);
    expect(advisory.isBlocking).toBe(false);

    const blocking = summarizeGateRamp(BLOCKING_SLICE);
    expect(blocking.label).toBe("Blocking");
    expect(blocking.canRampToBlocking).toBe(false);
    expect(blocking.isBlocking).toBe(true);
  });

  it("buildBlockingRampPatch flips the deterministic trio to block", () => {
    expect(buildBlockingRampPatch()).toEqual({
      linkedIssueGateMode: "block",
      duplicatePrGateMode: "block",
      qualityGateMode: "block",
    });
  });

  it("listRampGateTransitions lists all three when none are blocking yet", () => {
    const transitions = listRampGateTransitions(ADVISORY_SLICE);
    expect(transitions).toHaveLength(3);
    expect(transitions).toEqual([
      { key: "linkedIssueGateMode", from: "advisory", to: "block" },
      { key: "duplicatePrGateMode", from: "advisory", to: "block" },
      { key: "qualityGateMode", from: "advisory", to: "block" },
    ]);
  });

  it("listRampGateTransitions omits gates already at the target mode", () => {
    const mixed = { ...ADVISORY_SLICE, duplicatePrGateMode: "block" as const };
    const transitions = listRampGateTransitions(mixed);
    expect(transitions).toHaveLength(2);
    expect(transitions.map((t) => t.key)).toEqual(["linkedIssueGateMode", "qualityGateMode"]);
  });

  it("listRampGateTransitions is empty once every gate is already blocking", () => {
    expect(listRampGateTransitions(BLOCKING_SLICE)).toEqual([]);
  });
});
