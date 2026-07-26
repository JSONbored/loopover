import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@loopover/engine", async () => {
  return import("../../packages/loopover-engine/src/index");
});

import { DEFAULT_AMS_POLICY_SPEC } from "../../packages/loopover-engine/src/index";
import { resolveAmsPolicy, resolveAmsPolicyConfigPath, resolveAmsPolicyConfigDir, amsPolicyWarningJsonFields, renderAmsPolicyWarnings } from "../../packages/loopover-miner/lib/ams-policy.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-ams-policy-"));
  roots.push(root);
  return root;
}

describe("resolveAmsPolicyConfigPath (#5132)", () => {
  it("resolves from explicit env, config dir, and XDG default, in precedence order", () => {
    expect(resolveAmsPolicyConfigPath({ LOOPOVER_MINER_AMS_POLICY_PATH: "/custom/policy.yml" })).toBe("/custom/policy.yml");
    expect(resolveAmsPolicyConfigPath({ LOOPOVER_MINER_CONFIG_DIR: "/cfg" })).toBe(join("/cfg", ".loopover-ams.yml"));
  });
});

describe("resolveAmsPolicyConfigDir (#8863)", () => {
  it("resolves the operator config directory from LOOPOVER_MINER_CONFIG_DIR or XDG_CONFIG_HOME", () => {
    expect(resolveAmsPolicyConfigDir({ LOOPOVER_MINER_CONFIG_DIR: "/cfg" })).toBe("/cfg");
    expect(resolveAmsPolicyConfigDir({ XDG_CONFIG_HOME: "/xdg" })).toBe(join("/xdg", "loopover-miner"));
  });

  it("falls back to ~/.config/loopover-miner when no config overrides are set", () => {
    expect(resolveAmsPolicyConfigDir({})).toBe(join(homedir(), ".config", "loopover-miner"));
    expect(resolveAmsPolicyConfigDir({ XDG_CONFIG_HOME: "   " })).toBe(
      join(homedir(), ".config", "loopover-miner"),
    );
  });
});

describe("amsPolicy warning surfacing helpers (#8853)", () => {
  it("omits JSON fields and human lines when warnings are empty", () => {
    expect(amsPolicyWarningJsonFields({ source: "default", warnings: [] })).toEqual({});
    expect(renderAmsPolicyWarnings({ source: "default", warnings: [] })).toEqual([]);
  });

  it("surfaces source and warnings with discover-cli phrasing when warnings are non-empty", () => {
    const resolved = {
      source: "local" as const,
      warnings: ['AmsPolicySpec field "capLimits" must be a mapping; falling back to defaults.'],
    };
    expect(amsPolicyWarningJsonFields(resolved)).toEqual({
      amsPolicySource: "local",
      amsPolicyWarnings: resolved.warnings,
    });
    expect(renderAmsPolicyWarnings(resolved)).toEqual([
      "ams-policy warnings: 1",
      '  AmsPolicySpec field "capLimits" must be a mapping; falling back to defaults.',
      "ams-policy source: local",
    ]);
  });
});

describe("resolveAmsPolicy (#5132)", () => {
  it("returns the engine's safe defaults when no local operator policy exists", async () => {
    const root = tempRoot();
    const result = await resolveAmsPolicy("acme/widgets", { env: { LOOPOVER_MINER_CONFIG_DIR: root } });
    expect(result).toEqual({ spec: DEFAULT_AMS_POLICY_SPEC, source: "default", warnings: [] });
  });

  it("REGRESSION: ignores target-repo .loopover-ams.yml so repos cannot loosen operator risk policy", async () => {
    const root = tempRoot();
    const fetchImpl = vi.fn(async () => {
      throw new Error("target repo policy must not be fetched");
    });
    const result = await resolveAmsPolicy("acme/widgets", { fetchImpl, env: { LOOPOVER_MINER_CONFIG_DIR: root } });
    expect(result).toEqual({ spec: DEFAULT_AMS_POLICY_SPEC, source: "default", warnings: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("the operator's own local file supplies the effective policy", async () => {
    const root = tempRoot();
    writeFileSync(join(root, ".loopover-ams.yml"), "submissionMode: observe\nslopThreshold: clean\n");
    const fetchImpl = vi.fn(async () => {
      throw new Error("target repo policy must not be fetched");
    });
    const result = await resolveAmsPolicy("acme/widgets", { fetchImpl, env: { LOOPOVER_MINER_CONFIG_DIR: root } });
    expect(result.source).toBe("local");
    expect(result.spec.submissionMode).toBe("observe");
    expect(result.spec.slopThreshold).toBe("clean");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never calls fetch at all once a local file is found", async () => {
    const root = tempRoot();
    writeFileSync(join(root, ".loopover-ams.yml"), "submissionMode: enforce\n");
    let fetchCalls = 0;
    const fetchImpl = async () => {
      fetchCalls += 1;
      throw new Error("target repo policy must not be fetched");
    };
    const result = await resolveAmsPolicy("acme/widgets", { fetchImpl, env: { LOOPOVER_MINER_CONFIG_DIR: root } });
    expect(result.source).toBe("local");
    expect(fetchCalls).toBe(0);
  });

  it("falls through to defaults on a malformed local file (invalid YAML), still never touching the repo file", async () => {
    const root = tempRoot();
    writeFileSync(join(root, ".loopover-ams.yml"), "submissionMode: [unterminated");
    let fetchCalls = 0;
    const fetchImpl = async () => {
      fetchCalls += 1;
      throw new Error("target repo policy must not be fetched");
    };
    const result = await resolveAmsPolicy("acme/widgets", { fetchImpl, env: { LOOPOVER_MINER_CONFIG_DIR: root } });
    expect(result.source).toBe("local");
    expect(result.spec).toEqual(DEFAULT_AMS_POLICY_SPEC);
    expect(result.warnings.join(" ")).toMatch(/not valid YAML/i);
    expect(fetchCalls).toBe(0);
  });

  it("returns defaults for any repoFullName, without ever calling fetch", async () => {
    const root = tempRoot();
    const fetchImpl = vi.fn();
    const result = await resolveAmsPolicy("not-a-repo", { fetchImpl, env: { LOOPOVER_MINER_CONFIG_DIR: root } });
    expect(result).toEqual({ spec: DEFAULT_AMS_POLICY_SPEC, source: "default", warnings: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("treats a readFileSync that throws (e.g. a race where the file vanishes after existsSync) the same as absent", async () => {
    const root = tempRoot();
    const readFileSync = () => {
      throw new Error("EACCES: permission denied");
    };
    const result = await resolveAmsPolicy("acme/widgets", {
      env: { LOOPOVER_MINER_CONFIG_DIR: root },
      existsSync: () => true,
      readFileSync,
    });
    expect(result).toEqual({ spec: DEFAULT_AMS_POLICY_SPEC, source: "default", warnings: [] });
  });

  it("defaults env to process.env when no env override is supplied", async () => {
    // No LOOPOVER_MINER_AMS_POLICY_PATH/LOOPOVER_MINER_CONFIG_DIR/XDG_CONFIG_HOME override set for this test
    // process, so this exercises the real `options.env ?? process.env` default path and resolves to the real
    // (almost certainly absent, on a test machine) `~/.config/loopover-miner/.loopover-ams.yml`.
    const result = await resolveAmsPolicy("acme/widgets", { existsSync: () => false });
    expect(result).toEqual({ spec: DEFAULT_AMS_POLICY_SPEC, source: "default", warnings: [] });
  });

  it.each([
    [".github/loopover-ams.yml", "submissionMode: observe\n"],
    [".loopover-ams.json", '{"submissionMode":"observe"}'],
    [".github/loopover-ams.json", '{"submissionMode":"observe"}'],
  ])("REGRESSION #8863: discovers operator policy at %s in the documented fallback order", async (relativePath, content) => {
    const root = tempRoot();
    const fullPath = join(root, relativePath);
    mkdirSync(join(root, ".github"), { recursive: true });
    writeFileSync(fullPath, content);
    const result = await resolveAmsPolicy("acme/widgets", { env: { LOOPOVER_MINER_CONFIG_DIR: root } });
    expect(result.source).toBe("local");
    expect(result.spec.submissionMode).toBe("observe");
  });

  it("REGRESSION #8863: first match wins when multiple AMS_POLICY_SPEC_FILENAMES candidates exist", async () => {
    const root = tempRoot();
    mkdirSync(join(root, ".github"), { recursive: true });
    writeFileSync(join(root, ".loopover-ams.yml"), "submissionMode: enforce\n");
    writeFileSync(join(root, ".github/loopover-ams.yml"), "submissionMode: observe\n");
    const result = await resolveAmsPolicy("acme/widgets", { env: { LOOPOVER_MINER_CONFIG_DIR: root } });
    expect(result.source).toBe("local");
    expect(result.spec.submissionMode).toBe("enforce");
  });

  it("REGRESSION #8863: explicit LOOPOVER_MINER_AMS_POLICY_PATH bypasses discovery order", async () => {
    const root = tempRoot();
    const explicitPath = join(root, "custom-policy.json");
    writeFileSync(explicitPath, '{"submissionMode":"observe"}');
    writeFileSync(join(root, ".loopover-ams.yml"), "submissionMode: enforce\n");
    const result = await resolveAmsPolicy("acme/widgets", {
      env: { LOOPOVER_MINER_CONFIG_DIR: root, LOOPOVER_MINER_AMS_POLICY_PATH: explicitPath },
    });
    expect(result.source).toBe("local");
    expect(result.spec.submissionMode).toBe("observe");
  });

  it("REGRESSION #8863: treats a missing explicit LOOPOVER_MINER_AMS_POLICY_PATH as absent", async () => {
    const result = await resolveAmsPolicy("acme/widgets", {
      env: { LOOPOVER_MINER_AMS_POLICY_PATH: "/missing/policy.yml" },
      existsSync: () => false,
    });
    expect(result).toEqual({ spec: DEFAULT_AMS_POLICY_SPEC, source: "default", warnings: [] });
  });

  it("REGRESSION #8863: treats an unreadable explicit LOOPOVER_MINER_AMS_POLICY_PATH as absent", async () => {
    const result = await resolveAmsPolicy("acme/widgets", {
      env: { LOOPOVER_MINER_AMS_POLICY_PATH: "/unreadable/policy.yml" },
      existsSync: () => true,
      readFileSync: () => {
        throw new Error("EACCES: permission denied");
      },
    });
    expect(result).toEqual({ spec: DEFAULT_AMS_POLICY_SPEC, source: "default", warnings: [] });
  });
});
