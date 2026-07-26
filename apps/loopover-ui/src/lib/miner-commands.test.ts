import { describe, expect, it } from "vitest";

import {
  buildMinerCommandActions,
  sanitizeMinerCommand,
  type MinerCommandAction,
} from "@/lib/miner-commands";

// (#8677) Direct coverage for the miner-command builder + public-surface redaction. miner-panel.test.tsx
// never calls these helpers; a silent redaction regression would otherwise ship unnoticed.

function byId(actions: MinerCommandAction[], id: MinerCommandAction["id"]): MinerCommandAction {
  const action = actions.find((entry) => entry.id === id);
  if (!action) throw new Error(`missing action ${id}`);
  return action;
}

describe("sanitizeMinerCommand (#8677)", () => {
  it("leaves a clean command unmodified (passthrough)", () => {
    const command = "loopover-mcp status --json";
    expect(sanitizeMinerCommand(command)).toBe(command);
  });

  it("redacts each forbidden term=value category so the sensitive term never appears in the output", () => {
    // Dummy RHS values only — the contract under test is that the KEY=value leak shape is replaced.
    const cases = [
      "wallet=dummy",
      "hotkey: dummy",
      "coldkey = dummy",
      "mnemonic='seed-phrase-placeholder'",
      'trust score: "band-only"',
      "trust-score=band",
      "trust_score=band",
      "raw-trust=x",
      "raw trust=x",
      "private-reviewability=x",
      "private_reviewability=x",
    ] as const;

    for (const leak of cases) {
      const out = sanitizeMinerCommand(`prefix ${leak} suffix`);
      expect(out).toBe("prefix [redacted] suffix");
      expect(out).not.toMatch(/wallet|hotkey|coldkey|mnemonic|trust|reviewability/i);
      expect(out).not.toContain("dummy");
      expect(out).not.toContain("seed-phrase-placeholder");
      expect(out).not.toContain("band");
    }
  });

  it("does not redact a login/repo token that merely contains a forbidden word without an assignment", () => {
    // Documented contract: assignment is required so names like wallet-adapter stay usable.
    const command = "loopover-mcp agent plan --login trust-score --repo acme/wallet-adapter --json";
    expect(sanitizeMinerCommand(command)).toBe(command);
  });

  it("redacts home, Windows, and absolute local paths", () => {
    expect(sanitizeMinerCommand("run --file ~/projects/demo/file.txt")).toBe(
      "run --file <local-path>",
    );
    expect(sanitizeMinerCommand("run --file C:\\Users\\dev\\demo\\file.txt")).toBe(
      "run --file <local-path>",
    );
    expect(sanitizeMinerCommand("run --file=/tmp/demo/file.txt")).toBe("run --file=<local-path>");
    expect(sanitizeMinerCommand("/tmp/alone")).toBe("<local-path>");
  });
});

describe("buildMinerCommandActions (#8677)", () => {
  it("returns the six fixed actions with setup/ready defaults when login and repo are absent", () => {
    const actions = buildMinerCommandActions({});
    expect(actions.map((action) => action.id)).toEqual([
      "install",
      "status",
      "doctor",
      "plan",
      "preflight",
      "packet",
    ]);

    expect(byId(actions, "install")).toMatchObject({
      state: "setup",
      copyable: true,
      boundary: "local-mcp",
      command: "npm install -g @loopover/mcp@latest",
    });
    expect(byId(actions, "status")).toMatchObject({
      state: "ready",
      copyable: true,
      command: "loopover-mcp status --json",
    });
    expect(byId(actions, "doctor")).toMatchObject({
      state: "ready",
      copyable: true,
      command: "loopover-mcp doctor --json",
    });

    const plan = byId(actions, "plan");
    expect(plan.state).toBe("needs_login");
    expect(plan.copyable).toBe(false);
    expect(plan.command).toContain("--login your-login");

    for (const id of ["preflight", "packet"] as const) {
      const action = byId(actions, id);
      expect(action.state).toBe("needs_login");
      expect(action.copyable).toBe(false);
      expect(action.command).toContain("--login your-login");
      expect(action.command).toContain("--repo owner/repo");
    }
  });

  it("marks plan ready when login is present, but preflight/packet still need a repo", () => {
    const actions = buildMinerCommandActions({ login: "alice", repoFullName: null });
    expect(byId(actions, "plan")).toMatchObject({
      state: "ready",
      copyable: true,
      command: "loopover-mcp agent plan --login alice --json",
    });
    for (const id of ["preflight", "packet"] as const) {
      expect(byId(actions, id)).toMatchObject({
        state: "needs_repo",
        copyable: false,
      });
      expect(byId(actions, id).command).toContain("--login alice");
      expect(byId(actions, id).command).toContain("--repo owner/repo");
    }
  });

  it("marks plan/preflight/packet ready and copyable when both login and repo are present", () => {
    const actions = buildMinerCommandActions({
      login: "alice",
      repoFullName: "acme/widgets",
    });
    expect(byId(actions, "plan")).toMatchObject({
      state: "ready",
      copyable: true,
      command: "loopover-mcp agent plan --login alice --json",
    });
    expect(byId(actions, "preflight")).toMatchObject({
      state: "ready",
      copyable: true,
      command:
        "loopover-mcp preflight --login alice --repo acme/widgets --base origin/main --json",
    });
    expect(byId(actions, "packet")).toMatchObject({
      state: "ready",
      copyable: true,
      command:
        "loopover-mcp agent packet --login alice --repo acme/widgets --base origin/main --json",
    });
  });

  it("treats invalid login/repo shapes as missing (fallback placeholders + needs_* states)", () => {
    const actions = buildMinerCommandActions({
      login: "bad login!",
      repoFullName: "not-a-repo",
    });
    expect(byId(actions, "plan").state).toBe("needs_login");
    expect(byId(actions, "plan").command).toContain("--login your-login");
    expect(byId(actions, "preflight").state).toBe("needs_login");
    expect(byId(actions, "preflight").command).toContain("--repo owner/repo");
  });

  it("treats nullish login with a valid repo as needs_login for preflight/packet", () => {
    // hasRepo alone cannot unlock preflight/packet — the needs_login arm of the ternary.
    const actions = buildMinerCommandActions({
      login: undefined,
      repoFullName: "acme/widgets",
    });
    expect(byId(actions, "plan").state).toBe("needs_login");
    expect(byId(actions, "preflight")).toMatchObject({
      state: "needs_login",
      copyable: false,
    });
    // Repo is accepted into the command string even while state stays needs_login.
    expect(byId(actions, "preflight").command).toContain("--repo acme/widgets");
  });

  it("runs every built command through sanitizeMinerCommand", () => {
    const actions = buildMinerCommandActions({
      login: "alice",
      repoFullName: "acme/widgets",
    });
    for (const action of actions) {
      expect(action.command).toBe(sanitizeMinerCommand(action.command));
    }
  });
});
