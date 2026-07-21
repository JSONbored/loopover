#!/usr/bin/env node
// Keeps .release-please-manifest.json in sync with each listed package's actual package.json
// version. release-please normally maintains this file itself (manifest mode) as part of merging
// its own generated Release PR -- but the documented human-override path for a stuck/broken release
// tag (publish-mcp.yml's own header comment: "A bare manual dispatch ... self-tags HEAD from
// packages/loopover-mcp/package.json's version") bumps package.json directly and has no way to touch
// release-please's own state file. When that happens the manifest goes stale, and release-please's
// NEXT run -- blind to the fact a version already shipped out-of-band -- recomputes and re-proposes
// that SAME already-published version as a brand-new Release PR, which then fails on publish (npm
// rejects republishing a version). Confirmed live: #7086/#7087 re-proposed mcp/miner v3.1.1 days
// after both had already shipped to npm via #7064's manual release.
//
// package.json is always the source of truth here, never a hand-typed version number: this script
// only ever reads it and writes the manifest to match, so fixing drift is one command, never a
// manual JSON edit (the exact mistake that produced the stale manifest in the first place).
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const MANIFEST_PATH = ".release-please-manifest.json";

export type SyncManifestStaleEntry = {
  workspacePath: string;
  from: string;
  to: string;
};

export type SyncManifestResult = {
  content: string;
  changed: boolean;
  stale: SyncManifestStaleEntry[];
};

/** Pure: diff a manifest's recorded versions against each workspace's real package.json version. */
export function syncManifestVersions(manifestJson: string, packageVersions: Record<string, string>): SyncManifestResult {
  const manifest = JSON.parse(manifestJson);
  const stale: SyncManifestStaleEntry[] = [];
  for (const [workspacePath, version] of Object.entries(packageVersions)) {
    if (!(workspacePath in manifest)) continue; // not a manifest-tracked component -- nothing to sync
    if (manifest[workspacePath] === version) continue;
    stale.push({ workspacePath, from: manifest[workspacePath], to: version });
    manifest[workspacePath] = version;
  }
  const changed = stale.length > 0;
  return { content: changed ? `${JSON.stringify(manifest, null, 2)}\n` : manifestJson, changed, stale };
}

export type SyncManifestIo = {
  readFileSync: (path: string, encoding: string) => string;
  writeFileSync: (path: string, content: string) => void;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: (code: number) => void;
};

export function main(
  argv: string[] = process.argv.slice(2),
  io: SyncManifestIo = {
    readFileSync: (path: string, encoding: string) => readFileSync(path, encoding as BufferEncoding),
    writeFileSync,
    log: console.log.bind(console),
    error: console.error.bind(console),
    exit: (code: number) => process.exit(code),
  },
): number {
  const check = argv.includes("--check");
  const manifestJson = io.readFileSync(MANIFEST_PATH, "utf8");
  const manifestKeys = Object.keys(JSON.parse(manifestJson));
  const packageVersions = Object.fromEntries(
    manifestKeys.map((workspacePath) => [workspacePath, JSON.parse(io.readFileSync(`${workspacePath}/package.json`, "utf8")).version]),
  );

  const result = syncManifestVersions(manifestJson, packageVersions);
  for (const { workspacePath, from, to } of result.stale) {
    io.error(`${MANIFEST_PATH}: ${workspacePath} is ${from}, package.json says ${to}.`);
  }
  if (check) {
    if (result.stale.length > 0) {
      io.error(`${MANIFEST_PATH} is stale; run npm run release-manifest:sync.`);
      io.exit(1);
      return 1;
    }
    io.log(`sync-release-manifest: checked ${manifestKeys.length} package version(s), all in sync.`);
    return 0;
  }
  if (result.changed) io.writeFileSync(MANIFEST_PATH, result.content);
  io.log(`sync-release-manifest: ${result.changed ? `synced ${result.stale.length}` : "checked"} of ${manifestKeys.length} package version(s).`);
  return 0;
}

const invokedDirectly = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
