import { describe, expect, it } from "vitest";
import { buildMinerCommandActions } from "../../apps/gittensory-ui/src/lib/miner-commands";

describe("miner dashboard command actions", () => {
  it("builds copyable miner commands for an authenticated repo context", () => {
    const commands = buildMinerCommandActions({
      login: "JSONbored",
      repoFullName: "JSONbored/gittensory",
    });

    expect(commands.map((command) => command.id)).toEqual([
      "install",
      "status",
      "doctor",
      "plan",
      "preflight",
      "packet",
    ]);
    expect(commands.every((command) => command.boundary === "local-mcp")).toBe(
      true,
    );
    expect(commands.find((command) => command.id === "plan")).toMatchObject({
      command: "gittensory-mcp agent plan --login JSONbored --json",
      state: "ready",
      copyable: true,
    });
    expect(
      commands.find((command) => command.id === "preflight"),
    ).toMatchObject({
      command:
        "gittensory-mcp preflight --login JSONbored --repo JSONbored/gittensory --base origin/main --json",
      state: "ready",
      copyable: true,
    });
    expect(commands.find((command) => command.id === "packet")).toMatchObject({
      command:
        "gittensory-mcp agent packet --login JSONbored --repo JSONbored/gittensory --base origin/main --json",
      state: "ready",
      copyable: true,
    });
  });

  it("keeps repo-bound commands visible but not copyable when repo context is missing", () => {
    const commands = buildMinerCommandActions({ login: "oktofeesh1" });

    expect(commands.find((command) => command.id === "install")).toMatchObject({
      copyable: true,
      state: "setup",
    });
    expect(commands.find((command) => command.id === "plan")).toMatchObject({
      copyable: true,
      state: "ready",
    });
    expect(
      commands.find((command) => command.id === "preflight"),
    ).toMatchObject({
      command: expect.stringContaining("--repo owner/repo"),
      copyable: false,
      state: "needs_repo",
    });
    expect(commands.find((command) => command.id === "packet")).toMatchObject({
      command: expect.stringContaining("--repo owner/repo"),
      copyable: false,
      state: "needs_repo",
    });
  });

  it("does not leak local paths or unsafe private terms into command snippets", () => {
    const commands = buildMinerCommandActions({
      login: "/Users/private/hotkey",
      repoFullName: "/home/private/wallet/repo",
    });
    const serialized = JSON.stringify(commands);

    expect(commands.find((command) => command.id === "plan")).toMatchObject({
      command: "gittensory-mcp agent plan --login your-login --json",
      copyable: false,
      state: "needs_login",
    });
    expect(
      commands.find((command) => command.id === "preflight"),
    ).toMatchObject({
      command: expect.stringContaining("--repo owner/repo"),
      copyable: false,
      state: "needs_login",
    });
    expect(serialized).not.toMatch(
      /\/Users|\/home|wallet|hotkey|raw trust|private reviewability/i,
    );
  });
});
