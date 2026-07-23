// Workers-safe registry for the admin config-read/write/list-backups capability (#7721), mirroring
// src/signals/focus-manifest-loader.ts's setLocalManifestReader pattern exactly: this module holds
// nullable function slots and never imports node:fs itself, so it's safe in the Cloudflare Workers
// bundle. Only the self-host Node entry (server.ts) fills the slots, with real fs-backed closures
// built from src/selfhost/private-config.ts's write helpers -- that module's own fs import never
// reaches the Workers bundle because nothing there imports it directly, only through this registry.
// Unset (cloud, or self-host without LOOPOVER_REPO_CONFIG_DIR) means every function here stays null,
// and src/mcp/server.ts's admin tools -- gated separately on LOOPOVER_MCP_ADMIN_ENABLED -- report a
// clear "not configured" result rather than throwing.
import type {
  ConfigAdminScope,
  ConfigBackupEntry,
  ConfigWriteResult,
} from "../selfhost/private-config";

// None of these take a `dir` parameter -- LOOPOVER_REPO_CONFIG_DIR is a fixed, boot-time constant for a
// given deployment (there is exactly one self-hosted config dir per running instance), so server.ts
// closes over it once when building these functions, the same way makeLocalManifestReader(dir) already
// returns an already-closurized RepoFocusManifestFetcher rather than taking dir per call.
export type ConfigAdminReader = () => Promise<{ path: string; content: string } | null>;
export type ConfigAdminWriter = (content: string) => Promise<ConfigWriteResult>;
export type ConfigAdminRepoWriter = (repoFullName: string, content: string) => Promise<ConfigWriteResult>;
export type ConfigAdminRepoReader = (repoFullName: string) => Promise<{ path: string; content: string } | null>;
export type ConfigAdminBackupLister = (scope: ConfigAdminScope) => Promise<ConfigBackupEntry[]>;

let readGlobal: ConfigAdminReader | null = null;
let readRepo: ConfigAdminRepoReader | null = null;
let writeGlobal: ConfigAdminWriter | null = null;
let writeRepo: ConfigAdminRepoWriter | null = null;
let listBackups: ConfigAdminBackupLister | null = null;

export function setConfigAdminFunctions(functions: {
  readGlobal: ConfigAdminReader;
  readRepo: ConfigAdminRepoReader;
  writeGlobal: ConfigAdminWriter;
  writeRepo: ConfigAdminRepoWriter;
  listBackups: ConfigAdminBackupLister;
} | null): void {
  readGlobal = functions?.readGlobal ?? null;
  readRepo = functions?.readRepo ?? null;
  writeGlobal = functions?.writeGlobal ?? null;
  writeRepo = functions?.writeRepo ?? null;
  listBackups = functions?.listBackups ?? null;
}

export function getConfigAdminFunctions(): {
  readGlobal: ConfigAdminReader;
  readRepo: ConfigAdminRepoReader;
  writeGlobal: ConfigAdminWriter;
  writeRepo: ConfigAdminRepoWriter;
  listBackups: ConfigAdminBackupLister;
} | null {
  if (!readGlobal || !readRepo || !writeGlobal || !writeRepo || !listBackups) return null;
  return { readGlobal, readRepo, writeGlobal, writeRepo, listBackups };
}
