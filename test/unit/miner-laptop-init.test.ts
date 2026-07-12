import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkDockerPresent,
  checkLaptopStateSqlite,
  type InteractiveInitPrompt,
  initLaptopState,
  resolveLaptopInitEnvFilePath,
  resolveLaptopStateDbPath,
  runInit,
} from "../../packages/gittensory-miner/lib/laptop-init.js";

const roots: string[] = [];

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-init-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("gittensory-miner laptop init (#2329)", () => {
  it("resolves the laptop SQLite path from the state-dir override and XDG fallback", () => {
    expect(
      resolveLaptopStateDbPath({
        GITTENSORY_MINER_CONFIG_DIR: "/custom/state",
      }),
    ).toBe("/custom/state/laptop-state.sqlite3");
    expect(resolveLaptopStateDbPath({ XDG_CONFIG_HOME: "/xdg" })).toBe(
      "/xdg/gittensory-miner/laptop-state.sqlite3",
    );
  });

  it("fresh init creates the state dir and SQLite file", () => {
    const root = tempRoot();
    const env = { GITTENSORY_MINER_CONFIG_DIR: join(root, "state") };
    const first = initLaptopState(env);
    expect(first.created).toBe(true);
    expect(existsSync(first.dbPath)).toBe(true);
    expect(existsSync(first.stateDir)).toBe(true);
    expect(checkLaptopStateSqlite(env).ok).toBe(true);
  });

  it("re-running init is idempotent and does not clobber existing metadata", () => {
    const root = tempRoot();
    const env = { GITTENSORY_MINER_CONFIG_DIR: join(root, "state") };
    const first = initLaptopState(env);
    writeFileSync(join(first.stateDir, "marker.txt"), "keep-me");
    const second = initLaptopState(env);
    expect(second.created).toBe(false);
    expect(readFileSync(join(first.stateDir, "marker.txt"), "utf8")).toBe(
      "keep-me",
    );
  });

  it("runInit prints human text (0) and machine JSON with --json", async () => {
    const root = tempRoot();
    const env = { GITTENSORY_MINER_CONFIG_DIR: join(root, "state") };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await runInit([], env)).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toContain("initialized");
    log.mockClear();
    expect(await runInit(["--json"], env)).toBe(0);
    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload.created).toBe(false);
    expect(payload.dbPath).toBe(resolveLaptopStateDbPath(env));
  });

  it("interactive init writes a starter .env file and reruns doctor with the collected values", async () => {
    const root = tempRoot();
    const env = {
      GITTENSORY_MINER_CONFIG_DIR: join(root, "state"),
      MINER_CODING_AGENT_PROVIDER: "codex-cli",
      MINER_CODING_AGENT_CODEX_MODEL: "old-model",
      MINER_CODING_AGENT_TIMEOUT_MS: "77777",
    };
    const prompts = {
      askSecret: vi.fn(async (question: string) => {
        expect(question).toContain("GITHUB_TOKEN");
        return "gh-token-123";
      }),
      askChoice: vi.fn(
        async (
          question: string,
          choices: ReadonlyArray<{ value: string; label: string }>,
          defaultIndex: number,
        ) => {
          expect(question).toContain("coding-agent provider");
          expect(choices.map((choice) => choice.value)).toEqual([
            "claude-cli",
            "codex-cli",
            "agent-sdk",
            "noop",
          ]);
          expect(defaultIndex).toBe(1);
          return "codex-cli";
        },
      ),
      askQuestion: vi.fn(async (question: string, defaultValue: string) => {
        if (question.startsWith("Codex model override")) {
          expect(defaultValue).toBe("old-model");
          return "codex-5";
        }
        if (question === "CLI timeout in ms") {
          expect(defaultValue).toBe("77777");
          return "180000";
        }
        throw new Error(`unexpected question: ${question}`);
      }),
    } satisfies InteractiveInitPrompt;
    const doctor = vi.fn(
      async (
        _args: string[],
        doctorEnv: Record<string, string | undefined>,
        cwd: string,
      ) => {
        expect(cwd).toBe(root);
        expect(doctorEnv).toMatchObject({
          GITHUB_TOKEN: "gh-token-123",
          MINER_CODING_AGENT_PROVIDER: "codex-cli",
          MINER_CODING_AGENT_CODEX_MODEL: "codex-5",
          MINER_CODING_AGENT_TIMEOUT_MS: "180000",
        });
        return 0;
      },
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(
      await runInit(["--interactive"], env, {
        interactivePrompt: prompts,
        runDoctor: doctor,
        cwd: root,
      }),
    ).toBe(0);
    expect(prompts.askSecret).toHaveBeenCalledTimes(1);
    expect(prompts.askChoice).toHaveBeenCalledTimes(1);
    expect(prompts.askQuestion).toHaveBeenCalledTimes(2);
    expect(doctor).toHaveBeenCalledTimes(1);

    const envFilePath = resolveLaptopInitEnvFilePath(env);
    expect(readFileSync(envFilePath, "utf8")).toBe(
      [
        "# Generated by `gittensory-miner init --interactive`.",
        "# Keep this file private; it contains the operator's token and miner config.",
        'GITHUB_TOKEN="gh-token-123"',
        'MINER_CODING_AGENT_PROVIDER="codex-cli"',
        'MINER_CODING_AGENT_CODEX_MODEL="codex-5"',
        'MINER_CODING_AGENT_TIMEOUT_MS="180000"',
        "",
      ].join("\n"),
    );
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      `initialized ${join(root, "state")}`,
      `sqlite: ${resolveLaptopStateDbPath(env)}`,
      `env: ${envFilePath}`,
    ]);
  });

  it("interactive init supports claude-cli follow-up prompts", async () => {
    const root = tempRoot();
    const env = { GITTENSORY_MINER_CONFIG_DIR: join(root, "state") };
    const prompts = {
      askSecret: vi.fn(async () => "gh-token-456"),
      askChoice: vi.fn(async () => "claude-cli"),
      askQuestion: vi.fn(async (question: string, defaultValue: string) => {
        if (question.startsWith("Claude model override")) {
          expect(defaultValue).toBe("");
          return "claude-sonnet-4";
        }
        if (question === "CLI timeout in ms") {
          expect(defaultValue).toBe("120000");
          return "90000";
        }
        throw new Error(`unexpected question: ${question}`);
      }),
    };
    const doctor = vi.fn(async () => 0);

    expect(
      await runInit(["--interactive"], env, {
        interactivePrompt: prompts,
        runDoctor: doctor,
        cwd: root,
      }),
    ).toBe(0);
    expect(readFileSync(resolveLaptopInitEnvFilePath(env), "utf8")).toContain(
      'MINER_CODING_AGENT_CLAUDE_MODEL="claude-sonnet-4"',
    );
  });

  it("interactive init skips companion prompts for agent-sdk and noop providers", async () => {
    const root = tempRoot();
    const env = { GITTENSORY_MINER_CONFIG_DIR: join(root, "state") };
    const prompts = {
      askSecret: vi.fn(async () => "gh-token-123"),
      askChoice: vi.fn(async () => "agent-sdk"),
      askQuestion: vi.fn(() => {
        throw new Error("unexpected follow-up prompt");
      }),
    };
    const doctor = vi.fn(async () => 0);

    expect(
      await runInit(["--interactive"], env, {
        interactivePrompt: prompts,
        runDoctor: doctor,
        cwd: root,
      }),
    ).toBe(0);
    expect(prompts.askSecret).toHaveBeenCalledTimes(1);
    expect(prompts.askChoice).toHaveBeenCalledTimes(1);
    expect(prompts.askQuestion).not.toHaveBeenCalled();
    expect(readFileSync(resolveLaptopInitEnvFilePath(env), "utf8")).toContain(
      'MINER_CODING_AGENT_PROVIDER="agent-sdk"',
    );
  });

  it("rejects --interactive when paired with --json or --verify-token", async () => {
    const root = tempRoot();
    const env = { GITTENSORY_MINER_CONFIG_DIR: join(root, "state") };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const prompts = {
      askSecret: vi.fn(),
      askChoice: vi.fn(),
      askQuestion: vi.fn(),
    };

    expect(
      await runInit(["--interactive", "--json"], env, {
        interactivePrompt: prompts,
        cwd: root,
      }),
    ).toBe(1);
    expect(
      await runInit(["--interactive", "--verify-token"], env, {
        interactivePrompt: prompts,
        cwd: root,
      }),
    ).toBe(1);
    expect(error.mock.calls.map(([line]) => line)).toEqual([
      "--interactive cannot be combined with --json",
      "--interactive cannot be combined with --verify-token",
    ]);
  });

  it("doctor sqlite check reports a missing file with guidance", () => {
    const root = tempRoot();
    const env = { GITTENSORY_MINER_CONFIG_DIR: join(root, "state") };
    const check = checkLaptopStateSqlite(env);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("gittensory-miner init");
  });

  it("doctor sqlite check reports unreadable files", () => {
    const root = tempRoot();
    const env = { GITTENSORY_MINER_CONFIG_DIR: join(root, "state") };
    const dbPath = resolveLaptopStateDbPath(env);
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(dbPath, "not-a-sqlite-db");
    chmodSync(dbPath, 0o600);
    const check = checkLaptopStateSqlite(env);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain(dbPath);
  });

  it("doctor reports absent Docker gracefully (informational, always ok)", () => {
    const check = checkDockerPresent({ resolveDockerPath: () => null });
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("optional");
  });

  it("doctor reports Docker when the injected resolver finds it", () => {
    const check = checkDockerPresent({
      resolveDockerPath: () => "/usr/bin/docker",
    });
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("/usr/bin/docker");
  });

  it("doctor finds Docker from PATH without executing a PATH-controlled which", () => {
    const root = tempRoot();
    const attackerDir = join(root, "attacker-bin");
    const dockerDir = join(root, "docker-bin");
    const marker = join(root, "which-ran");
    mkdirSync(attackerDir, { recursive: true });
    mkdirSync(dockerDir, { recursive: true });
    writeFileSync(
      join(attackerDir, "which"),
      `#!/bin/sh\necho pwned > "${marker}"\necho /attacker/docker\n`,
    );
    writeFileSync(join(dockerDir, "docker"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(attackerDir, "which"), 0o700);
    chmodSync(join(dockerDir, "docker"), 0o700);

    const check = checkDockerPresent({
      env: { PATH: `${attackerDir}${delimiter}${dockerDir}` },
    });

    expect(check.ok).toBe(true);
    expect(check.detail).toContain(join(dockerDir, "docker"));
    expect(existsSync(marker)).toBe(false);
  });

  it("runInit notes when sqlite already existed", async () => {
    const root = tempRoot();
    const env = { GITTENSORY_MINER_CONFIG_DIR: join(root, "state") };
    initLaptopState(env);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await runInit([], env)).toBe(0);
    expect(String(log.mock.calls[1]?.[0])).toContain("already existed");
  });

  it("makes no network calls", async () => {
    const fetchStub = vi.fn(() => {
      throw new Error("network calls are forbidden");
    });
    vi.stubGlobal("fetch", fetchStub);
    const root = tempRoot();
    const env = { GITTENSORY_MINER_CONFIG_DIR: join(root, "state") };
    vi.spyOn(console, "log").mockImplementation(() => {});
    await runInit([], env);
    checkDockerPresent();
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
