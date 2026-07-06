import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isAgentConfigured } from "../../src/settings/autonomy";
import {
  gateConfigToJson,
  parseFocusManifest,
  parseFocusManifestContent,
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
