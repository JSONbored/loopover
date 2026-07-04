import { describe, expect, it } from "vitest";
import { matchesAny } from "../../src/signals/change-guardrail";
import { CONFIG_AS_CODE_GUARDRAIL_GLOBS, DEFAULT_CRUCIAL_GUARDRAIL_GLOBS, ENGINE_DECISION_GUARDRAIL_GLOBS, SELFHOST_RUNTIME_GUARDRAIL_GLOBS, loadHardGuardrailGlobs } from "../../src/review/guardrail-config";

describe("loadHardGuardrailGlobs", () => {
  it("returns the built-in self-host guardrails without requiring external policy storage", async () => {
    expect(await loadHardGuardrailGlobs({} as Env, "JSONbored/gittensory")).toEqual([...DEFAULT_CRUCIAL_GUARDRAIL_GLOBS, ...CONFIG_AS_CODE_GUARDRAIL_GLOBS, ...ENGINE_DECISION_GUARDRAIL_GLOBS, ...SELFHOST_RUNTIME_GUARDRAIL_GLOBS]);
  });

  it("ignores unrelated env data so old hosted policy cannot affect self-host review policy", async () => {
    const globs = await loadHardGuardrailGlobs({ LEGACY_POLICY: { hardGuardrailGlobs: ["docs/**"] } } as unknown as Env, "JSONbored/gittensory");
    expect(globs).toEqual([...DEFAULT_CRUCIAL_GUARDRAIL_GLOBS, ...CONFIG_AS_CODE_GUARDRAIL_GLOBS, ...ENGINE_DECISION_GUARDRAIL_GLOBS, ...SELFHOST_RUNTIME_GUARDRAIL_GLOBS]);
    expect(matchesAny("docs/readme.md", globs)).toBe(false);
  });

  it("guards the engine's own crown-jewel decision paths for every repo", async () => {
    const globs = await loadHardGuardrailGlobs({} as Env, "o/r");
    for (const enginePath of [
      "src/rules/advisory.ts",
      "src/services/agent-action-executor.ts",
      "src/settings/agent-execution.ts",
      "src/queue/processors.ts", // the orchestration + the direct-close paths — the gap this constant closes
      "src/queue/dlq.ts",
      "src/github/pr-actions.ts",
      "src/scoring/model.ts",
      "src/auth/session.ts",
      "src/review/guardrail-config.ts",
    ]) {
      expect(matchesAny(enginePath, globs)).toBe(true);
    }
    expect(matchesAny("docs/readme.md", globs)).toBe(false);
    expect(matchesAny("src/utils/json.ts", globs)).toBe(false); // a non-decision src file remains auto-mergeable
  });

  it("guards self-host runtime, persistence, and container chokepoints without guarding ordinary docs", async () => {
    const globs = await loadHardGuardrailGlobs({} as Env, "o/r");
    for (const selfhostPath of [
      "src/selfhost/pg-queue.ts",
      "src/server.ts",
      "src/db/repositories.ts",
      "Dockerfile",
      "docker-compose.yml",
      "docker-compose.override.yml.example",
      "systemd/gittensory-docker-prune.timer.example",
    ]) {
      expect(matchesAny(selfhostPath, globs)).toBe(true);
    }
    expect(matchesAny("migrations/0107_example.sql", globs)).toBe(false); // covered by the dedicated collision recheck
    expect(matchesAny("apps/gittensory-ui/src/routes/docs.self-hosting-configuration.tsx", globs)).toBe(false);
    expect(matchesAny("README.md", globs)).toBe(false);
  });

  it("guards the gate's own policy files for every repo (the config-as-code self-weakening hole)", async () => {
    const globs = await loadHardGuardrailGlobs({} as Env, "o/r");
    for (const policyFile of [".gittensory.yml", ".github/gittensory.json", "codecov.yml", ".github/codecov.yml"]) {
      expect(matchesAny(policyFile, globs)).toBe(true);
    }
    expect(matchesAny("src/utils/json.ts", globs)).toBe(false);
    expect(matchesAny("README.md", globs)).toBe(false); // an unrelated file is still auto-mergeable
  });
});
