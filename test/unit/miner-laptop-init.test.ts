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
  initLaptopState,
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
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("gittensory-miner laptop init (#2329)", () => {
  it("resolves the laptop SQLite path from the state-dir override and XDG fallback", () => {
    expect(resolveLaptopStateDbPath({ LOOPOVER_MINER_CONFIG_DIR: "/custom/state" }))
      .toBe("/custom/state/laptop-state.sqlite3");
    expect(resolveLaptopStateDbPath({ XDG_CONFIG_HOME: "/xdg" }))
      .toBe("/xdg/loopover-miner/laptop-state.sqlite3");
  });

  it("fresh init creates the state dir and SQLite file", () => {
    const root = tempRoot();
    const env = { LOOPOVER_MINER_CONFIG_DIR: join(root, "state") };
    const first = initLaptopState(env);
    expect(first.created).toBe(true);
    expect(existsSync(first.dbPath)).toBe(true);
    expect(existsSync(first.stateDir)).toBe(true);
    expect(checkLaptopStateSqlite(env).ok).toBe(true);
  });

  it("re-running init is idempotent and does not clobber existing metadata", () => {
    const root = tempRoot();
    const env = { LOOPOVER_MINER_CONFIG_DIR: join(root, "state") };
    const first = initLaptopState(env);
    writeFileSync(join(first.stateDir, "marker.txt"), "keep-me");
    const second = initLaptopState(env);
    expect(second.created).toBe(false);
    expect(readFileSync(join(first.stateDir, "marker.txt"), "utf8")).toBe("keep-me");
  });

  it("runInit prints human text (0) and machine JSON with --json", async () => {
    const root = tempRoot();
    const env = { LOOPOVER_MINER_CONFIG_DIR: join(root, "state") };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await runInit([], env)).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toContain("initialized");
    log.mockClear();
    expect(await runInit(["--json"], env)).toBe(0);
    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload.created).toBe(false);
    expect(payload.dbPath).toBe(resolveLaptopStateDbPath(env));
  });

  it("doctor sqlite check reports a missing file with guidance", () => {
    const root = tempRoot();
    const env = { LOOPOVER_MINER_CONFIG_DIR: join(root, "state") };
    const check = checkLaptopStateSqlite(env);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("gittensory-miner init");
  });

  it("doctor sqlite check reports unreadable files", () => {
    const root = tempRoot();
    const env = { LOOPOVER_MINER_CONFIG_DIR: join(root, "state") };
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
    const check = checkDockerPresent({ resolveDockerPath: () => "/usr/bin/docker" });
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

    const check = checkDockerPresent({ env: { PATH: `${attackerDir}${delimiter}${dockerDir}` } });

    expect(check.ok).toBe(true);
    expect(check.detail).toContain(join(dockerDir, "docker"));
    expect(existsSync(marker)).toBe(false);
  });

  it("runInit notes when sqlite already existed", async () => {
    const root = tempRoot();
    const env = { LOOPOVER_MINER_CONFIG_DIR: join(root, "state") };
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
    const env = { LOOPOVER_MINER_CONFIG_DIR: join(root, "state") };
    vi.spyOn(console, "log").mockImplementation(() => {});
    await runInit([], env);
    checkDockerPresent();
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
