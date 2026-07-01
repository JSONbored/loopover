import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

const tmpRoots: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "gittensory-verify-"));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { force: true, recursive: true });
});

// A well-formed dump contains GOODDUMP; anything else makes the fake pg_restore fail as if the archive were
// truncated. `--list` prints a header (`;`-prefixed) plus two TOC entry lines; a restore just exits 0.
const PG_RESTORE = `#!/bin/sh
mode=list
dump=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --list) mode=list; shift ;;
    --dbname) mode=restore; shift 2 ;;
    --clean|--if-exists|--no-owner|--no-privileges) shift ;;
    -*) shift ;;
    *) dump="$1"; shift ;;
  esac
done
if ! grep -q GOODDUMP "$dump" 2>/dev/null; then
  echo "pg_restore: error: could not read from input file: end of file" >&2
  exit 1
fi
if [ "$mode" = list ]; then
  printf ';\\n; Archive created\\n;\\n215; 1259 16385 TABLE public pull_requests owner\\n216; 1259 16400 TABLE public advisories owner\\n'
fi
exit 0
`;
const SQLITE3 = `#!/bin/sh
echo "\${FAKE_SQLITE_INTEGRITY:-ok}"
`;

// Builds a fake `psql` that distinguishes the scratch-restore guard's identity query (`current_database()`)
// from the post-restore table-count sanity query, and returns a caller-mapped identity per connection URL —
// lets tests simulate two DIFFERENTLY-SPELLED URLs resolving to the SAME actual database (or genuinely
// different ones), which is exactly the distinction the real db_identity() guard has to get right. A URL with
// no entry in `identities` makes the identity query fail (exit 1), modeling "could not connect/fingerprint".
function fakePsql(identities: Record<string, string>, tableCount = "3"): string {
  const cases = Object.entries(identities)
    .map(([url, identity]) => `    "${url}") printf '%s\\n' "${identity}" ;;`)
    .join("\n");
  return `#!/bin/sh
url="$1"
shift
sql=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -c) sql="$2"; shift 2 ;;
    *) shift ;;
  esac
done
case "$sql" in
  *current_database*)
    case "$url" in
${cases}
      *) exit 1 ;;
    esac
    ;;
  *)
    printf '%s\\n' "${tableCount}"
    ;;
esac
`;
}

function fakeBin(root: string, bins: Record<string, string>): string {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  for (const [name, body] of Object.entries(bins)) {
    const path = join(bin, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  }
  return bin;
}

function writePgDump(root: string, name: string, valid = true): string {
  const dir = join(root, "backups", "postgres");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, valid ? "PGDMP GOODDUMP payload" : "truncated garbage");
  return path;
}

function writeSqliteGz(root: string, name: string, body = "fake sqlite db", gzip = true): string {
  const dir = join(root, "backups", "sqlite");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, gzip ? gzipSync(Buffer.from(body)) : Buffer.from(body));
  return path;
}

function runVerify(
  root: string,
  args: string[],
  env: Record<string, string>,
  bins: Record<string, string>,
): { status: number; out: string } {
  const bin = fakeBin(root, bins);
  try {
    const stdout = execFileSync("sh", ["scripts/verify-backup.sh", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        BACKUP_OUT_DIR: join(root, "backups"),
        GITTENSORY_BACKUP_SOURCE_DATABASE_URL: "",
        DATABASE_URL: "",
        VERIFY_RESTORE_SCRATCH: "",
        GITTENSORY_VERIFY_SCRATCH_DATABASE_URL: "",
        ...env,
      },
    });
    return { status: 0, out: stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("self-host verify-backup script", () => {
  it("validates the newest Postgres dump with pg_restore --list", () => {
    const root = tmpRoot();
    writePgDump(root, "gittensory-20240101T000000Z.dump", true);

    const r = runVerify(root, [], { GITTENSORY_BACKUP_SOURCE_DATABASE_URL: "postgres://u:p@h/db" }, { pg_restore: PG_RESTORE });

    expect(r.status).toBe(0);
    expect(r.out).toContain("postgres archive OK");
    expect(r.out).toContain("2 TOC entries");
    expect(r.out).toContain("[verify] complete");
  });

  it("fails when the Postgres dump is unreadable", () => {
    const root = tmpRoot();
    writePgDump(root, "gittensory-bad.dump", false);

    const r = runVerify(root, [], { GITTENSORY_BACKUP_SOURCE_DATABASE_URL: "postgres://u:p@h/db" }, { pg_restore: PG_RESTORE });

    expect(r.status).toBe(1);
    expect(r.out).toContain("pg_restore --list failed");
  });

  it("fails when no Postgres dump is present", () => {
    const root = tmpRoot();
    mkdirSync(join(root, "backups", "postgres"), { recursive: true });

    const r = runVerify(root, [], { GITTENSORY_BACKUP_SOURCE_DATABASE_URL: "postgres://u:p@h/db" }, { pg_restore: PG_RESTORE });

    expect(r.status).toBe(1);
    expect(r.out).toContain("no Postgres .dump found");
  });

  it("refuses the opt-in scratch restore when no scratch URL is configured", () => {
    const root = tmpRoot();
    writePgDump(root, "gittensory-a.dump", true);

    const r = runVerify(
      root,
      [],
      { GITTENSORY_BACKUP_SOURCE_DATABASE_URL: "postgres://u:p@h/live", VERIFY_RESTORE_SCRATCH: "1" },
      { pg_restore: PG_RESTORE, psql: fakePsql({}) },
    );

    expect(r.status).toBe(1);
    expect(r.out).toContain("needs GITTENSORY_VERIFY_SCRATCH_DATABASE_URL");
  });

  it("refuses the scratch restore when the scratch URL is byte-for-byte the live database", () => {
    const root = tmpRoot();
    writePgDump(root, "gittensory-a.dump", true);
    const live = "postgres://u:p@h/live";

    const r = runVerify(
      root,
      [],
      {
        GITTENSORY_BACKUP_SOURCE_DATABASE_URL: live,
        VERIFY_RESTORE_SCRATCH: "1",
        GITTENSORY_VERIFY_SCRATCH_DATABASE_URL: live,
      },
      { pg_restore: PG_RESTORE, psql: fakePsql({ [live]: "same-cluster@10.0.0.5:5432/live" }) },
    );

    expect(r.status).toBe(1);
    expect(r.out).toContain("SAME database as the live backup source");
  });

  it("refuses the scratch restore when a DIFFERENTLY-SPELLED URL resolves to the SAME database (regression: naive string compare bypass)", () => {
    const root = tmpRoot();
    writePgDump(root, "gittensory-a.dump", true);
    // Same database, deliberately spelled differently: scheme (postgres vs postgresql) AND an explicit vs
    // default port — a `[ "$scratch" = "$PG_DB" ]` string compare would wrongly treat these as distinct.
    const live = "postgres://gittensory:pw@postgres/gittensory";
    const scratch = "postgresql://gittensory:pw@postgres:5432/gittensory";
    expect(scratch).not.toBe(live);

    const r = runVerify(
      root,
      [],
      {
        GITTENSORY_BACKUP_SOURCE_DATABASE_URL: live,
        VERIFY_RESTORE_SCRATCH: "1",
        GITTENSORY_VERIFY_SCRATCH_DATABASE_URL: scratch,
      },
      {
        pg_restore: PG_RESTORE,
        // Both URLs resolve to the identical real connection identity, exactly as they would in production
        // if they point at the same Postgres server/database despite the different spelling.
        psql: fakePsql({
          [live]: "gittensory@10.0.0.5:5432",
          [scratch]: "gittensory@10.0.0.5:5432",
        }),
      },
    );

    expect(r.status).toBe(1);
    expect(r.out).toContain("SAME database as the live backup source");
  });

  it("refuses (fails closed) when the scratch database's identity cannot be determined", () => {
    const root = tmpRoot();
    writePgDump(root, "gittensory-a.dump", true);

    const r = runVerify(
      root,
      [],
      {
        GITTENSORY_BACKUP_SOURCE_DATABASE_URL: "postgres://u:p@h/live",
        VERIFY_RESTORE_SCRATCH: "1",
        GITTENSORY_VERIFY_SCRATCH_DATABASE_URL: "postgres://u:p@h/scratch",
      },
      // No identity entries at all: the scratch identity query fails, so the guard must abort rather than
      // silently assume the databases differ.
      { pg_restore: PG_RESTORE, psql: fakePsql({}) },
    );

    expect(r.status).toBe(1);
    expect(r.out).toContain("could not connect to the scratch database");
  });

  it("refuses (fails closed) when the live database's identity cannot be determined", () => {
    const root = tmpRoot();
    writePgDump(root, "gittensory-a.dump", true);
    const scratch = "postgres://u:p@h/scratch";

    const r = runVerify(
      root,
      [],
      {
        GITTENSORY_BACKUP_SOURCE_DATABASE_URL: "postgres://u:p@h/live",
        VERIFY_RESTORE_SCRATCH: "1",
        GITTENSORY_VERIFY_SCRATCH_DATABASE_URL: scratch,
      },
      // Scratch resolves fine, but the live URL has no mapping — its identity query fails.
      { pg_restore: PG_RESTORE, psql: fakePsql({ [scratch]: "gittensory@10.0.0.9:5432/scratch" }) },
    );

    expect(r.status).toBe(1);
    expect(r.out).toContain("could not connect to the live backup source");
  });

  it("runs the guarded scratch restore into a throwaway database and sanity-checks it", () => {
    const root = tmpRoot();
    writePgDump(root, "gittensory-a.dump", true);
    const live = "postgres://u:p@h/live";
    const scratch = "postgres://u:p@h/scratch";

    const r = runVerify(
      root,
      [],
      {
        GITTENSORY_BACKUP_SOURCE_DATABASE_URL: live,
        VERIFY_RESTORE_SCRATCH: "1",
        GITTENSORY_VERIFY_SCRATCH_DATABASE_URL: scratch,
      },
      {
        pg_restore: PG_RESTORE,
        psql: fakePsql({ [live]: "gittensory@10.0.0.5:5432/live", [scratch]: "gittensory@10.0.0.5:5432/scratch" }, "42"),
      },
    );

    expect(r.status).toBe(0);
    expect(r.out).toContain("scratch restore OK: 42 tables");
  });

  it("verifies an explicit dump path argument", () => {
    const root = tmpRoot();
    const target = writePgDump(root, "chosen.dump", true);

    const r = runVerify(root, [target], {}, { pg_restore: PG_RESTORE });

    expect(r.status).toBe(0);
    expect(r.out).toContain("postgres archive OK");
  });

  it("validates the newest SQLite backup with an integrity check", () => {
    const root = tmpRoot();
    writeSqliteGz(root, "gittensory-20240101T000000Z.sqlite.gz");

    const r = runVerify(root, [], {}, { sqlite3: SQLITE3 });

    expect(r.status).toBe(0);
    expect(r.out).toContain("sqlite backup OK");
  });

  it("fails when the SQLite backup fails its integrity check", () => {
    const root = tmpRoot();
    writeSqliteGz(root, "gittensory-a.sqlite.gz");

    const r = runVerify(root, [], { FAKE_SQLITE_INTEGRITY: "malformed database disk image" }, { sqlite3: SQLITE3 });

    expect(r.status).toBe(1);
    expect(r.out).toContain("sqlite integrity_check failed");
  });

  it("fails when the SQLite backup is not valid gzip", () => {
    const root = tmpRoot();
    writeSqliteGz(root, "gittensory-a.sqlite.gz", "not gzip at all", false);

    const r = runVerify(root, [], {}, { sqlite3: SQLITE3 });

    expect(r.status).toBe(1);
    expect(r.out).toContain("gzip integrity check failed");
  });
});
