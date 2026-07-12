import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isAgentConfigured, resolveAutonomy } from "../../src/settings/autonomy";
import {
  gateConfigToJson,
  parseFocusManifest,
  parseFocusManifestContent,
  resolveReviewPathInstructions,
  resolveReviewPromptOverrides,
  reviewConfigToJson,
} from "../../src/signals/focus-manifest";
import { lintManifestText } from "../../src/selfhost/config-lint";

// #1682: self-host operators need discoverable, copy-paste templates under config/examples/ that
// parse cleanly, stay in sync with the canonical root files, and keep the minimal starter safe.

const CANONICAL_BODY_MARKER = "# WHERE IT LIVES (first match wins):";
const MINIMAL_BODY_MARKER = "# Safe by default:";

function readConfigExample(name: string): string {
  return readFileSync(`config/examples/${name}`, "utf8");
}

function readRoot(name: string): string {
  return readFileSync(name, "utf8");
}

function bodyFromMarker(content: string, marker: string): string {
  const index = content.indexOf(marker);
  expect(index, `marker ${JSON.stringify(marker)} missing`).toBeGreaterThanOrEqual(0);
  return content.slice(index);
}

describe("config/examples review templates (#1682)", () => {
  it("gittensory.full.yml body matches .gittensory.yml.example from WHERE IT LIVES onward", () => {
    const full = readConfigExample("gittensory.full.yml");
    const example = readRoot(".gittensory.yml.example");
    expect(bodyFromMarker(full, CANONICAL_BODY_MARKER)).toBe(bodyFromMarker(example, CANONICAL_BODY_MARKER));
  });

  it("gittensory.minimal.yml body matches .gittensory.minimal.yml from Safe by default onward", () => {
    const minimal = readConfigExample("gittensory.minimal.yml");
    const root = readRoot(".gittensory.minimal.yml");
    expect(bodyFromMarker(minimal, MINIMAL_BODY_MARKER)).toBe(bodyFromMarker(root, MINIMAL_BODY_MARKER));
  });

  it("parses gittensory.full.yml with zero warnings", () => {
    const manifest = parseFocusManifestContent(readConfigExample("gittensory.full.yml"), "repo_file");
    expect(manifest.warnings).toEqual([]);
    expect(manifest.present).toBe(true);
    expect(manifest.gate.sizeMode).toBe("off");
    expect(manifest.features.rag).toBeNull();
  });

  // #5294 (drift-audit roadmap #5270): parseFocusManifestContent above is the LENIENT parser (never
  // warns on an unrecognized/retired top-level field by design) -- it structurally cannot catch a
  // retired field like the old `blockedPaths` example creeping back into these shipped templates.
  // lintManifestText is the ONLY function with the retired-field check (config-lint.ts's
  // RETIRED_FIELD_MIGRATION_WARNINGS); assert it separately so a retired field reintroduced here fails
  // CI instead of only being caught by eye.
  it("lints gittensory.full.yml with zero warnings, including no retired top-level fields", () => {
    const result = lintManifestText(readConfigExample("gittensory.full.yml"));
    expect(result.warnings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("documents every shipped review.auto_review eligibility knob in gittensory.full.yml (#2055)", () => {
    const full = readConfigExample("gittensory.full.yml");
    for (const field of ["skip_labels", "skip_docs_only", "max_added_lines", "max_files"]) {
      expect(full, `missing auto_review field ${field}`).toMatch(new RegExp(`# ${field}:`));
    }
    expect(full).not.toMatch(/not parsed yet/);
  });

  it("documents shipped unified-comment display toggles in gittensory.full.yml (#2069)", () => {
    const full = readConfigExample("gittensory.full.yml");
    for (const field of ["changed_files_summary", "effort_score", "min_finding_severity"]) {
      expect(full, `missing review field ${field}`).toMatch(new RegExp(`# ${field}:`));
    }
    expect(full).not.toMatch(/Planned display toggle/);
  });

  it("documents shipped inline-comment review toggles in gittensory.full.yml (#2156)", () => {
    const full = readConfigExample("gittensory.full.yml");
    for (const field of ["inline_comments", "suggestions", "finding_categories", "inline_comments_per_category"]) {
      expect(full, `missing review field ${field}`).toMatch(new RegExp(`# ${field}:`));
    }
  });

  it("resolves review.changed_files_summary via manifest parse + boolean helper (#2146)", () => {
    const full = readConfigExample("gittensory.full.yml");
    expect(full).toMatch(/# changed_files_summary:/);
    expect(parseFocusManifest({}).review.changedFilesSummary).toBeNull();
    expect(resolveReviewPromptOverrides(parseFocusManifest({})).changedFilesSummary).toBe(false);
    const on = parseFocusManifest({ review: { changed_files_summary: true } });
    expect(on.review.changedFilesSummary).toBe(true);
    expect(resolveReviewPromptOverrides(on).changedFilesSummary).toBe(true);
    expect(reviewConfigToJson(on.review)).toEqual({ changed_files_summary: true });
    const off = parseFocusManifest({ review: { changed_files_summary: false } });
    expect(off.review.changedFilesSummary).toBe(false);
    expect(resolveReviewPromptOverrides(off).changedFilesSummary).toBe(false);
  });

  it("resolves review.effort_score via manifest parse + boolean helper (#2152)", () => {
    const full = readConfigExample("gittensory.full.yml");
    expect(full).toMatch(/# effort_score:/);
    expect(parseFocusManifest({}).review.effortScore).toBeNull();
    expect(resolveReviewPromptOverrides(parseFocusManifest({})).effortScore).toBe(false);
    const on = parseFocusManifest({ review: { effort_score: true } });
    expect(on.review.effortScore).toBe(true);
    expect(resolveReviewPromptOverrides(on).effortScore).toBe(true);
    expect(reviewConfigToJson(on.review)).toEqual({ effort_score: true });
    const off = parseFocusManifest({ review: { effort_score: false } });
    expect(off.review.effortScore).toBe(false);
    expect(resolveReviewPromptOverrides(off).effortScore).toBe(false);
  });

  it("resolves review.inline_comments_per_category via manifest parse + helper (#2159)", () => {
    const full = readConfigExample("gittensory.full.yml");
    expect(full).toMatch(/# inline_comments_per_category:/);
    expect(parseFocusManifest({}).review.inlineCommentsPerCategory).toBeNull();
    expect(resolveReviewPromptOverrides(parseFocusManifest({})).inlineCommentsPerCategory).toBeNull();
    const on = parseFocusManifest({ review: { inline_comments_per_category: 2 } });
    expect(on.review.inlineCommentsPerCategory).toBe(2);
    expect(resolveReviewPromptOverrides(on).inlineCommentsPerCategory).toBe(2);
    expect(reviewConfigToJson(on.review)).toEqual({ inline_comments_per_category: 2 });
  });

  it("resolves review.impact_map via manifest parse + boolean helper (#2184)", () => {
    const full = readConfigExample("gittensory.full.yml");
    expect(full).toMatch(/# impact_map:/);
    expect(parseFocusManifest({}).review.impactMap).toBeNull();
    expect(resolveReviewPromptOverrides(parseFocusManifest({})).impactMap).toBe(false);
    const on = parseFocusManifest({ review: { impact_map: true } });
    expect(on.review.impactMap).toBe(true);
    expect(resolveReviewPromptOverrides(on).impactMap).toBe(true);
    expect(reviewConfigToJson(on.review)).toEqual({ impact_map: true });
    const off = parseFocusManifest({ review: { impact_map: false } });
    expect(off.review.impactMap).toBe(false);
    expect(resolveReviewPromptOverrides(off).impactMap).toBe(false);
  });

  it("resolves review.culture_profile via manifest parse + boolean helper (#1683)", () => {
    const full = readConfigExample("gittensory.full.yml");
    expect(full).toMatch(/# culture_profile:/);
    expect(parseFocusManifest({}).review.cultureProfile).toBeNull();
    expect(resolveReviewPromptOverrides(parseFocusManifest({})).cultureProfile).toBe(false);
    const on = parseFocusManifest({ review: { culture_profile: true } });
    expect(on.review.cultureProfile).toBe(true);
    expect(resolveReviewPromptOverrides(on).cultureProfile).toBe(true);
    expect(reviewConfigToJson(on.review)).toEqual({ culture_profile: true });
    const off = parseFocusManifest({ review: { culture_profile: false } });
    expect(off.review.cultureProfile).toBe(false);
    expect(resolveReviewPromptOverrides(off).cultureProfile).toBe(false);
  });

  it("resolves review.max_findings via manifest parse + helper (#2211)", () => {
    const full = readConfigExample("gittensory.full.yml");
    expect(full).toMatch(/# max_findings:/);
    const empty = { blockers: null, nits: null };
    expect(parseFocusManifest({}).review.maxFindings).toEqual(empty);
    expect(resolveReviewPromptOverrides(parseFocusManifest({})).maxFindings).toEqual(empty);
    const on = parseFocusManifest({ review: { max_findings: { blockers: 5, nits: 8 } } });
    expect(on.review.maxFindings).toEqual({ blockers: 5, nits: 8 });
    expect(resolveReviewPromptOverrides(on).maxFindings).toEqual({ blockers: 5, nits: 8 });
    expect(reviewConfigToJson(on.review)).toEqual({ max_findings: { blockers: 5, nits: 8 } });
  });

  it("resolves review.inline_comments via manifest parse + boolean helper (#2206)", () => {
    const full = readConfigExample("gittensory.full.yml");
    expect(full).toMatch(/# inline_comments:/);
    expect(parseFocusManifest({}).review.inlineComments).toBeNull();
    expect(resolveReviewPromptOverrides(parseFocusManifest({})).inlineComments).toBe(false);
    const on = parseFocusManifest({ review: { inline_comments: true } });
    expect(on.review.inlineComments).toBe(true);
    expect(resolveReviewPromptOverrides(on).inlineComments).toBe(true);
    expect(reviewConfigToJson(on.review)).toEqual({ inline_comments: true });
    const off = parseFocusManifest({ review: { inline_comments: false } });
    expect(off.review.inlineComments).toBe(false);
    expect(resolveReviewPromptOverrides(off).inlineComments).toBe(false);
  });

  it("parses gittensory.minimal.yml with zero warnings and enables no agent actions", () => {
    const manifest = parseFocusManifestContent(readConfigExample("gittensory.minimal.yml"), "repo_file");
    expect(manifest.warnings).toEqual([]);
    expect(manifest.present).toBe(true);
    // #5355: the minimal starter uses checkMode: disabled (not the ambiguous legacy enabled: false) so it
    // stays warnings-clean and demonstrates the current best practice.
    expect(manifest.gate.enabled).toBeNull();
    expect(manifest.gate.checkMode).toBe("disabled");
    expect(isAgentConfigured(manifest.settings.autonomy)).toBe(false);
    const round = parseFocusManifest({ gate: gateConfigToJson(manifest.gate), settings: { autonomy: manifest.settings.autonomy } });
    expect(round.warnings).toEqual([]);
    expect(round.gate.checkMode).toBe("disabled");
    expect(isAgentConfigured(round.settings.autonomy)).toBe(false);
  });

  it("resolves the gate-policy field group (enabled + advisory/block modes) via parse + gateConfigToJson round-trip (#2205)", () => {
    const full = readConfigExample("gittensory.full.yml");
    expect(full).toMatch(/^gate:/m);
    expect(full).toMatch(/linkedIssue:/);
    // No gate block ⇒ no per-repo gate override (null), so an operator's absent gate policy stays inherited.
    expect(gateConfigToJson(parseFocusManifest({}).gate)).toBeNull();
    // Explicit gate policy: the on/off switch + the advisory-vs-block mode controls parse and round-trip
    // byte-for-byte — the parity the config-generator's gate-policy field group depends on.
    const on = parseFocusManifest({ gate: { enabled: true, linkedIssue: "block", duplicates: "advisory" } });
    expect(on.gate.enabled).toBe(true);
    expect(on.gate.linkedIssue).toBe("block");
    expect(on.gate.duplicates).toBe("advisory");
    expect(gateConfigToJson(on.gate)).toEqual({ enabled: true, linkedIssue: "block", duplicates: "advisory" });
  });

  it("resolves the path-instructions + exclude-paths field group via parse + round-trip + glob application (#2209)", () => {
    const full = readConfigExample("gittensory.full.yml");
    expect(full).toMatch(/exclude_paths:/);
    expect(full).toMatch(/path_instructions:/);
    // Defaults: both are empty lists — no per-path review instructions, nothing excluded.
    const def = parseFocusManifest({});
    expect(def.review.pathInstructions).toEqual([]);
    expect(def.review.excludePaths).toEqual([]);
    // Explicit values parse and round-trip byte-for-byte through reviewConfigToJson — the parity the
    // config-generator's list editors for these two fields emit into.
    const on = parseFocusManifest({
      review: { path_instructions: [{ path: "src/**", instructions: "be strict" }], exclude_paths: ["dist/**"] },
    });
    expect(on.review.pathInstructions).toEqual([{ path: "src/**", instructions: "be strict" }]);
    expect(on.review.excludePaths).toEqual(["dist/**"]);
    expect(reviewConfigToJson(on.review)).toEqual({
      path_instructions: [{ path: "src/**", instructions: "be strict" }],
      exclude_paths: ["dist/**"],
    });
    // A path instruction applies only to changed files matching its glob (empty string otherwise).
    expect(resolveReviewPathInstructions(on.review.pathInstructions, ["src/index.ts"])).toContain("be strict");
    expect(resolveReviewPathInstructions(on.review.pathInstructions, ["docs/readme.md"])).toBe("");
  });

  it("resolves the autonomy-level field group (per-action dial) via parse + resolveAutonomy (#2213)", () => {
    const full = readConfigExample("gittensory.full.yml");
    expect(full).toMatch(/autonomy:/);
    // Default: no autonomy config ⇒ not configured, and every action class resolves to the safe "observe" default.
    const def = parseFocusManifest({});
    expect(isAgentConfigured(def.settings.autonomy)).toBe(false);
    expect(resolveAutonomy(def.settings.autonomy, "review")).toBe("observe");
    // Explicit per-action levels parse; each set action resolves to its level, unset actions stay "observe" —
    // the parity the config-generator's autonomy-level dial emits into.
    const on = parseFocusManifest({ settings: { autonomy: { review: "auto_with_approval", merge: "auto" } } });
    expect(on.settings.autonomy).toEqual({ review: "auto_with_approval", merge: "auto" });
    expect(isAgentConfigured(on.settings.autonomy)).toBe(true);
    expect(resolveAutonomy(on.settings.autonomy, "review")).toBe("auto_with_approval");
    expect(resolveAutonomy(on.settings.autonomy, "merge")).toBe("auto");
    expect(resolveAutonomy(on.settings.autonomy, "close")).toBe("observe"); // unset action ⇒ default
  });
  it("imports an existing .gittensory.yml's field values across sections into the parsed manifest (#2212)", () => {
    // The config-generator's "import existing .gittensory.yml into the form" reads an operator's file back
    // through the same parser; lock in that a multi-section config's values round-trip faithfully (not just
    // that it parses without warnings).
    const yml = [
      "gate:",
      "  enabled: true",
      "  checkMode: required",
      "  linkedIssue: block",
      "review:",
      "  inline_comments: true",
      "  exclude_paths:",
      "    - dist/**",
      "settings:",
      "  autonomy:",
      "    review: auto_with_approval",
    ].join("\n");
    const imported = parseFocusManifestContent(yml, "repo_file");
    expect(imported.warnings).toEqual([]);
    expect(imported.present).toBe(true);
    expect(imported.gate.enabled).toBe(true);
    expect(imported.gate.checkMode).toBe("required");
    expect(imported.gate.linkedIssue).toBe("block");
    expect(imported.review.inlineComments).toBe(true);
    expect(imported.review.excludePaths).toEqual(["dist/**"]);
    expect(resolveAutonomy(imported.settings.autonomy, "review")).toBe("auto_with_approval");
  });
});
