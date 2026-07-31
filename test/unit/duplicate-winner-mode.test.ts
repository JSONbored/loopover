import { describe, expect, it } from "vitest";
import { isDuplicateWinnerEnabledGlobally, resolveDuplicateWinnerEnabled } from "../../src/settings/duplicate-winner-mode";

describe("isDuplicateWinnerEnabledGlobally", () => {
  it("defaults OFF when unset", () => {
    expect(isDuplicateWinnerEnabledGlobally({})).toBe(false);
    expect(isDuplicateWinnerEnabledGlobally({ LOOPOVER_DUPLICATE_WINNER: undefined })).toBe(false);
    expect(isDuplicateWinnerEnabledGlobally({ LOOPOVER_DUPLICATE_WINNER: "" })).toBe(false);
  });

  it("is ON for every value the codebase truthy convention accepts (#10054)", () => {
    // Was `=== "true"` only, which silently read `1` / `on` / `TRUE` / a whitespace-padded `.env` value as
    // OFF. It now mirrors selfTuneFlagOn's `/^(1|true|yes|on)$/i.test((X ?? "").trim())`, trimmed + i-flag.
    for (const value of ["1", "true", "TRUE", "yes", "on", " true "]) {
      expect(isDuplicateWinnerEnabledGlobally({ LOOPOVER_DUPLICATE_WINNER: value }), value).toBe(true);
    }
  });

  it("stays OFF for a falsy or unrecognised value", () => {
    for (const value of ["0", "false", "off", "no", "maybe"]) {
      expect(isDuplicateWinnerEnabledGlobally({ LOOPOVER_DUPLICATE_WINNER: value }), value).toBe(false);
    }
  });

  it("the =1 form an operator naturally writes actually enables the feature through the resolver (#10054)", () => {
    // The end-to-end regression: `1` is the value the convention regex accepts first and env.d.ts publishes
    // for a sibling flag, but under `=== "true"` it read OFF -- so a repo on `inherit` stayed off even after
    // the operator set it. The fix must carry all the way through resolveDuplicateWinnerEnabled.
    expect(resolveDuplicateWinnerEnabled(isDuplicateWinnerEnabledGlobally({ LOOPOVER_DUPLICATE_WINNER: "1" }), "inherit")).toBe(true);
  });
});

describe("resolveDuplicateWinnerEnabled", () => {
  it("inherit defers to the global default in both directions", () => {
    expect(resolveDuplicateWinnerEnabled(true, "inherit")).toBe(true);
    expect(resolveDuplicateWinnerEnabled(false, "inherit")).toBe(false);
  });

  it("null/undefined mode behaves the same as inherit", () => {
    expect(resolveDuplicateWinnerEnabled(true, null)).toBe(true);
    expect(resolveDuplicateWinnerEnabled(false, undefined)).toBe(false);
  });

  it("off fully overrides a globally-ON default", () => {
    expect(resolveDuplicateWinnerEnabled(true, "off")).toBe(false);
  });

  it("enabled fully overrides a globally-OFF default (symmetric)", () => {
    expect(resolveDuplicateWinnerEnabled(false, "enabled")).toBe(true);
  });
});
