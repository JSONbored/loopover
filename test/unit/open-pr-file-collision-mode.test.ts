import { describe, expect, it } from "vitest";
import { isOpenPrFileCollisionEnabledGlobally, resolveOpenPrFileCollisionEnabled } from "../../src/settings/open-pr-file-collision-mode";

describe("isOpenPrFileCollisionEnabledGlobally", () => {
  it("defaults OFF when unset", () => {
    expect(isOpenPrFileCollisionEnabledGlobally({})).toBe(false);
    expect(isOpenPrFileCollisionEnabledGlobally({ LOOPOVER_OPEN_PR_FILE_COLLISION: undefined })).toBe(false);
    expect(isOpenPrFileCollisionEnabledGlobally({ LOOPOVER_OPEN_PR_FILE_COLLISION: "" })).toBe(false);
  });

  it("is ON for every value the codebase truthy convention accepts (#10054)", () => {
    // Was `=== "true"` only, which silently read `1` / `on` / `TRUE` / a whitespace-padded `.env` value as
    // OFF. It now mirrors selfTuneFlagOn's `/^(1|true|yes|on)$/i.test((X ?? "").trim())`, trimmed + i-flag.
    for (const value of ["1", "true", "TRUE", "yes", "on", " true "]) {
      expect(isOpenPrFileCollisionEnabledGlobally({ LOOPOVER_OPEN_PR_FILE_COLLISION: value }), value).toBe(true);
    }
  });

  it("stays OFF for a falsy or unrecognised value", () => {
    for (const value of ["0", "false", "off", "no", "maybe"]) {
      expect(isOpenPrFileCollisionEnabledGlobally({ LOOPOVER_OPEN_PR_FILE_COLLISION: value }), value).toBe(false);
    }
  });
});

describe("resolveOpenPrFileCollisionEnabled", () => {
  it("inherit defers to the global default in both directions", () => {
    expect(resolveOpenPrFileCollisionEnabled(true, "inherit")).toBe(true);
    expect(resolveOpenPrFileCollisionEnabled(false, "inherit")).toBe(false);
  });

  it("null/undefined mode behaves the same as inherit", () => {
    expect(resolveOpenPrFileCollisionEnabled(true, null)).toBe(true);
    expect(resolveOpenPrFileCollisionEnabled(false, undefined)).toBe(false);
  });

  it("off fully overrides a globally-ON default", () => {
    expect(resolveOpenPrFileCollisionEnabled(true, "off")).toBe(false);
  });

  it("enabled fully overrides a globally-OFF default (symmetric)", () => {
    expect(resolveOpenPrFileCollisionEnabled(false, "enabled")).toBe(true);
  });
});
