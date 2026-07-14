import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// backup-miner.sh / restore-miner.sh (#4872): tested against a FAKE sqlite3, mirroring
// selfhost-backup-script.test.ts's own established pattern -- not the real system binary, so this suite is
// deterministic and doesn't depend on `sqlite3` being on PATH in every CI environment (unlike the miner
// package's own JS code, which uses node:sqlite natively and has no such dependency; these two shell scripts
// are the one place in the miner package that shells out to the sqlite3 CLI tool at all).

const tmpRoots: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "gittensory-miner-backup-"));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { force: true, recursive: true });
});

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

/** A fake `sqlite3 <db> "<command>"`: `.backup 'dest'` copies the source db's bytes to dest (so tests can
 *  assert WHICH source produced WHICH destination content) unless the source's basename contains
 *  "backup-fails", which exits 2 to simulate a failed online backup. `PRAGMA integrity_check` answers "ok"
 *  unless the target file's content is literally "GARBAGE" (a corrupt-file sentinel tests write directly). */
function fakeSqlite(root: string): string {
  const bin = join(root, "sqlite-bin");
  mkdirSync(bin);
  writeExecutable(
    join(bin, "sqlite3"),
    `#!/bin/sh
db="$1"
cmd="$2"
case "$cmd" in
  *integrity_check*)
    if [ -f "$db" ] && [ "$(cat "$db")" = "GARBAGE" ]; then
      echo "malformed"
    else
      echo ok
    fi
    exit 0
    ;;
esac
dest="$(printf '%s\\n' "$cmd" | sed "s/^\\\\.backup '\\\\(.*\\\\)'\$/\\\\1/")"
if [ "$dest" = "$cmd" ]; then
  echo "unexpected sqlite command: $cmd" >&2
  exit 2
fi
case "$db" in
  *backup-fails*)
    echo "simulated online-backup failure for $db" >&2
    exit 1
    ;;
esac
cp "$db" "$dest"
`,
  );
  return bin;
}

function writeSqliteFile(dir: string, name: string, content = "real sqlite content"): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

function runBackup(stateDir: string, backupDir: string, sqliteBin: string, extraEnv: Record<string, string> = {}) {
  return execFileSync("sh", ["scripts/backup-miner.sh"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      LOOPOVER_MINER_CONFIG_DIR: stateDir,
      LOOPOVER_MINER_BACKUP_DIR: backupDir,
      PATH: `${sqliteBin}:${process.env.PATH ?? ""}`,
      ...extraEnv,
    },
  });
}

function runRestore(
  stateDir: string,
  backupDir: string,
  sqliteBin: string,
  args: string[] = ["--yes"],
): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("sh", ["scripts/restore-miner.sh", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        LOOPOVER_MINER_CONFIG_DIR: stateDir,
        LOOPOVER_MINER_BACKUP_DIR: backupDir,
        PATH: `${sqliteBin}:${process.env.PATH ?? ""}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, status: 0 };
  } catch (error) {
    const err = error as { stdout?: Buffer; stderr?: Buffer; status?: number };
    return {
      stdout: `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`,
      status: err.status ?? 1,
    };
  }
}

describe("backup-miner.sh", () => {
  it("backs up every *.sqlite3 file under the state dir, verified by integrity check", () => {
    const stateDir = tmpRoot();
    const backupDir = tmpRoot();
    const sqliteBin = fakeSqlite(tmpRoot());
    writeSqliteFile(stateDir, "run-state.sqlite3", "run-state content");
    writeSqliteFile(stateDir, "ranked-candidates.sqlite3", "ranked content");
    writeFileSync(join(stateDir, "not-a-store.txt"), "ignore me");

    const output = runBackup(stateDir, backupDir, sqliteBin);
    expect(output).toContain("backed up run-state.sqlite3");
    expect(output).toContain("backed up ranked-candidates.sqlite3");
    expect(output).toContain("complete");

    const timestamped = readdirSync(backupDir);
    expect(timestamped).toHaveLength(1);
    const dest = join(backupDir, timestamped[0]!);
    expect(readFileSync(join(dest, "run-state.sqlite3"), "utf8")).toBe("run-state content");
    expect(readFileSync(join(dest, "ranked-candidates.sqlite3"), "utf8")).toBe("ranked content");
    expect(existsSync(join(dest, "not-a-store.txt"))).toBe(false);
  });

  it("fails with a clear message and exit code when the state dir doesn't exist", () => {
    const stateDir = join(tmpRoot(), "does-not-exist");
    const backupDir = tmpRoot();
    const sqliteBin = fakeSqlite(tmpRoot());

    expect(() => runBackup(stateDir, backupDir, sqliteBin)).toThrow();
  });

  it("fails when the state dir has no *.sqlite3 files, without creating an empty backup directory", () => {
    const stateDir = tmpRoot();
    const backupDir = tmpRoot();
    const sqliteBin = fakeSqlite(tmpRoot());
    writeFileSync(join(stateDir, "readme.txt"), "no stores here");

    expect(() => runBackup(stateDir, backupDir, sqliteBin)).toThrow();
    expect(existsSync(backupDir) ? readdirSync(backupDir) : []).toHaveLength(0);
  });

  it("REGRESSION: a store whose online backup command itself fails is reported and the whole run exits non-zero", () => {
    const stateDir = tmpRoot();
    const backupDir = tmpRoot();
    const sqliteBin = fakeSqlite(tmpRoot());
    writeSqliteFile(stateDir, "backup-fails.sqlite3");
    writeSqliteFile(stateDir, "run-state.sqlite3", "good content");

    let threw = false;
    let output = "";
    try {
      runBackup(stateDir, backupDir, sqliteBin);
    } catch (error) {
      threw = true;
      output = String((error as { stdout?: Buffer }).stdout ?? "") + String((error as { stderr?: Buffer }).stderr ?? "");
    }
    expect(threw).toBe(true);
    expect(output).toContain("online backup failed for backup-fails.sqlite3");
    // The healthy store still gets backed up even though a sibling store's backup failed.
    const timestamped = readdirSync(backupDir);
    expect(timestamped).toHaveLength(1);
    expect(existsSync(join(backupDir, timestamped[0]!, "run-state.sqlite3"))).toBe(true);
    expect(existsSync(join(backupDir, timestamped[0]!, "backup-fails.sqlite3"))).toBe(false);
  });

  it("REGRESSION: a backed-up file that fails integrity_check is discarded, not kept as a silently-corrupt backup", () => {
    const stateDir = tmpRoot();
    const backupDir = tmpRoot();
    const sqliteBin = fakeSqlite(tmpRoot());
    // The fake sqlite3's `.backup` just copies bytes -- write the source as the "GARBAGE" sentinel so the
    // COPY (the destination) also reads as GARBAGE and fails the fake's integrity_check branch.
    writeSqliteFile(stateDir, "run-state.sqlite3", "GARBAGE");

    let threw = false;
    try {
      runBackup(stateDir, backupDir, sqliteBin);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    const timestamped = readdirSync(backupDir);
    expect(timestamped).toHaveLength(1);
    expect(existsSync(join(backupDir, timestamped[0]!, "run-state.sqlite3"))).toBe(false);
  });

  it("retains only the newest N backups after a successful run, pruning the rest", () => {
    const stateDir = tmpRoot();
    const backupDir = tmpRoot();
    const sqliteBin = fakeSqlite(tmpRoot());
    writeSqliteFile(stateDir, "run-state.sqlite3", "content");

    for (const ts of ["20260101T000000Z", "20260102T000000Z", "20260103T000000Z"]) {
      mkdirSync(join(backupDir, ts));
      writeFileSync(join(backupDir, ts, "run-state.sqlite3"), "old content");
    }

    runBackup(stateDir, backupDir, sqliteBin, { LOOPOVER_MINER_BACKUP_RETAIN: "2" });

    const remaining = readdirSync(backupDir).sort();
    // The 3 pre-seeded + 1 new run = 4 total; RETAIN=2 keeps only the 2 newest (by mtime, which favors the
    // just-created one plus whichever pre-seeded directory was touched most recently by this filesystem).
    expect(remaining.length).toBe(2);
  });

  it("skips retention pruning after a failed store, so no older good backup is lost to make room for a bad run", () => {
    const stateDir = tmpRoot();
    const backupDir = tmpRoot();
    const sqliteBin = fakeSqlite(tmpRoot());
    mkdirSync(join(backupDir, "20260101T000000Z"));
    writeFileSync(join(backupDir, "20260101T000000Z", "run-state.sqlite3"), "old good content");
    writeSqliteFile(stateDir, "backup-fails.sqlite3");

    expect(() => runBackup(stateDir, backupDir, sqliteBin, { LOOPOVER_MINER_BACKUP_RETAIN: "1" })).toThrow();

    // Both the pre-seeded backup AND the new (failed) run's directory survive -- pruning never ran.
    expect(readdirSync(backupDir).length).toBe(2);
    expect(existsSync(join(backupDir, "20260101T000000Z", "run-state.sqlite3"))).toBe(true);
  });
});

describe("restore-miner.sh", () => {
  it("refuses to restore without --yes, leaving the state dir untouched", () => {
    const stateDir = tmpRoot();
    const backupDir = tmpRoot();
    const sqliteBin = fakeSqlite(tmpRoot());
    mkdirSync(join(backupDir, "20260101T000000Z"));
    writeFileSync(join(backupDir, "20260101T000000Z", "run-state.sqlite3"), "backup content");

    const result = runRestore(stateDir, backupDir, sqliteBin, []);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/refusing to restore without --yes/);
    expect(existsSync(join(stateDir, "run-state.sqlite3"))).toBe(false);
  });

  it("fails cleanly when no backups exist", () => {
    const stateDir = tmpRoot();
    const backupDir = tmpRoot();
    const sqliteBin = fakeSqlite(tmpRoot());

    const result = runRestore(stateDir, backupDir, sqliteBin);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/no backups found/);
  });

  it("restores the newest backup by default when no directory is given", () => {
    const stateDir = tmpRoot();
    const backupDir = tmpRoot();
    const sqliteBin = fakeSqlite(tmpRoot());
    mkdirSync(join(backupDir, "20260101T000000Z"));
    writeFileSync(join(backupDir, "20260101T000000Z", "run-state.sqlite3"), "old backup");
    // "Newest" is determined by mtime (`ls -1dt`); force a real gap so this isn't racy on filesystems with
    // coarse (e.g. 1s) mtime resolution, where two directories created back-to-back could tie.
    execFileSync("sleep", ["1.1"]);
    mkdirSync(join(backupDir, "20260102T000000Z"));
    writeFileSync(join(backupDir, "20260102T000000Z", "run-state.sqlite3"), "newest backup");

    const result = runRestore(stateDir, backupDir, sqliteBin);
    expect(result.status).toBe(0);
    expect(readFileSync(join(stateDir, "run-state.sqlite3"), "utf8")).toBe("newest backup");
  });

  it("restores a specific backup directory when one is given as an argument", () => {
    const stateDir = tmpRoot();
    const backupDir = tmpRoot();
    const sqliteBin = fakeSqlite(tmpRoot());
    const older = join(backupDir, "20260101T000000Z");
    mkdirSync(older);
    writeFileSync(join(older, "run-state.sqlite3"), "the one we want");
    mkdirSync(join(backupDir, "20260102T000000Z"));
    writeFileSync(join(backupDir, "20260102T000000Z", "run-state.sqlite3"), "not this one");

    const result = runRestore(stateDir, backupDir, sqliteBin, ["--yes", older]);
    expect(result.status).toBe(0);
    expect(readFileSync(join(stateDir, "run-state.sqlite3"), "utf8")).toBe("the one we want");
  });

  it("REGRESSION: aborts entirely (no files restored) when any backup file fails integrity_check", () => {
    const stateDir = tmpRoot();
    const backupDir = tmpRoot();
    const sqliteBin = fakeSqlite(tmpRoot());
    const ts = join(backupDir, "20260101T000000Z");
    mkdirSync(ts);
    writeFileSync(join(ts, "run-state.sqlite3"), "good content");
    writeFileSync(join(ts, "claim-ledger.sqlite3"), "GARBAGE");
    // Pre-existing live file that must survive an aborted restore untouched.
    writeSqliteFile(stateDir, "run-state.sqlite3", "live data that must not be overwritten");

    const result = runRestore(stateDir, backupDir, sqliteBin);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/failed integrity check/);
    expect(result.stdout).toMatch(/nothing was restored/);
    expect(readFileSync(join(stateDir, "run-state.sqlite3"), "utf8")).toBe("live data that must not be overwritten");
  });

  it("removes stale -wal/-shm sidecar files from the live dir after restoring, so no pre-restore write can be replayed", () => {
    const stateDir = tmpRoot();
    const backupDir = tmpRoot();
    const sqliteBin = fakeSqlite(tmpRoot());
    const ts = join(backupDir, "20260101T000000Z");
    mkdirSync(ts);
    writeFileSync(join(ts, "run-state.sqlite3"), "restored content");
    writeSqliteFile(stateDir, "run-state.sqlite3", "stale live content");
    writeFileSync(join(stateDir, "run-state.sqlite3-wal"), "stale in-flight write");
    writeFileSync(join(stateDir, "run-state.sqlite3-shm"), "stale shared memory index");

    const result = runRestore(stateDir, backupDir, sqliteBin);
    expect(result.status).toBe(0);
    expect(readFileSync(join(stateDir, "run-state.sqlite3"), "utf8")).toBe("restored content");
    expect(existsSync(join(stateDir, "run-state.sqlite3-wal"))).toBe(false);
    expect(existsSync(join(stateDir, "run-state.sqlite3-shm"))).toBe(false);
  });

  it("fails clearly when the given backup directory doesn't exist", () => {
    const stateDir = tmpRoot();
    const backupDir = tmpRoot();
    const sqliteBin = fakeSqlite(tmpRoot());

    const result = runRestore(stateDir, backupDir, sqliteBin, ["--yes", join(backupDir, "nope")]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/backup directory not found/);
  });
});
