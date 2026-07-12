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

function textResponse(text: string | null, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async (): Promise<unknown> => {
      throw new Error("textResponse: json() is unused by ams-policy's fetch path");
    },
    text: async () => text ?? "",
  };
}

function routedFetch(routes: Record<string, () => ReturnType<typeof textResponse>>) {
  return async (url: string) => {
    for (const [substring, respond] of Object.entries(routes)) {
      if (url.includes(substring)) return respond();
    }
    return textResponse(null, 404);
  };
}

describe("resolveAmsPolicyConfigPath (#5132)", () => {
  it("resolves from explicit env, config dir, and XDG default, in precedence order", () => {
    expect(resolveAmsPolicyConfigPath({ GITTENSORY_MINER_AMS_POLICY_PATH: "/custom/policy.yml" })).toBe("/custom/policy.yml");
    expect(resolveAmsPolicyConfigPath({ GITTENSORY_MINER_CONFIG_DIR: "/cfg" })).toBe(join("/cfg", ".gittensory-ams.yml"));
  });
});

describe("resolveAmsPolicy (#5132)", () => {
  it("returns the engine's safe defaults when neither a local file nor a repo file exists", async () => {
    const root = tempRoot();
    const fetchImpl = routedFetch({});
    const result = await resolveAmsPolicy("acme/widgets", { fetchImpl, env: { GITTENSORY_MINER_CONFIG_DIR: root } });
    expect(result).toEqual({ spec: DEFAULT_AMS_POLICY_SPEC, source: "default", warnings: [] });
  });

  it("clamps repo fallback policy so repo-controlled content cannot loosen safe defaults", async () => {
    const root = tempRoot();
    const fetchImpl = routedFetch({
      ".gittensory-ams.yml": () =>
        textResponse(
          [
            "submissionMode: enforce",
            "slopThreshold: high",
            "capLimits:",
            "  budget: 100",
            "  turns: 200",
            "  elapsedMs: 3600000",
            "convergenceThresholds:",
            "  maxConsecutiveFailures: 20",
            "  maxReenqueues: 20",
            "maxIterations: 30",
            "maxTurnsPerIteration: 60",
          ].join("\n"),
        ),
    });
    const result = await resolveAmsPolicy("acme/widgets", { fetchImpl, env: { GITTENSORY_MINER_CONFIG_DIR: root } });
    expect(result.source).toBe("repo");
    expect(result.spec).toEqual(DEFAULT_AMS_POLICY_SPEC);
    expect(result.warnings.join(" ")).toMatch(/cannot loosen/i);
  });

  it("allows repo fallback policy to make safe defaults more restrictive", async () => {
    const root = tempRoot();
    const fetchImpl = routedFetch({
      ".gittensory-ams.yml": () =>
        textResponse(
          [
            "submissionMode: observe",
            "slopThreshold: clean",
            "capLimits:",
            "  budget: 2",
            "  turns: 3",
            "  elapsedMs: 1000",
            "convergenceThresholds:",
            "  maxConsecutiveFailures: 1",
            "  maxReenqueues: 0",
            "maxIterations: 1",
            "maxTurnsPerIteration: 2",
          ].join("\n"),
        ),
    });
    const result = await resolveAmsPolicy("acme/widgets", { fetchImpl, env: { GITTENSORY_MINER_CONFIG_DIR: root } });
    expect(result.source).toBe("repo");
    expect(result.spec).toEqual({
      submissionMode: "observe",
      slopThreshold: "clean",
      capLimits: { budget: 2, turns: 3, elapsedMs: 1000 },
      convergenceThresholds: { maxConsecutiveFailures: 1, maxReenqueues: 0 },
      maxIterations: 1,
      maxTurnsPerIteration: 2,
    });
    expect(result.warnings).toEqual([]);
  });

  it("REGRESSION: the operator's own local file fully REPLACES the repo's file, never merges", async () => {
    const root = tempRoot();
    writeFileSync(join(root, ".gittensory-ams.yml"), "submissionMode: observe\n");
    // The repo's own file sets slopThreshold too -- if this leaked through via a merge, slopThreshold would
    // read "clean" instead of the local file's own (unset -> default) "low".
    const fetchImpl = vi.fn(routedFetch({
      ".gittensory-ams.yml": () => textResponse("submissionMode: enforce\nslopThreshold: clean\n"),
    }));
    const result = await resolveAmsPolicy("acme/widgets", { fetchImpl, env: { GITTENSORY_MINER_CONFIG_DIR: root } });
    expect(result.source).toBe("local");
    expect(result.spec.submissionMode).toBe("observe");
    expect(result.spec.slopThreshold).toBe(DEFAULT_AMS_POLICY_SPEC.slopThreshold);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never calls fetch at all once a local file is found", async () => {
    const root = tempRoot();
    writeFileSync(join(root, ".gittensory-ams.yml"), "submissionMode: enforce\n");
    let fetchCalls = 0;
    const fetchImpl = async () => {
      fetchCalls += 1;
      return textResponse(null, 404);
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
      return textResponse(null, 404);
    };
    const result = await resolveAmsPolicy("acme/widgets", { fetchImpl, env: { GITTENSORY_MINER_CONFIG_DIR: root } });
    expect(result.source).toBe("local");
    expect(result.spec).toEqual(DEFAULT_AMS_POLICY_SPEC);
    expect(result.warnings.join(" ")).toMatch(/not valid YAML/i);
    expect(fetchCalls).toBe(0);
  });

  it("returns defaults for a malformed repoFullName, without ever calling fetch", async () => {
    const root = tempRoot();
    const fetchImpl = vi.fn();
    const result = await resolveAmsPolicy("not-a-repo", { fetchImpl, env: { GITTENSORY_MINER_CONFIG_DIR: root } });
    expect(result).toEqual({ spec: DEFAULT_AMS_POLICY_SPEC, source: "default", warnings: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns defaults on a repo fetch network error", async () => {
    const root = tempRoot();
    const fetchImpl = async () => {
      throw new Error("network unreachable");
    };
    const result = await resolveAmsPolicy("acme/widgets", { fetchImpl, env: { GITTENSORY_MINER_CONFIG_DIR: root } });
    expect(result).toEqual({ spec: DEFAULT_AMS_POLICY_SPEC, source: "default", warnings: [] });
  });

  it("tries the .github/ and .json candidate paths when the root .yml 404s", async () => {
    const root = tempRoot();
    const fetchImpl = routedFetch({
      ".github/gittensory-ams.yml": () => textResponse("submissionMode: enforce\n"),
    });
    const result = await resolveAmsPolicy("acme/widgets", { fetchImpl, env: { GITTENSORY_MINER_CONFIG_DIR: root } });
    expect(result.source).toBe("repo");
    expect(result.spec.submissionMode).toBe("observe");
    expect(result.warnings.join(" ")).toMatch(/cannot loosen/i);
  });
});
