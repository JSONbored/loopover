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
original_args="$*"
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
if [ -n "\${PG_DUMP_ARGS_FILE:-}" ]; then
  printf '%s\\n' "$original_args" > "$PG_DUMP_ARGS_FILE"
fi
if [ -n "\${PG_DUMP_ENV_FILE:-}" ]; then
  passfile_path="\${PGPASSFILE:-}"
  passfile_content=""
  passfile_mode_ok="no"
  if [ -n "$passfile_path" ] && [ -f "$passfile_path" ]; then
    passfile_content="$(cat "$passfile_path")"
    # find -perm is portable across BSD (macOS) and GNU (Linux) find, unlike \`stat\`'s incompatible flags.
    case "$(find "$passfile_path" -perm 600 2>/dev/null)" in
      "$passfile_path") passfile_mode_ok="yes" ;;
    esac
  fi
  printf '%s|%s|%s\\n' "$passfile_path" "$passfile_content" "$passfile_mode_ok" > "$PG_DUMP_ENV_FILE"
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
# backup.sh now verifies the online backup via PRAGMA integrity_check; answer ok so the
# healthy-path assertions still exercise the success branch (#2084).
case "$cmd" in *integrity_check*) echo ok; exit 0 ;; esac
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
      PG_DUMP_ARGS_FILE: join(root, "pg-dump.args"),
      PG_DUMP_ENV_FILE: join(root, "pg-dump.env"),
      DATABASE_PATH: staleSqlite,
      PATH: `${pgBin}:${process.env.PATH ?? ""}`,
    });

    const postgresBackups = readdirSync(join(root, "backups", "postgres"));
    expect(output).toContain("[backup] postgres ->");
    expect(postgresBackups).toHaveLength(1);
    expect(postgresBackups[0]).toMatch(/^loopover-\d{8}T\d{6}Z\.dump$/);
    expect(readdirSync(join(root, "backups", "sqlite"))).toEqual([]);
  });

  it("does not pass the Postgres password in pg_dump arguments, but keeps host/port/dbname/user reachable via a sanitized URL", () => {
    const root = tmpRoot();
    const pgBin = fakePgDump(root);
    const argsFile = join(root, "pg-dump.args");
    const envFile = join(root, "pg-dump.env");

    runBackup(root, {
      DATABASE_URL: "postgresql://app_user:SuperSecret123%21@db.example:6543/gittensory",
      PATH: `${pgBin}:${process.env.PATH ?? ""}`,
      PG_DUMP_ARGS_FILE: argsFile,
      PG_DUMP_ENV_FILE: envFile,
    });

    const args = execFileSync("cat", [argsFile], { encoding: "utf8" });
    const pgEnv = execFileSync("cat", [envFile], { encoding: "utf8" }).trim();
    const [passfilePath, passfileContent, passfileModeOk] = pgEnv.split("|");

    // The password (percent-encoded or decoded) must never appear on argv.
    expect(args).not.toContain("SuperSecret123");
    expect(args).not.toContain("app_user:");
    // Host/port/dbname/user are pg_dump's connection info, not secrets -- libpq resolves them from this
    // sanitized (password-free) URL exactly as it would have from the original.
    expect(args).toContain("postgresql://app_user@db.example:6543/gittensory");
    // The password reaches pg_dump out-of-band via a 600-permission PGPASSFILE, url-decoded. Match on the
    // basename only, not a hardcoded /tmp/ prefix: mktemp resolves under $TMPDIR, which macOS sets to a
    // per-user private directory rather than /tmp (the CI runner's Linux environment does default to /tmp,
    // but the assertion shouldn't assume that).
    expect(passfilePath).toMatch(/\/loopover-pgpass\.[^/]+$/);
    expect(passfileContent).toBe("*:*:*:*:SuperSecret123!");
    expect(passfileModeOk).toBe("yes");
  });

  it("preserves query-string-only connection info that a host/port/dbname split would otherwise drop", () => {
    const root = tmpRoot();
    const pgBin = fakePgDump(root);
    const argsFile = join(root, "pg-dump.args");

    // No authority host at all -- the actual connection target is supplied entirely via the query string
    // (a valid, real-world libpq URI form for connecting over a Unix socket at a non-default path).
    runBackup(root, {
      DATABASE_URL: "postgresql:///gittensory?host=/var/run/postgresql",
      PATH: `${pgBin}:${process.env.PATH ?? ""}`,
      PG_DUMP_ARGS_FILE: argsFile,
    });

    const args = execFileSync("cat", [argsFile], { encoding: "utf8" });
    expect(args).toContain("postgresql:///gittensory?host=/var/run/postgresql");
  });

  it("strips a password supplied via the libpq query-string form, not just userinfo", () => {
    const root = tmpRoot();
    const pgBin = fakePgDump(root);
    const argsFile = join(root, "pg-dump.args");
    const envFile = join(root, "pg-dump.env");

    // postgresql://user@host/db?password=... is an equally valid, if less common, way to supply a libpq
    // password -- entirely independent of the userinfo form this function already strips. Includes other
    // query parameters on both sides of `password` to prove they survive, in order, untouched.
    runBackup(root, {
      DATABASE_URL: "postgresql://app_user@db.example:6543/gittensory?sslmode=require&password=SuperSecret123%21&application_name=app",
      PATH: `${pgBin}:${process.env.PATH ?? ""}`,
      PG_DUMP_ARGS_FILE: argsFile,
      PG_DUMP_ENV_FILE: envFile,
    });

    const args = execFileSync("cat", [argsFile], { encoding: "utf8" });
    const [, passfileContent] = execFileSync("cat", [envFile], { encoding: "utf8" }).trim().split("|");
    expect(args).not.toContain("SuperSecret123");
    expect(args).not.toContain("password=");
    expect(args).toContain("postgresql://app_user@db.example:6543/gittensory?sslmode=require&application_name=app");
    expect(passfileContent).toBe("*:*:*:*:SuperSecret123!");
  });

  it("strips EVERY occurrence of a repeated query-string password, not just the first", () => {
    const root = tmpRoot();
    const pgBin = fakePgDump(root);
    const argsFile = join(root, "pg-dump.args");

    // A malformed URL repeating `password=` isn't rejected by libpq's own parser -- stripping only the
    // first occurrence would leave a second one sitting in argv, still a leaked credential regardless of
    // which one libpq itself would actually authenticate with.
    runBackup(root, {
      DATABASE_URL: "postgresql://u@h/db?password=oneSecret&sslmode=require&password=twoSecret",
      PATH: `${pgBin}:${process.env.PATH ?? ""}`,
      PG_DUMP_ARGS_FILE: argsFile,
    });

    const args = execFileSync("cat", [argsFile], { encoding: "utf8" });
    expect(args).not.toContain("oneSecret");
    expect(args).not.toContain("twoSecret");
    expect(args).not.toContain("password=");
    expect(args).toContain("postgresql://u@h/db?sslmode=require");
  });

  it("strips a query-string password even when its KEY NAME is percent-encoded", () => {
    const root = tmpRoot();
    const pgBin = fakePgDump(root);
    const argsFile = join(root, "pg-dump.args");
    const envFile = join(root, "pg-dump.env");

    // libpq percent-decodes query KEY NAMES before matching them against connection keywords, so
    // pass%77ord (%77 = 'w') is just as much `password` as the literal spelling -- a literal string match
    // against "password=" would miss it entirely, leaving a real credential in argv.
    runBackup(root, {
      DATABASE_URL: "postgresql://u@h/db?sslmode=require&pass%77ord=SuperSecret123%21&application_name=app",
      PATH: `${pgBin}:${process.env.PATH ?? ""}`,
      PG_DUMP_ARGS_FILE: argsFile,
      PG_DUMP_ENV_FILE: envFile,
    });

    const args = execFileSync("cat", [argsFile], { encoding: "utf8" });
    const [, passfileContent] = execFileSync("cat", [envFile], { encoding: "utf8" }).trim().split("|");
    expect(args).not.toContain("SuperSecret123");
    expect(args).not.toContain("pass%77ord");
    expect(args).not.toContain("password=");
    expect(args).toContain("postgresql://u@h/db?sslmode=require&application_name=app");
    expect(passfileContent).toBe("*:*:*:*:SuperSecret123!");
  });

  it("does not mistake a query value merely containing the substring 'password' for the password key", () => {
    const root = tmpRoot();
    const pgBin = fakePgDump(root);
    const argsFile = join(root, "pg-dump.args");

    const url = "postgresql://host/db?application_name=has_password_in_name&other=1";
    runBackup(root, {
      DATABASE_URL: url,
      PATH: `${pgBin}:${process.env.PATH ?? ""}`,
      PG_DUMP_ARGS_FILE: argsFile,
    });

    const args = execFileSync("cat", [argsFile], { encoding: "utf8" });
    expect(args).toContain(url);
  });

  it("does not mistake a literal '@'/':' inside the query string for userinfo", () => {
    const root = tmpRoot();
    const pgBin = fakePgDump(root);
    const argsFile = join(root, "pg-dump.args");
    const envFile = join(root, "pg-dump.env");

    // No userinfo here at all -- the '@' and ':' both belong to a query parameter VALUE. Userinfo can
    // only appear in the authority (before the first '/', '?', or '#'); scanning the whole remaining
    // string for the first '@' would wrongly treat "gittensory?application_name=a:b" as userinfo and
    // strip ":b" out as a fake password, corrupting the URL passed to pg_dump.
    const url = "postgresql://db.example/gittensory?application_name=a:b@worker";
    runBackup(root, {
      DATABASE_URL: url,
      PATH: `${pgBin}:${process.env.PATH ?? ""}`,
      PG_DUMP_ARGS_FILE: argsFile,
      PG_DUMP_ENV_FILE: envFile,
    });

    const args = execFileSync("cat", [argsFile], { encoding: "utf8" });
    const [passfilePath] = execFileSync("cat", [envFile], { encoding: "utf8" }).trim().split("|");
    expect(args).toContain(url);
    expect(passfilePath).toBe("");
  });

  it("extracts a real password even when the query string separately contains '@'/':'", () => {
    const root = tmpRoot();
    const pgBin = fakePgDump(root);
    const argsFile = join(root, "pg-dump.args");
    const envFile = join(root, "pg-dump.env");

    runBackup(root, {
      DATABASE_URL: "postgres://user:realpass@host/db?application_name=a:b@worker",
      PATH: `${pgBin}:${process.env.PATH ?? ""}`,
      PG_DUMP_ARGS_FILE: argsFile,
      PG_DUMP_ENV_FILE: envFile,
    });

    const args = execFileSync("cat", [argsFile], { encoding: "utf8" });
    const [, passfileContent] = execFileSync("cat", [envFile], { encoding: "utf8" }).trim().split("|");
    expect(args).not.toContain("realpass");
    expect(args).toContain("postgresql://user@host/db?application_name=a:b@worker");
    expect(passfileContent).toBe("*:*:*:*:realpass");
  });

  it("keeps a literal '+' in the password as '+', not a decoded space", () => {
    const root = tmpRoot();
    const pgBin = fakePgDump(root);
    const envFile = join(root, "pg-dump.env");

    // '+' means "space" only in application/x-www-form-urlencoded query values, not in a URI's userinfo
    // component, where it's an ordinary allowed character -- decoding it as a space would corrupt any
    // password containing one.
    runBackup(root, {
      DATABASE_URL: "postgres://user:pass+word@host/db",
      PATH: `${pgBin}:${process.env.PATH ?? ""}`,
      PG_DUMP_ENV_FILE: envFile,
    });

    const [, passfileContent] = execFileSync("cat", [envFile], { encoding: "utf8" }).trim().split("|");
    expect(passfileContent).toBe("*:*:*:*:pass+word");
  });

  it("refuses to write a PGPASSFILE when the decoded password contains a newline", () => {
    const root = tmpRoot();
    const pgBin = fakePgDump(root);

    // pgpass_escape only escapes ':' and '\' -- a raw newline (here percent-encoded as %0A) would still
    // split the entry across lines and corrupt the single-line pgpass format, so this must fail loudly
    // rather than silently write a malformed passfile.
    expect(() =>
      runBackup(root, {
        DATABASE_URL: "postgres://user:bad%0Apassword@host/db",
        PATH: `${pgBin}:${process.env.PATH ?? ""}`,
      }),
    ).toThrow(/backup\.sh/);
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
    expect(sqliteBackups[0]).toMatch(/^loopover-\d{8}T\d{6}Z\.sqlite\.gz$/);
    expect(existsSync(join(root, "backups", "postgres"))).toBe(true);
    expect(readdirSync(join(root, "backups", "postgres"))).toEqual([]);
  });
});
