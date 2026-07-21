// release-please's `extra-files` JSON-path updater doesn't reliably reach package-lock.json's
// per-workspace version fields, whose keys contain slashes (e.g. "packages/loopover-engine")
// nested under a manifest-mode component's own release-please-config.json block -- confirmed
// empirically (mcp-v0.7.0/engine-v0.2.0 dry runs both left package-lock.json un-synced, breaking
// `npm ci` with "Missing: @loopover/engine@0.1.0 from lock file"). This does the same
// single-line replacement a human would make by hand: find the workspace's own manifest-mirror
// entry, replace just its "version" value. No JSON.parse/stringify round-trip on the whole
// multi-thousand-line lockfile, which would risk reordering/reformatting far beyond the one line
// that actually changed.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export type SyncLockfileWorkspace = {
  workspacePath: string;
  version: string;
};

export type SyncLockfileHooks = {
  onFailure?: (workspacePath: string) => void;
  onAlready?: (workspacePath: string, version: string) => void;
  onSynced?: (workspacePath: string, version: string) => void;
};

export type SyncLockfileResult = {
  content: string;
  changed: boolean;
  failures: string[];
};

/**
 * Sync each workspace's lockfile block version. Continues past match failures so one broken
 * workspace doesn't hide others; callers must exit non-zero when `failures` is non-empty (#6296).
 */
export function syncLockfileVersions(content: string, workspaces: SyncLockfileWorkspace[], hooks: SyncLockfileHooks = {}): SyncLockfileResult {
  let next = content;
  let changed = false;
  const failures: string[] = [];

  for (const { workspacePath, version } of workspaces) {
    const escapedKey = workspacePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Anchors on the workspace's own block header + its "name" line (both stable, unique) so this
    // can't accidentally match a different package's "version" line elsewhere in the file.
    const pattern = new RegExp(`("${escapedKey}":\\s*\\{\\s*\\n\\s*"name":[^\\n]*\\n\\s*"version":\\s*")[^"]*(")`);
    if (!pattern.test(next)) {
      failures.push(workspacePath);
      hooks.onFailure?.(workspacePath);
      continue;
    }
    const updated = next.replace(pattern, `$1${version}$2`);
    if (updated === next) {
      hooks.onAlready?.(workspacePath, version);
    } else {
      next = updated;
      changed = true;
      hooks.onSynced?.(workspacePath, version);
    }
  }

  return { content: next, changed, failures };
}

export type SyncLockfileIo = {
  readFileSync: (path: string, encoding: string) => string;
  writeFileSync: (path: string, content: string) => void;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: (code: number) => void;
};

export function main(
  argv: string[] = process.argv.slice(2),
  io: SyncLockfileIo = {
    readFileSync: (path: string, encoding: string) => readFileSync(path, encoding as BufferEncoding),
    writeFileSync,
    log: console.log.bind(console),
    error: console.error.bind(console),
    exit: (code: number) => process.exit(code),
  },
): number {
  const targets = argv;
  if (targets.length === 0) {
    io.error("Usage: tsx sync-release-lockfile-versions.ts <workspace-path> [<workspace-path> ...]");
    io.exit(1);
    return 1;
  }

  const lockPath = "package-lock.json";
  const content = io.readFileSync(lockPath, "utf8");
  const workspaces = targets.map((workspacePath) => ({
    workspacePath,
    version: JSON.parse(io.readFileSync(`${workspacePath}/package.json`, "utf8")).version,
  }));

  const result = syncLockfileVersions(content, workspaces, {
    onFailure: (workspacePath) => {
      io.error(`${workspacePath}: pattern not found in ${lockPath} -- nothing changed.`);
    },
    onAlready: (workspacePath, version) => {
      io.log(`${workspacePath}: already at ${version}.`);
    },
    onSynced: (workspacePath, version) => {
      io.log(`${workspacePath}: synced to ${version}.`);
    },
  });

  if (result.changed) io.writeFileSync(lockPath, result.content);
  if (result.failures.length > 0) {
    io.exit(1);
    return 1;
  }
  return 0;
}

const invokedDirectly = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
