import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tmpRoots: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "gittensory-backup-"));
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

function fakePgDump(root: string): string {
  const bin = join(root, "pg-bin");
  mkdirSync(bin);
  writeExecutable(
    join(bin, "pg_dump"),
    `#!/bin/sh
out=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -f)
      out="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
if [ -z "$out" ]; then
  echo 'missing -f output' >&2
  exit 2
fi
printf 'postgres dump\\n' > "$out"
`,
  );
  return bin;
}

function fakeSqlite(root: string): string {
  const bin = join(root, "sqlite-bin");
  mkdirSync(bin);
  writeExecutable(
    join(bin, "sqlite3"),
    `#!/bin/sh
cmd="$2"
out="$(printf '%s\\n' "$cmd" | sed "s/^\\\\.backup '\\\\(.*\\\\)'$/\\\\1/")"
if [ "$out" = "$cmd" ]; then
  echo "unexpected sqlite command: $cmd" >&2
  exit 2
fi
printf 'sqlite backup\\n' > "$out"
`,
  );
  return bin;
}

function runBackup(root: string, env: Record<string, string>): string {
  return execFileSync("sh", ["scripts/backup.sh"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      BACKUP_OUT_DIR: join(root, "backups"),
      BACKUP_RETAIN: "7",
      GITTENSORY_BACKUP_SOURCE_DATABASE_URL: "",
      QDRANT_URL: "",
      ...env,
    },
  });
}

describe("self-host backup script", () => {
  it("backs up Postgres when DATABASE_URL is set instead of copying stale SQLite", () => {
    const root = tmpRoot();
    const pgBin = fakePgDump(root);
    const staleSqlite = join(root, "stale.sqlite");
    writeFileSync(staleSqlite, "stale sqlite");

    const output = runBackup(root, {
      DATABASE_URL: "postgres://gittensory:pw@postgres:5432/gittensory",
      DATABASE_PATH: staleSqlite,
      PATH: `${pgBin}:${process.env.PATH ?? ""}`,
    });

    const postgresBackups = readdirSync(join(root, "backups", "postgres"));
    expect(output).toContain("[backup] postgres ->");
    expect(postgresBackups).toHaveLength(1);
    expect(postgresBackups[0]).toMatch(/^gittensory-\d{8}T\d{6}Z\.dump$/);
    expect(readdirSync(join(root, "backups", "sqlite"))).toEqual([]);
  });

  it("keeps the SQLite online backup path when no Postgres URL is configured", () => {
    const root = tmpRoot();
    const sqliteBin = fakeSqlite(root);
    const appDb = join(root, "gittensory.sqlite");
    writeFileSync(appDb, "sqlite db");

    const output = runBackup(root, {
      DATABASE_PATH: appDb,
      DATABASE_URL: "",
      PATH: `${sqliteBin}:${process.env.PATH ?? ""}`,
    });

    const sqliteBackups = readdirSync(join(root, "backups", "sqlite"));
    expect(output).toContain("[backup] sqlite ->");
    expect(sqliteBackups).toHaveLength(1);
    expect(sqliteBackups[0]).toMatch(/^gittensory-\d{8}T\d{6}Z\.sqlite\.gz$/);
    expect(existsSync(join(root, "backups", "postgres"))).toBe(true);
    expect(readdirSync(join(root, "backups", "postgres"))).toEqual([]);
  });
});
