import { describe, expect, it } from "vitest";
import {
  resolveKillSwitch,
  isMinerWriteAllowed,
  isGlobalKillSwitchEnabled,
} from "../../packages/gittensory-engine/src/index";

const REPO = "acme/widgets";

describe("miner kill-switch (#2341)", () => {
  it("global switch halts every repo regardless of per-repo state", () => {
    const v = resolveKillSwitch({ global: true, haltedRepos: [] }, REPO);
    expect(v.halted).toBe(true);
    expect(v.scope).toBe("global");
    expect(isMinerWriteAllowed({ global: true, haltedRepos: [] }, "other/repo")).toBe(false);
  });

  it("per-repo switch halts only its own repo, leaving others running", () => {
    const state = { global: false, haltedRepos: [REPO] };
    const halted = resolveKillSwitch(state, REPO);
    expect(halted.halted).toBe(true);
    expect(halted.scope).toBe("repo");
    expect(halted.reason).toContain(REPO);
    expect(isMinerWriteAllowed(state, "other/repo")).toBe(true); // untouched
  });

  it("allows writes when nothing is engaged (switch off resumes normal operation)", () => {
    const v = resolveKillSwitch({ global: false, haltedRepos: [] }, REPO);
    expect(v.halted).toBe(false);
    expect(v.scope).toBeNull();
    expect(isMinerWriteAllowed({ global: false, haltedRepos: [] }, REPO)).toBe(true);
  });

  it("matches per-repo halts case-insensitively (a casing mismatch cannot slip through)", () => {
    expect(isMinerWriteAllowed({ global: false, haltedRepos: ["Acme/Widgets"] }, "acme/widgets")).toBe(false);
  });

  it("parses the global kill-switch env value on the codebase truthy convention", () => {
    for (const on of ["true", "1", "yes", "on", "TRUE", " on "]) {
      expect(isGlobalKillSwitchEnabled(on)).toBe(true);
    }
    for (const off of ["false", "0", "no", "", undefined, "maybe"]) {
      expect(isGlobalKillSwitchEnabled(off)).toBe(false);
    }
  });

  it("global takes precedence over an also-halted repo (checked first)", () => {
    const v = resolveKillSwitch({ global: true, haltedRepos: [REPO] }, REPO);
    expect(v.scope).toBe("global");
  });
});
