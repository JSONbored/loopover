import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const scriptPath = resolve("scripts/backup.sh");

// A stub `sqlite3` placed first on PATH so the test is hermetic (no real sqlite3 needed)
// and can deterministically drive both the healthy and the corrupt-online-backup paths:
//   STUB_SQLITE_MODE=ok      -> `.backup` writes non-empty bytes, integrity_check -> "ok"
//   STUB_SQLITE_MODE=corrupt -> `.backup` still exits 0 (the silent failure #2084 is about)
//                               but writes junk and integrity_check -> "malformed"
const STUB_SQLITE = `#!/bin/sh
cmd="$2"
case "$cmd" in
  .backup*)
    out=$(printf '%s' "$cmd" | sed -e "s/^.backup //" -e "s/'//g")
    if [ "\${STUB_SQLITE_MODE:-ok}" = corrupt ]; then
      printf %s "not-a-sqlite-db" > "$out"
    else
      printf %s "stub-sqlite-backup-bytes" > "$out"
    fi
    ;;
  *integrity_check*)
    if [ "\${STUB_SQLITE_MODE:-ok}" = corrupt ]; then echo malformed; else echo ok; fi
    ;;
esac
exit 0
`;

function createHarness() {
  const dir = mkdtempSync(join(tmpdir(), "gittensory-backup-"));
  const binDir = join(dir, "bin");
  const outDir = join(dir, "backups");
  const dbPath = join(dir, "gittensory.sqlite");
  mkdirSync(binDir);
  writeFileSync(dbPath, "dummy-db"); // must exist so `[ -f "$DB" ]` is true
  const stub = join(binDir, "sqlite3");
  writeFileSync(stub, STUB_SQLITE);
  chmodSync(stub, 0o755);
  return { dir, binDir, outDir, dbPath };
}

function runBackup(h: ReturnType<typeof createHarness>, mode: "ok" | "corrupt") {
  // Absolute /bin/sh so the command itself never depends on PATH; the script's own
  // sqlite3/gzip/date lookups use the PATH we inject (stub bin first, real tools after).
  return spawnSync("/bin/sh", [scriptPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${h.binDir}:${process.env.PATH ?? ""}`,
      BACKUP_OUT_DIR: h.outDir,
      DATABASE_PATH: h.dbPath,
      BACKUP_RETAIN: "1",
      STUB_SQLITE_MODE: mode,
      // Force the SQLite branch + skip Qdrant regardless of the ambient test env.
      DATABASE_URL: "",
      GITTENSORY_BACKUP_SOURCE_DATABASE_URL: "",
      QDRANT_URL: "",
    },
  });
}

describe("scripts/backup.sh sqlite online-backup verification (#2084)", () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
  });

  afterEach(() => {
    rmSync(harness.dir, { recursive: true, force: true });
  });

  it("gzips the backup and exits 0 when the online backup verifies", () => {
    const res = runBackup(harness, "ok");

    expect(res.status).toBe(0);
    expect(res.stdout).toContain("[backup] sqlite ->");
    const files = readdirSync(join(harness.outDir, "sqlite"));
    expect(files.filter((f) => f.endsWith(".sqlite.gz")).length).toBe(1);
    // no uncompressed leftover
    expect(files.filter((f) => f.endsWith(".sqlite")).length).toBe(0);
  });

  it("fails loudly, removes the bad file, and skips retention when the backup is corrupt", () => {
    // Seed more good backups than BACKUP_RETAIN (=1): if retention were NOT skipped on a
    // failed backup it would prune these down to 1, so preserving BOTH proves the skip.
    const sqliteDir = join(harness.outDir, "sqlite");
    mkdirSync(sqliteDir, { recursive: true });
    writeFileSync(join(sqliteDir, "gittensory-OLD1.sqlite.gz"), "old-good-1");
    writeFileSync(join(sqliteDir, "gittensory-OLD2.sqlite.gz"), "old-good-2");

    const res = runBackup(harness, "corrupt");

    // fail loudly: non-zero exit + the error line + the FAILED banner
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("failed verification");
    expect(res.stderr).toContain("did not verify");
    // retention-skip is logged and the previously-good backups both survive
    expect(res.stdout).toContain("skipping sqlite retention");
    const files = readdirSync(sqliteDir);
    expect(files).toContain("gittensory-OLD1.sqlite.gz");
    expect(files).toContain("gittensory-OLD2.sqlite.gz");
    // the corrupt/partial uncompressed file was removed, and no new gz was produced
    expect(files.filter((f) => f.endsWith(".sqlite")).length).toBe(0);
    expect(files.filter((f) => f.endsWith(".sqlite.gz")).sort()).toEqual([
      "gittensory-OLD1.sqlite.gz",
      "gittensory-OLD2.sqlite.gz",
    ]);
  });
});
