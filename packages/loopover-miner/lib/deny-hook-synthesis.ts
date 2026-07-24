// Synthesize PreToolUse deny-hook rule proposals from per-repo blocker/path history (#4522). The pure synthesis
// logic moved into `@loopover/engine` (packages/loopover-engine/src/miner/deny-hook-synthesis.ts) by #5667;
// this module is now a thin wrapper that re-exports those pure helpers and keeps the local SQLite store for
// refresh + maintainer review before any synthesized rule takes effect. Approved rules merge with
// {@link DEFAULT_DENY_RULES}; unapproved proposals never block tool calls. No behavior change.
import type { DatabaseSync } from "node:sqlite";
import {
  aggregateBlockerHistory,
  canonicalizeChangedPath,
  changedPathToDenyGlob,
  DEFAULT_SYNTHESIS_CONFIG,
  isCoveredByDefaultDenyRules,
  normalizeBlockerHistory,
  normalizeBlockerHistoryRecord,
  normalizeRepoFullName,
  proposalStatusSet,
  resolveEffectiveDenyRules,
  setProposalStatuses,
  synthesizeDenyRuleProposals as engineSynthesizeDenyRuleProposals,
} from "@loopover/engine";
import type { DenyRuleProposal, SynthesisConfig } from "@loopover/engine";
import { DEFAULT_FORGE_CONFIG } from "./forge-config.js";
import type { DenyRule } from "./deny-hooks.js";
import { openLocalStoreDb, resolveLocalStoreDbPath } from "./local-store.js";
import { DENY_HOOK_SYNTHESIS_PURGE_SPEC, purgeStoreByRepo } from "./store-maintenance.js";

// Re-export the pure synthesis helpers from the engine so this module's public API is unchanged after #5667
// moved derivation/audit into @loopover/engine. Only the SQLite store below (and its forge/db-path helpers) is
// miner-local, because it depends on node:sqlite/node:fs and this package's forge-config default.
export {
  aggregateBlockerHistory,
  canonicalizeChangedPath,
  changedPathToDenyGlob,
  DEFAULT_SYNTHESIS_CONFIG,
  isCoveredByDefaultDenyRules,
  normalizeBlockerHistory,
  normalizeBlockerHistoryRecord,
  resolveEffectiveDenyRules,
  setProposalStatuses,
};

export type DenyHookSynthesisStore = {
  dbPath: string;
  refreshProposals(
    repoFullName: string,
    history: unknown,
    config?: SynthesisConfig,
    apiBaseUrl?: string,
  ): DenyRuleProposal[];
  listProposals(repoFullName: string, apiBaseUrl?: string): DenyRuleProposal[];
  setProposalStatus(
    repoFullName: string,
    proposalId: string,
    status: string,
    apiBaseUrl?: string,
  ): void;
  resolveEffectiveRules(
    repoFullName: string,
    options?: { includeDefaults?: boolean; apiBaseUrl?: string },
  ): DenyRule[];
  /** Delete every proposal row for one repo across ALL forge hosts (#8009); returns the number of rows removed. */
  purgeByRepo(repoFullName: string): number;
  close(): void;
};

const defaultDbFileName = "deny-hook-synthesis.sqlite3";

/**
 * Derive candidate deny-hook rules from blocker/path history. Miner-facing wrapper over the engine's pure
 * `synthesizeDenyRuleProposals`, defaulting the injected clock to `Date.now()` so this keeps the pre-#5667 2-arg
 * signature (and wall-clock `audit.synthesizedAt`) every existing caller and test relies on. Returns proposal
 * objects only — nothing is active until a maintainer approves them (see resolveEffectiveDenyRules).
 */
export function synthesizeDenyRuleProposals(records: unknown, config: SynthesisConfig = {}): DenyRuleProposal[] {
  return engineSynthesizeDenyRuleProposals(records, config, Date.now());
}

/** Optional forge host, scoping rows so two hosts serving the same owner/repo name never collide (#5563).
 *  Omitted/nullish → the github.com default, so every pre-existing single-forge caller is unaffected. */
function normalizeApiBaseUrl(apiBaseUrl?: string): string {
  if (apiBaseUrl === undefined || apiBaseUrl === null) return DEFAULT_FORGE_CONFIG.apiBaseUrl;
  if (typeof apiBaseUrl !== "string" || !apiBaseUrl.trim()) throw new Error("invalid_api_base_url");
  return apiBaseUrl.trim();
}

export function resolveDenyHookSynthesisDbPath(env: Record<string, string | undefined> = process.env): string {
  return resolveLocalStoreDbPath(defaultDbFileName, "LOOPOVER_MINER_DENY_HOOK_SYNTHESIS_DB", env);
}

// `dbPath` is always a real string here: this function's only caller (initDenyHookSynthesisStore) already
// defaults its own parameter to resolveDenyHookSynthesisDbPath() before ever reaching this call, so the
// nullish fallback historically here could never actually fire.
function normalizeDbPath(dbPath: string): string {
  const path = dbPath.trim();
  if (!path) throw new Error("invalid_deny_hook_synthesis_db_path");
  return path;
}

function rowToProposal(row: Record<string, unknown>): DenyRuleProposal {
  return {
    id: row.id as string,
    status: row.status as DenyRuleProposal["status"],
    rule: JSON.parse(row.rule_json as string),
    audit: JSON.parse(row.audit_json as string),
  };
}

// Rebuild deny_rule_proposals' (repo_full_name, id) PRIMARY KEY into a (api_base_url, repo_full_name, id)
// composite (#5563) -- two forge hosts serving a same-named owner/repo must not share one proposal row. SQLite
// cannot ALTER a PRIMARY KEY in place, so this rebuilds the table: create the new shape, copy every existing row
// with the pre-#4784 implicit single-forge default backfilled, drop the old table, rename the new one in.
// Guarded by a column-presence check (this module has no schema-version framework of its own, unlike the
// package's other local stores) so this only runs once per file.
function ensureDenyRuleProposalsForgeScope(db: DatabaseSync): void {
  const hasApiBaseUrlColumn = db
    .prepare("PRAGMA table_info(deny_rule_proposals)")
    .all()
    .some((column) => column.name === "api_base_url");
  if (hasApiBaseUrlColumn) return;
  db.exec(`
    CREATE TABLE deny_rule_proposals_v2 (
      api_base_url TEXT NOT NULL,
      repo_full_name TEXT NOT NULL,
      id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'rejected')),
      rule_json TEXT NOT NULL,
      audit_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (api_base_url, repo_full_name, id)
    )
  `);
  // OR IGNORE: a row this store's own read path already treats as unusable garbage (an unrecognized `status`,
  // e.g. from a hand-edited or otherwise corrupted file) would violate the CHECK constraint above and abort the
  // whole migration. Skipping it here is consistent with that same fail-closed posture, rather than turning one
  // bad row into a permanently unmigratable file.
  db.prepare(
    `INSERT OR IGNORE INTO deny_rule_proposals_v2 (api_base_url, repo_full_name, id, status, rule_json, audit_json, updated_at)
     SELECT ?, repo_full_name, id, status, rule_json, audit_json, updated_at FROM deny_rule_proposals`,
  ).run(DEFAULT_FORGE_CONFIG.apiBaseUrl);
  db.exec("DROP TABLE deny_rule_proposals");
  db.exec("ALTER TABLE deny_rule_proposals_v2 RENAME TO deny_rule_proposals");
}

/**
 * Local SQLite store for synthesized deny-rule proposals. Refresh re-derives proposals from history while
 * preserving maintainer decisions on ids that still exist.
 */
export function initDenyHookSynthesisStore(dbPath: string = resolveDenyHookSynthesisDbPath()): DenyHookSynthesisStore {
  const resolvedPath = normalizeDbPath(dbPath);
  // openLocalStoreDb centralizes the mkdir(0o700)/chmod(0o600)/busy_timeout + crash-safe cleanup registration and
  // treats ':memory:' as a no-file special case, so this store no longer hand-rolls that boilerplate (#8319).
  const db = openLocalStoreDb(resolvedPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS deny_rule_proposals (
      repo_full_name TEXT NOT NULL,
      id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'rejected')),
      rule_json TEXT NOT NULL,
      audit_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (repo_full_name, id)
    )
  `);
  ensureDenyRuleProposalsForgeScope(db);

  const upsertStatement = db.prepare(`
    INSERT INTO deny_rule_proposals (api_base_url, repo_full_name, id, status, rule_json, audit_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(api_base_url, repo_full_name, id) DO UPDATE SET
      status = excluded.status,
      rule_json = excluded.rule_json,
      audit_json = excluded.audit_json,
      updated_at = excluded.updated_at
  `);
  const getStatusStatement = db.prepare(
    "SELECT status FROM deny_rule_proposals WHERE api_base_url = ? AND repo_full_name = ? AND id = ?",
  );
  const listStatement = db.prepare(
    "SELECT repo_full_name, id, status, rule_json, audit_json, updated_at FROM deny_rule_proposals WHERE api_base_url = ? AND repo_full_name = ? ORDER BY id ASC",
  );
  const setStatusStatement = db.prepare(`
    UPDATE deny_rule_proposals SET status = ?, updated_at = ? WHERE api_base_url = ? AND repo_full_name = ? AND id = ?
  `);

  const store: DenyHookSynthesisStore = {
    dbPath: resolvedPath,
    refreshProposals(repoFullName, history, config = {}, apiBaseUrl) {
      const forge = normalizeApiBaseUrl(apiBaseUrl);
      const repo = normalizeRepoFullName(repoFullName);
      const synthesized = synthesizeDenyRuleProposals(history, config);
      const updatedAt = new Date().toISOString();
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const proposal of synthesized) {
          const existing = getStatusStatement.get(forge, repo, proposal.id) as { status?: string } | undefined;
          const status = existing?.status && proposalStatusSet.has(existing.status) && existing.status !== "proposed"
            ? existing.status
            : "proposed";
          upsertStatement.run(
            forge,
            repo,
            proposal.id,
            status,
            JSON.stringify(proposal.rule),
            JSON.stringify(proposal.audit),
            updatedAt,
          );
        }
        db.exec("COMMIT");
      } catch (error) {
        // Defensive: a genuine mid-transaction SQLite failure (disk full, corruption) rather than dead code --
        // deliberately not exercised by a contrived unit test, since forcing it would require mocking
        // node:sqlite's DatabaseSync rather than driving this through the real public API.
        db.exec("ROLLBACK");
        throw error;
      }
      return listStatement.all(forge, repo).map(rowToProposal);
    },
    listProposals(repoFullName, apiBaseUrl) {
      const forge = normalizeApiBaseUrl(apiBaseUrl);
      const repo = normalizeRepoFullName(repoFullName);
      return listStatement.all(forge, repo).map(rowToProposal);
    },
    setProposalStatus(repoFullName, proposalId, status, apiBaseUrl) {
      const forge = normalizeApiBaseUrl(apiBaseUrl);
      const repo = normalizeRepoFullName(repoFullName);
      if (typeof proposalId !== "string" || !proposalId.trim()) throw new Error("invalid_proposal_id");
      if (!proposalStatusSet.has(status)) throw new Error("invalid_proposal_status");
      setStatusStatement.run(status, new Date().toISOString(), forge, repo, proposalId.trim());
    },
    resolveEffectiveRules(repoFullName, options = {}) {
      const proposals = store.listProposals(repoFullName, options.apiBaseUrl);
      return resolveEffectiveDenyRules({
        includeDefaults: options.includeDefaults,
        approvedProposals: proposals,
      } as Parameters<typeof resolveEffectiveDenyRules>[0]);
    },
    /** Explicit, operator-invoked right-to-be-forgotten purge (#8009) — never runs automatically; this is what
     *  `loopover-miner purge` invokes. Filters on `repo_full_name` alone (the spec's own doc covers why), so —
     *  unlike every other method here, which scopes to one forge — the sweep clears the repo's proposals under
     *  every `api_base_url` they were recorded against, mirroring governor-state's purgeByRepo. */
    purgeByRepo(repoFullName) {
      return purgeStoreByRepo(db, DENY_HOOK_SYNTHESIS_PURGE_SPEC, normalizeRepoFullName(repoFullName));
    },
    close() {
      db.close();
    },
  };
  return store;
}
