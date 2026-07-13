import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tmpRoots: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "gittensory-backup-metrics-"));
  tmpRoots.push(dir);
  return dir;
}

function writeBackup(root: string, target: "postgres" | "sqlite" | "qdrant", name: string, timestamp: string): number {
  const dir = join(root, target);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, `${target} backup\n`);
  const when = new Date(timestamp);
  utimesSync(file, when, when);
  return Math.floor(when.getTime() / 1000);
}

function runExporterOnce(root: string): string {
  const out = join(root, "metrics");
  execFileSync("sh", ["scripts/backup-metrics.sh"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BACKUP_ROOT: root,
      BACKUP_METRICS_DIR: out,
      BACKUP_METRICS_ONCE: "1",
    },
  });
  return readFileSync(join(out, "metrics"), "utf8");
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("backup-metrics.sh", () => {
  it("exports newest retained backup timestamps and file counts by target", () => {
    const root = tmpRoot();
    writeBackup(root, "postgres", "gittensory-older.dump", "2026-07-01T01:00:00Z");
    const newestPostgres = writeBackup(root, "postgres", "gittensory-newer.dump", "2026-07-01T02:00:00Z");
    const sqlite = writeBackup(root, "sqlite", "gittensory.sqlite.gz", "2026-07-01T03:00:00Z");
    const qdrant = writeBackup(root, "qdrant", "snapshot", "2026-07-01T04:00:00Z");

    const metrics = runExporterOnce(root);

    expect(metrics).toContain(`loopover_backup_latest_timestamp_seconds{target="postgres"} ${newestPostgres}`);
    expect(metrics).toContain(`loopover_backup_latest_timestamp_seconds{target="sqlite"} ${sqlite}`);
    expect(metrics).toContain(`loopover_backup_latest_timestamp_seconds{target="qdrant"} ${qdrant}`);
    expect(metrics).toContain('loopover_backup_files{target="postgres"} 2');
    expect(metrics).toContain('loopover_backup_files{target="sqlite"} 1');
    expect(metrics).toContain('loopover_backup_files{target="qdrant"} 1');
  });

  it("exports zeroes for missing backup directories instead of failing the scrape", () => {
    const root = tmpRoot();

    const metrics = runExporterOnce(root);

    expect(metrics).toContain('loopover_backup_latest_timestamp_seconds{target="postgres"} 0');
    expect(metrics).toContain('loopover_backup_latest_timestamp_seconds{target="sqlite"} 0');
    expect(metrics).toContain('loopover_backup_latest_timestamp_seconds{target="qdrant"} 0');
    expect(metrics).toContain('loopover_backup_files{target="postgres"} 0');
    expect(metrics).toContain('loopover_backup_files{target="sqlite"} 0');
    expect(metrics).toContain('loopover_backup_files{target="qdrant"} 0');
  });
});
