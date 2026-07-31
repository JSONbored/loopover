import { describe, expect, it } from "vitest";
import { isSupersededCloseEnabledGlobally } from "../../src/settings/superseded-close-mode";

describe("isSupersededCloseEnabledGlobally (#10168)", () => {
  it("defaults OFF when unset — recognising supersession CLOSES a PR, so it must be opted into", () => {
    expect(isSupersededCloseEnabledGlobally({})).toBe(false);
    expect(isSupersededCloseEnabledGlobally({ LOOPOVER_SUPERSEDED_CLOSE: undefined })).toBe(false);
    expect(isSupersededCloseEnabledGlobally({ LOOPOVER_SUPERSEDED_CLOSE: "" })).toBe(false);
  });

  it("is ON for every value the codebase truthy convention accepts", () => {
    // Same trimmed, case-insensitive `/^(1|true|yes|on)$/i` as the sibling flags -- #10054 caught a flag that
    // was `=== "true"` only and silently read `1` / `on` / a whitespace-padded `.env` value as OFF.
    for (const value of ["1", "true", "TRUE", "yes", "on", " true "]) {
      expect(isSupersededCloseEnabledGlobally({ LOOPOVER_SUPERSEDED_CLOSE: value }), value).toBe(true);
    }
  });

  it("stays OFF for a falsy or unrecognised value", () => {
    for (const value of ["0", "false", "off", "no", "maybe"]) {
      expect(isSupersededCloseEnabledGlobally({ LOOPOVER_SUPERSEDED_CLOSE: value }), value).toBe(false);
    }
  });
});
