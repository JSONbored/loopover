import { describe, expect, it } from "vitest";
import { errorMessage, jsonString, normalizeRepoFullName, parseJson, repoParts, strippedErrorMessage } from "../../src/utils/json";

describe("JSON and string utility helpers", () => {
  it("keeps JSON parsing and stringification fallbacks explicit", () => {
    expect(parseJson<{ ok: boolean }>('{"ok":true}', { ok: false })).toEqual({ ok: true });
    expect(parseJson("{bad-json", { ok: false })).toEqual({ ok: false });
    expect(parseJson(null, { ok: false })).toEqual({ ok: false });
    expect(jsonString(undefined)).toBe("null");
    expect(jsonString({ ok: true })).toBe('{"ok":true}');
  });

  it("normalizes repo names and error messages without leaking arbitrary thrown values", () => {
    expect(normalizeRepoFullName(" JSONbored/gittensory ")).toBe("JSONbored/gittensory");
    expect(repoParts("JSONbored/gittensory")).toEqual({ owner: "JSONbored", name: "gittensory" });
    expect(repoParts("")).toEqual({ owner: "", name: "" });
    expect(repoParts("owner/nested/name")).toEqual({ owner: "owner", name: "nested/name" });

    expect(errorMessage(new Error("specific failure"))).toBe("specific failure");
    expect(errorMessage("string failure", "fallback failure")).toBe("fallback failure");
    expect(strippedErrorMessage(new Error("Error: wrapped failure"), "fallback failure")).toBe("wrapped failure");
    expect(strippedErrorMessage("string failure", "fallback failure")).toBe("fallback failure");
  });
});
