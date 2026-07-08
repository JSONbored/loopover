import { describe, expect, it } from "vitest";
import { formatImpactMapPromptSection, isImpactMapEnabled, shouldComputeImpactMap } from "../../src/review/impact-map-wire";
import type { ImpactMapEntry } from "../../src/review/impact-map";

describe("isImpactMapEnabled", () => {
  it("is OFF for unset/false and ON for the truthy convention", () => {
    expect(isImpactMapEnabled({})).toBe(false);
    expect(isImpactMapEnabled({ GITTENSORY_REVIEW_IMPACT_MAP: "false" })).toBe(false);
    expect(isImpactMapEnabled({ GITTENSORY_REVIEW_IMPACT_MAP: "true" })).toBe(true);
    expect(isImpactMapEnabled({ GITTENSORY_REVIEW_IMPACT_MAP: "1" })).toBe(true);
    expect(isImpactMapEnabled({ GITTENSORY_REVIEW_IMPACT_MAP: "on" })).toBe(true);
    expect(isImpactMapEnabled({ GITTENSORY_REVIEW_IMPACT_MAP: "yes" })).toBe(true);
  });
});

describe("shouldComputeImpactMap (#4102 precedence: env kill-switch, then manifestToggle === true fully decides)", () => {
  it("is ON when the operator flag is on and the manifest explicitly opted in", () => {
    expect(shouldComputeImpactMap({ GITTENSORY_REVIEW_IMPACT_MAP: "true" }, true)).toBe(true);
  });

  it("is OFF when the operator flag is on but the manifest explicitly opted out", () => {
    expect(shouldComputeImpactMap({ GITTENSORY_REVIEW_IMPACT_MAP: "true" }, false)).toBe(false);
  });

  it("is OFF when the operator flag is on but the manifest toggle is unset (regression: preserves the ORIGINAL always-off default — there is no allowlist fallback for impactMap)", () => {
    expect(shouldComputeImpactMap({ GITTENSORY_REVIEW_IMPACT_MAP: "true" }, undefined)).toBe(false);
  });

  it("is OFF when the manifest opted in but the operator flag is off — the env flag is an absolute master kill-switch no per-repo config can bypass", () => {
    expect(shouldComputeImpactMap({ GITTENSORY_REVIEW_IMPACT_MAP: "false" }, true)).toBe(false);
  });

  it("is OFF when the operator flag is unset and the manifest opted in — the kill-switch still wins", () => {
    expect(shouldComputeImpactMap({}, true)).toBe(false);
  });

  it("is OFF when both are off", () => {
    expect(shouldComputeImpactMap({}, false)).toBe(false);
  });

  it("is OFF when both are unset", () => {
    expect(shouldComputeImpactMap({}, undefined)).toBe(false);
  });
});

describe("formatImpactMapPromptSection (#2186)", () => {
  const entry = (changedModule: string, affectedModules: string[], callers: string[] = ["a"]): ImpactMapEntry => ({
    changedModule,
    affectedModules,
    callers,
  });

  it("returns '' for an empty impact map (prompt stays byte-identical)", () => {
    expect(formatImpactMapPromptSection([])).toBe("");
  });

  it("formats a populated impact map with header, entries, and footer markers", () => {
    const section = formatImpactMapPromptSection([entry("src/review/impact-map.ts", ["src/queue/processors.ts"], ["computeImpactMap"])]);
    expect(section).toContain("=== IMPACT MAP (deterministic, from the codebase index — NOT an AI guess) ===");
    expect(section).toContain("src/review/impact-map.ts");
    expect(section).toContain("computeImpactMap");
    expect(section).toContain("src/queue/processors.ts");
    expect(section).toContain("=== END IMPACT MAP ===");
  });

  it("truncates with a notice once the entry count exceeds MAX_PROMPT_ENTRIES", () => {
    const many = Array.from({ length: 15 }, (_, i) => entry(`src/file${i}.ts`, [`src/caller${i}.ts`]));
    const section = formatImpactMapPromptSection(many);
    expect(section).toContain("src/file0.ts");
    expect(section).toContain("src/file9.ts");
    expect(section).not.toContain("src/file10.ts");
    expect(section).toContain("additional impact-map entries omitted to stay within budget");
  });

  it("truncates with a notice once the char budget is exhausted, even under the entry-count cap", () => {
    // A handful of entries with very long affected-module lists blow the char budget well before the
    // 10-entry count cap — the SIZE guard must fire independently of the COUNT guard.
    const huge = Array.from({ length: 5 }, (_, i) =>
      entry(`src/file${i}.ts`, Array.from({ length: 50 }, (_, j) => `src/very/long/module/path/number/${i}/${j}.ts`)),
    );
    const section = formatImpactMapPromptSection(huge);
    expect(section.length).toBeLessThanOrEqual(6000 + 200); // header/footer overhead, still well bounded
    expect(section).toContain("additional impact-map entries omitted to stay within budget");
  });

  it("does not append a truncation notice when everything fits", () => {
    const section = formatImpactMapPromptSection([entry("src/a.ts", ["src/b.ts"])]);
    expect(section).not.toContain("omitted to stay within budget");
  });
});
