import { describe, expect, it, vi } from "vitest";

vi.mock("@loopover/engine", async () => {
  return import("../../packages/loopover-engine/src/index");
});

import {
  resolveDocumentedCodingAgentMode,
  resolveDocumentedDiscoverTokenEnvVar,
  resolveDocumentedGovernorActionMode,
  resolveDocumentedKillSwitchScope,
} from "../../packages/loopover-miner/lib/config-precedence.js";
import { parseDiscoverArgs } from "../../packages/loopover-miner/lib/discover-cli.js";
import { parseAttemptArgs } from "../../packages/loopover-miner/lib/attempt-cli.js";
import { resolveCodingAgentModeFromConfig } from "../../packages/loopover-engine/src/index";

describe("miner config precedence (#5198)", () => {
  describe("kill switch: env global > .loopover-miner.yml repo pause", () => {
    it("global env wins when both global env and repo yml pause are set", () => {
      expect(resolveDocumentedKillSwitchScope({ LOOPOVER_MINER_KILL_SWITCH: "true" }, true)).toBe("global");
    });

    it("falls back to repo yml pause when global env is unset", () => {
      expect(resolveDocumentedKillSwitchScope({}, true)).toBe("repo");
      expect(resolveDocumentedKillSwitchScope({}, false)).toBe("none");
    });
  });

  describe("governor live mode: env AND yml both required", () => {
    it("requires both operator env and repo yml opt-in for live", () => {
      expect(
        resolveDocumentedGovernorActionMode({
          killSwitchScope: "none",
          repoLiveModeOptIn: "live",
          globalLiveModeOptIn: true,
        }),
      ).toBe("live");
    });

    it("falls back to dry_run when only env is set (yml missing)", () => {
      expect(
        resolveDocumentedGovernorActionMode({
          killSwitchScope: "none",
          repoLiveModeOptIn: null,
          globalLiveModeOptIn: true,
        }),
      ).toBe("dry_run");
    });

    it("falls back to dry_run when only yml is set (env missing)", () => {
      expect(
        resolveDocumentedGovernorActionMode({
          killSwitchScope: "none",
          repoLiveModeOptIn: "live",
          globalLiveModeOptIn: false,
        }),
      ).toBe("dry_run");
    });
  });

  describe("coding-agent mode: MINER_CODING_AGENT_PAUSED > CLI --live", () => {
    it("env pause wins over CLI --live", () => {
      expect(resolveDocumentedCodingAgentMode({ MINER_CODING_AGENT_PAUSED: "1" }, true)).toBe("paused");
    });

    it("CLI --live absent defaults to dry_run without env pause", () => {
      expect(resolveDocumentedCodingAgentMode({}, false)).toBe("dry_run");
    });

    it("CLI --live enables live when env pause is unset", () => {
      expect(resolveDocumentedCodingAgentMode({}, true)).toBe("live");
    });
  });

  describe("discover token env var: CLI > programmatic > default (three sources)", () => {
    it("CLI --token-env wins when CLI, programmatic, and default all differ", () => {
      expect(
        resolveDocumentedDiscoverTokenEnvVar({
          cliTokenEnv: "CLI_TOKEN_ENV",
          optionsTokenEnv: "PROGRAMMATIC_TOKEN_ENV",
        }),
      ).toBe("CLI_TOKEN_ENV");
    });

    it("falls back to programmatic when CLI is absent", () => {
      expect(
        resolveDocumentedDiscoverTokenEnvVar({
          cliTokenEnv: null,
          optionsTokenEnv: "PROGRAMMATIC_TOKEN_ENV",
        }),
      ).toBe("PROGRAMMATIC_TOKEN_ENV");
    });

    it("falls back to forge default GITHUB_TOKEN when only the default layer applies", () => {
      expect(resolveDocumentedDiscoverTokenEnvVar({})).toBe("GITHUB_TOKEN");
    });
  });

  describe("invariant: documented helpers match production call sites", () => {
    it("attempt-cli wires CLI --live into resolveCodingAgentModeFromConfig the same way as config-precedence", () => {
      const env = { MINER_CODING_AGENT_PAUSED: "0" };
      for (const live of [false, true]) {
        const parsed = parseAttemptArgs(["acme/widgets", "7", "--miner-login", "miner", ...(live ? ["--live"] : [])]);
        expect("error" in parsed).toBe(false);
        if ("error" in parsed) continue;
        const production = resolveCodingAgentModeFromConfig({ env, agentDryRun: !parsed.live });
        const documented = resolveDocumentedCodingAgentMode(env, parsed.live);
        expect(documented).toBe(production);
      }
    });

    it("discover-cli tokenEnv resolution matches config-precedence for parsed CLI args", () => {
      const parsed = parseDiscoverArgs(["acme/widgets", "--token-env", "FORGE_PAT"]);
      expect("error" in parsed).toBe(false);
      if ("error" in parsed) return;
      expect(
        resolveDocumentedDiscoverTokenEnvVar({
          cliTokenEnv: parsed.tokenEnv ?? null,
          optionsTokenEnv: "SHOULD_NOT_WIN",
        }),
      ).toBe("FORGE_PAT");
    });
  });

  describe("canary: precedence assertions fail when expectations are wrong", () => {
    it("does not treat a malformed yml live opt-in as live even with env set", () => {
      expect(
        resolveDocumentedGovernorActionMode({
          killSwitchScope: "none",
          repoLiveModeOptIn: "yes",
          globalLiveModeOptIn: true,
        }),
      ).toBe("dry_run");
    });

    it("does not treat absent CLI --live as live coding-agent mode", () => {
      expect(resolveDocumentedCodingAgentMode({}, false)).not.toBe("live");
    });
  });
});
