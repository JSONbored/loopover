import { describe, expect, it } from "vitest";

import { buildMinerCommandActions, sanitizeMinerCommand } from "@/lib/miner-commands";

// (#8677) Direct coverage for miner-commands.ts: sensitive-term redaction and every
// buildMinerCommandActions branch. Previously only exercised indirectly via miner-panel.test.tsx.

describe("sanitizeMinerCommand (#8677)", () => {
  it("redacts each forbidden term=value / term: value category", () => {
    const cases = [
      { leak: "wallet=abc123", banned: /abc123/ },
      { leak: "hotkey: 'hk-secret'", banned: /hk-secret/ },
      { leak: 'coldkey="ck-secret"', banned: /ck-secret/ },
      { leak: "mnemonic = word1-word2-word3", banned: /word1-word2-word3/ },
      { leak: "trust-score: 0.99", banned: /0\.99/ },
      { leak: "trust_score=0.5", banned: /0\.5/ },
      { leak: "raw-trust: 1", banned: /:\s*1\b/ },
      { leak: "raw_trust=1", banned: /=\s*1\b/ },
      { leak: "private-reviewability: high", banned: /high/ },
      { leak: "private_reviewability=low", banned: /low/ },
    ];
    for (const { leak, banned } of cases) {
      const out = sanitizeMinerCommand(`loopover-mcp status --json ${leak}`);
      expect(out).toContain("[redacted]");
      expect(out).not.toMatch(banned);
    }
  });

  it("passes through a command with none of the forbidden assignment patterns", () => {
    const cmd = "loopover-mcp agent plan --login alice --json";
    expect(sanitizeMinerCommand(cmd)).toBe(cmd);
  });

  it("does not corrupt a legitimate login/repo token that merely contains a forbidden word as a name", () => {
    // Contract: assignment form is required. A repo named wallet-adapter must not be mangled.
    const cmd = "loopover-mcp preflight --login trust-score --repo wallet-adapter/sdk --base origin/main --json";
    expect(sanitizeMinerCommand(cmd)).toBe(cmd);
  });

  it("redacts POSIX home, absolute, and Windows absolute local paths", () => {
    expect(sanitizeMinerCommand("run --cwd /home/user/project --json")).toContain("<local-path>");
    expect(sanitizeMinerCommand("run --cwd ~/code/repo --json")).toContain("<local-path>");
    expect(sanitizeMinerCommand("run --cwd C:\\Users\\admin\\proj --json")).toContain("<local-path>");
  });
});

describe("buildMinerCommandActions (#8677)", () => {
  it("returns setup/ready actions when login and repo are absent (fallback placeholders)", () => {
    const actions = buildMinerCommandActions({});
    expect(actions.map((a) => a.id)).toEqual(["install", "status", "doctor", "plan", "preflight", "packet"]);
    expect(actions.find((a) => a.id === "install")).toMatchObject({ state: "setup", copyable: true });
    expect(actions.find((a) => a.id === "status")).toMatchObject({ state: "ready", copyable: true });
    expect(actions.find((a) => a.id === "doctor")).toMatchObject({ state: "ready", copyable: true });
    expect(actions.find((a) => a.id === "plan")).toMatchObject({
      state: "needs_login",
      copyable: false,
      command: expect.stringContaining("your-login"),
    });
    expect(actions.find((a) => a.id === "preflight")).toMatchObject({
      state: "needs_login",
      copyable: false,
      command: expect.stringContaining("owner/repo"),
    });
    expect(actions.find((a) => a.id === "packet")).toMatchObject({ state: "needs_login", copyable: false });
  });

  it("marks plan ready and preflight/packet needs_repo when only login is present", () => {
    const actions = buildMinerCommandActions({ login: "alice" });
    expect(actions.find((a) => a.id === "plan")).toMatchObject({
      state: "ready",
      copyable: true,
      command: expect.stringContaining("--login alice"),
    });
    expect(actions.find((a) => a.id === "preflight")).toMatchObject({ state: "needs_repo", copyable: false });
    expect(actions.find((a) => a.id === "packet")).toMatchObject({ state: "needs_repo", copyable: false });
  });

  it("marks preflight and packet ready when both login and repo are present", () => {
    const actions = buildMinerCommandActions({ login: "alice", repoFullName: "acme/widgets" });
    expect(actions.find((a) => a.id === "preflight")).toMatchObject({
      state: "ready",
      copyable: true,
      command: "loopover-mcp preflight --login alice --repo acme/widgets --base origin/main --json",
    });
    expect(actions.find((a) => a.id === "packet")).toMatchObject({
      state: "ready",
      copyable: true,
      command: "loopover-mcp agent packet --login alice --repo acme/widgets --base origin/main --json",
    });
  });

  it("treats invalid login/repo shapes as missing (falls back to placeholders)", () => {
    const actions = buildMinerCommandActions({ login: "bad login!", repoFullName: "not-a-repo" });
    expect(actions.find((a) => a.id === "plan")?.state).toBe("needs_login");
    expect(actions.find((a) => a.id === "preflight")?.command).toContain("your-login");
    expect(actions.find((a) => a.id === "preflight")?.command).toContain("owner/repo");
  });

  it("runs every built command through sanitizeMinerCommand", () => {
    const actions = buildMinerCommandActions({ login: "alice", repoFullName: "acme/widgets" });
    for (const action of actions) {
      expect(action.command).toBe(sanitizeMinerCommand(action.command));
    }
  });
});
