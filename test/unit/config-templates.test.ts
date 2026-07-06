import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isAgentConfigured } from "../../src/settings/autonomy";
import {
  gateConfigToJson,
  parseFocusManifest,
  parseFocusManifestContent,
  resolveReviewPromptOverrides,
  reviewConfigToJson,
} from "../../src/signals/focus-manifest";

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

  it("locks in review.test_generation via manifest parse + JSON round-trip and documents it in gittensory.full.yml (#2189)", () => {
    // test_generation is a kill-switch that gates the boundary-safe test-generation advisory (#1972); it is NOT a
    // review prompt override, so it is exercised through the manifest parse + reviewConfigToJson round-trip rather
    // than resolveReviewPromptOverrides (which does not surface it).
    const full = readConfigExample("gittensory.full.yml");
    expect(full).toMatch(/# test_generation:/);
    expect(parseFocusManifest({}).review.testGeneration).toBeNull();
    const on = parseFocusManifest({ review: { test_generation: true } });
    expect(on.review.testGeneration).toBe(true);
    expect(reviewConfigToJson(on.review)).toEqual({ test_generation: true });
    const off = parseFocusManifest({ review: { test_generation: false } });
    expect(off.review.testGeneration).toBe(false);
    expect(reviewConfigToJson(off.review)).toEqual({ test_generation: false });
  });

  it("parses gittensory.minimal.yml with zero warnings and enables no agent actions", () => {
    const manifest = parseFocusManifestContent(readConfigExample("gittensory.minimal.yml"), "repo_file");
    expect(manifest.warnings).toEqual([]);
    expect(manifest.present).toBe(true);
    expect(manifest.gate.enabled).toBe(false);
    expect(isAgentConfigured(manifest.settings.autonomy)).toBe(false);
    const round = parseFocusManifest({ gate: gateConfigToJson(manifest.gate), settings: { autonomy: manifest.settings.autonomy } });
    expect(round.warnings).toEqual([]);
    expect(round.gate.enabled).toBe(false);
    expect(isAgentConfigured(round.settings.autonomy)).toBe(false);
  });
});
