import { describe, expect, it } from "vitest";
import {
  advisoryCheckRunsKeyPart,
  isAdvisoryCheckRunSettledPass,
  matchesConfiguredAdvisoryCheckRun,
  resolveAdvisoryCheckHold,
} from "../../src/github/advisory-check-runs.js";

const EXAMPLE_SPECS = [{ name: "Example trust scan", appSlug: "example-trust-app" }] as const;

describe("advisory-check-runs (#4372)", () => {
  it("matches configured check-runs by name + app slug case-insensitively", () => {
    expect(
      matchesConfiguredAdvisoryCheckRun(
        { name: "  Example Trust Scan ", app: { slug: "Example-Trust-App" } },
        EXAMPLE_SPECS,
      ),
    ).toBe(true);
    expect(matchesConfiguredAdvisoryCheckRun({ name: "Example trust scan", app: { slug: "other-app" } }, EXAMPLE_SPECS)).toBe(false);
    expect(matchesConfiguredAdvisoryCheckRun({ name: "Other scan", app: { slug: "example-trust-app" } }, EXAMPLE_SPECS)).toBe(false);
  });

  it("treats success/neutral/skipped as settled pass conclusions", () => {
    expect(isAdvisoryCheckRunSettledPass("success")).toBe(true);
    expect(isAdvisoryCheckRunSettledPass("NEUTRAL")).toBe(true);
    expect(isAdvisoryCheckRunSettledPass("skipped")).toBe(true);
    expect(isAdvisoryCheckRunSettledPass("action_required")).toBe(false);
    expect(isAdvisoryCheckRunSettledPass("failure")).toBe(false);
  });

  it("builds a stable cache-key fragment for configured specs", () => {
    expect(advisoryCheckRunsKeyPart([])).toBe("");
    expect(advisoryCheckRunsKeyPart(null)).toBe("");
    expect(advisoryCheckRunsKeyPart([{ name: "B", appSlug: "b-app" }, { name: "A", appSlug: "a-app" }])).toBe(
      JSON.stringify([
        { name: "A", appSlug: "a-app" },
        { name: "B", appSlug: "b-app" },
      ]),
    );
  });

  it("resolves a manual-review hold with a public-safe comment naming the check/app", () => {
    const hold = resolveAdvisoryCheckHold(
      [{ name: "Example trust scan", appSlug: "example-trust-app", summary: "Needs operator review" }],
      EXAMPLE_SPECS,
    );
    expect(hold?.checkNames).toEqual(["Example trust scan"]);
    expect(hold?.reason).toContain("Example trust scan");
    expect(hold?.comment).toContain("example-trust-app");
    expect(hold?.comment).toContain("Needs operator review");
    expect(resolveAdvisoryCheckHold([], EXAMPLE_SPECS)).toBeUndefined();
    expect(resolveAdvisoryCheckHold([{ name: "Example trust scan" }], null)).toBeUndefined();
  });
});
