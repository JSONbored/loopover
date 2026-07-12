import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@jsonbored/gittensory-engine", async () => {
  return import("../../packages/gittensory-engine/src/index");
});

import { DEFAULT_AMS_POLICY_SPEC } from "../../packages/gittensory-engine/src/index";
import { resolveAmsPolicy, resolveAmsPolicyConfigPath } from "../../packages/gittensory-miner/lib/ams-policy.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-ams-policy-"));
  roots.push(root);
  return root;
}

describe("resolveAmsPolicyConfigPath (#5132)", () => {
  it("resolves from explicit env, config dir, and XDG default, in precedence order", () => {
    expect(resolveAmsPolicyConfigPath({ GITTENSORY_MINER_AMS_POLICY_PATH: "/custom/policy.yml" })).toBe("/custom/policy.yml");
    expect(resolveAmsPolicyConfigPath({ GITTENSORY_MINER_CONFIG_DIR: "/cfg" })).toBe(join("/cfg", ".gittensory-ams.yml"));
  });
});

describe("resolveAmsPolicy (#5132)", () => {
  it("returns the engine's safe defaults when no local operator policy exists", async () => {
    const root = tempRoot();
    const result = await resolveAmsPolicy("acme/widgets", { env: { GITTENSORY_MINER_CONFIG_DIR: root } });
    expect(result).toEqual({ spec: DEFAULT_AMS_POLICY_SPEC, source: "default", warnings: [] });
  });

  it("REGRESSION: ignores target-repo .gittensory-ams.yml so repos cannot loosen operator risk policy", async () => {
    const root = tempRoot();
    const fetchImpl = vi.fn(async () => {
      throw new Error("target repo policy must not be fetched");
    });
    const result = await resolveAmsPolicy("acme/widgets", { fetchImpl, env: { GITTENSORY_MINER_CONFIG_DIR: root } });
    expect(result).toEqual({ spec: DEFAULT_AMS_POLICY_SPEC, source: "default", warnings: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("the operator's own local file supplies the effective policy", async () => {
    const root = tempRoot();
    writeFileSync(join(root, ".gittensory-ams.yml"), "submissionMode: observe\nslopThreshold: clean\n");
    const fetchImpl = vi.fn(async () => {
      throw new Error("target repo policy must not be fetched");
    });
    const result = await resolveAmsPolicy("acme/widgets", { fetchImpl, env: { GITTENSORY_MINER_CONFIG_DIR: root } });
    expect(result.source).toBe("local");
    expect(result.spec.submissionMode).toBe("observe");
    expect(result.spec.slopThreshold).toBe("clean");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never calls fetch at all once a local file is found", async () => {
    const root = tempRoot();
    writeFileSync(join(root, ".gittensory-ams.yml"), "submissionMode: enforce\n");
    let fetchCalls = 0;
    const fetchImpl = async () => {
      fetchCalls += 1;
      throw new Error("target repo policy must not be fetched");
    };
    const result = await resolveAmsPolicy("acme/widgets", { fetchImpl, env: { GITTENSORY_MINER_CONFIG_DIR: root } });
    expect(result.source).toBe("local");
    expect(fetchCalls).toBe(0);
  });

  it("falls through to defaults on a malformed local file (invalid YAML), still never touching the repo file", async () => {
    const root = tempRoot();
    writeFileSync(join(root, ".gittensory-ams.yml"), "submissionMode: [unterminated");
    let fetchCalls = 0;
    const fetchImpl = async () => {
      fetchCalls += 1;
      throw new Error("target repo policy must not be fetched");
    };
    const result = await resolveAmsPolicy("acme/widgets", { fetchImpl, env: { GITTENSORY_MINER_CONFIG_DIR: root } });
    expect(result.source).toBe("local");
    expect(result.spec).toEqual(DEFAULT_AMS_POLICY_SPEC);
    expect(result.warnings.join(" ")).toMatch(/not valid YAML/i);
    expect(fetchCalls).toBe(0);
  });

  it("returns defaults for any repoFullName, without ever calling fetch", async () => {
    const root = tempRoot();
    const fetchImpl = vi.fn();
    const result = await resolveAmsPolicy("not-a-repo", { fetchImpl, env: { GITTENSORY_MINER_CONFIG_DIR: root } });
    expect(result).toEqual({ spec: DEFAULT_AMS_POLICY_SPEC, source: "default", warnings: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
