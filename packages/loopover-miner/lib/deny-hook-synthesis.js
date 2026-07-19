// Synthesize PreToolUse deny-hook rule proposals from per-repo blocker/path history (#4522). The pure synthesis
// logic moved into `@loopover/engine` (packages/loopover-engine/src/miner/deny-hook-synthesis.ts) by #5667;
// this module is now a thin wrapper that re-exports those pure helpers and keeps the local SQLite store for
// refresh + maintainer review before any synthesized rule takes effect. Approved rules merge with
// {@link DEFAULT_DENY_RULES}; unapproved proposals never block tool calls. No behavior change.
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { aggregateBlockerHistory, canonicalizeChangedPath, changedPathToDenyGlob, DEFAULT_SYNTHESIS_CONFIG, isCoveredByDefaultDenyRules, normalizeBlockerHistory, normalizeBlockerHistoryRecord, normalizeRepoFullName, proposalStatusSet, resolveEffectiveDenyRules, setProposalStatuses, synthesizeDenyRuleProposals as engineSynthesizeDenyRuleProposals, } from "@loopover/engine";
import { DEFAULT_FORGE_CONFIG } from "./forge-config.js";
// Re-export the pure synthesis helpers from the engine so this module's public API is unchanged after #5667
// moved derivation/audit into @loopover/engine. Only the SQLite store below (and its forge/db-path helpers) is
// miner-local, because it depends on node:sqlite/node:fs and this package's forge-config default.
export { aggregateBlockerHistory, canonicalizeChangedPath, changedPathToDenyGlob, DEFAULT_SYNTHESIS_CONFIG, isCoveredByDefaultDenyRules, normalizeBlockerHistory, normalizeBlockerHistoryRecord, resolveEffectiveDenyRules, setProposalStatuses, };
const defaultDbFileName = "deny-hook-synthesis.sqlite3";
/**
 * Derive candidate deny-hook rules from blocker/path history. Miner-facing wrapper over the engine's pure
 * `synthesizeDenyRuleProposals`, defaulting the injected clock to `Date.now()` so this keeps the pre-#5667 2-arg
 * signature (and wall-clock `audit.synthesizedAt`) every existing caller and test relies on. Returns proposal
 * objects only — nothing is active until a maintainer approves them (see resolveEffectiveDenyRules).
 */
export function synthesizeDenyRuleProposals(records, config = {}) {
    return engineSynthesizeDenyRuleProposals(records, config, Date.now());
}
/** Optional forge host, scoping rows so two hosts serving the same owner/repo name never collide (#5563).
 *  Omitted/nullish → the github.com default, so every pre-existing single-forge caller is unaffected. */
function normalizeApiBaseUrl(apiBaseUrl) {
    if (apiBaseUrl === undefined || apiBaseUrl === null)
        return DEFAULT_FORGE_CONFIG.apiBaseUrl;
    if (typeof apiBaseUrl !== "string" || !apiBaseUrl.trim())
        throw new Error("invalid_api_base_url");
    return apiBaseUrl.trim();
}
export function resolveDenyHookSynthesisDbPath(env = process.env) {
    const explicitPath = typeof env.LOOPOVER_MINER_DENY_HOOK_SYNTHESIS_DB === "string"
        ? env.LOOPOVER_MINER_DENY_HOOK_SYNTHESIS_DB.trim()
        : "";
    if (explicitPath)
        return explicitPath;
    const explicitConfigDir = typeof env.LOOPOVER_MINER_CONFIG_DIR === "string"
        ? env.LOOPOVER_MINER_CONFIG_DIR.trim()
        : "";
    if (explicitConfigDir)
        return join(explicitConfigDir, defaultDbFileName);
    const configHome = typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()
        ? env.XDG_CONFIG_HOME.trim()
        : join(homedir(), ".config");
    return join(configHome, "loopover-miner", defaultDbFileName);
}
function normalizeDbPath(dbPath) {
    const path = (dbPath ?? resolveDenyHookSynthesisDbPath()).trim();
    if (!path)
        throw new Error("invalid_deny_hook_synthesis_db_path");
    return path;
}
function rowToProposal(row) {
    return {
        id: row.id,
        status: row.status,
        rule: JSON.parse(row.rule_json),
        audit: JSON.parse(row.audit_json),
    };
}
// Rebuild deny_rule_proposals' (repo_full_name, id) PRIMARY KEY into a (api_base_url, repo_full_name, id)
// composite (#5563) -- two forge hosts serving a same-named owner/repo must not share one proposal row. SQLite
// cannot ALTER a PRIMARY KEY in place, so this rebuilds the table: create the new shape, copy every existing row
// with the pre-#4784 implicit single-forge default backfilled, drop the old table, rename the new one in.
// Guarded by a column-presence check (this module has no schema-version framework of its own, unlike the
// package's other local stores) so this only runs once per file.
function ensureDenyRuleProposalsForgeScope(db) {
    const hasApiBaseUrlColumn = db.prepare("PRAGMA table_info(deny_rule_proposals)").all()
        .some((column) => column.name === "api_base_url");
    if (hasApiBaseUrlColumn)
        return;
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
    db.prepare(`INSERT OR IGNORE INTO deny_rule_proposals_v2 (api_base_url, repo_full_name, id, status, rule_json, audit_json, updated_at)
     SELECT ?, repo_full_name, id, status, rule_json, audit_json, updated_at FROM deny_rule_proposals`).run(DEFAULT_FORGE_CONFIG.apiBaseUrl);
    db.exec("DROP TABLE deny_rule_proposals");
    db.exec("ALTER TABLE deny_rule_proposals_v2 RENAME TO deny_rule_proposals");
}
/**
 * Local SQLite store for synthesized deny-rule proposals. Refresh re-derives proposals from history while
 * preserving maintainer decisions on ids that still exist.
 */
export function initDenyHookSynthesisStore(dbPath = resolveDenyHookSynthesisDbPath()) {
    const resolvedPath = normalizeDbPath(dbPath);
    mkdirSync(dirname(resolvedPath), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(resolvedPath);
    chmodSync(resolvedPath, 0o600);
    db.exec("PRAGMA busy_timeout = 5000");
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
    const getStatusStatement = db.prepare("SELECT status FROM deny_rule_proposals WHERE api_base_url = ? AND repo_full_name = ? AND id = ?");
    const listStatement = db.prepare("SELECT repo_full_name, id, status, rule_json, audit_json, updated_at FROM deny_rule_proposals WHERE api_base_url = ? AND repo_full_name = ? ORDER BY id ASC");
    const setStatusStatement = db.prepare(`
    UPDATE deny_rule_proposals SET status = ?, updated_at = ? WHERE api_base_url = ? AND repo_full_name = ? AND id = ?
  `);
    const store = {
        dbPath: resolvedPath,
        refreshProposals(repoFullName, history, config = {}, apiBaseUrl) {
            const forge = normalizeApiBaseUrl(apiBaseUrl);
            const repo = normalizeRepoFullName(repoFullName);
            const synthesized = synthesizeDenyRuleProposals(history, config);
            const updatedAt = new Date().toISOString();
            db.exec("BEGIN IMMEDIATE");
            try {
                for (const proposal of synthesized) {
                    const existing = getStatusStatement.get(forge, repo, proposal.id);
                    const existingStatus = typeof existing?.status === "string" ? existing.status : undefined;
                    const status = existingStatus && proposalStatusSet.has(existingStatus) && existingStatus !== "proposed"
                        ? existingStatus
                        : "proposed";
                    upsertStatement.run(forge, repo, proposal.id, status, JSON.stringify(proposal.rule), JSON.stringify(proposal.audit), updatedAt);
                }
                db.exec("COMMIT");
            }
            catch (error) {
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
            if (typeof proposalId !== "string" || !proposalId.trim())
                throw new Error("invalid_proposal_id");
            if (!proposalStatusSet.has(status))
                throw new Error("invalid_proposal_status");
            setStatusStatement.run(status, new Date().toISOString(), forge, repo, proposalId.trim());
        },
        resolveEffectiveRules(repoFullName, options = {}) {
            const proposals = store.listProposals(repoFullName, options.apiBaseUrl);
            return resolveEffectiveDenyRules({
                ...(options.includeDefaults !== undefined ? { includeDefaults: options.includeDefaults } : {}),
                approvedProposals: proposals,
            });
        },
        close() {
            db.close();
        },
    };
    return store;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGVueS1ob29rLXN5bnRoZXNpcy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImRlbnktaG9vay1zeW50aGVzaXMudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsZ0hBQWdIO0FBQ2hILDRHQUE0RztBQUM1Ryw0R0FBNEc7QUFDNUcsa0dBQWtHO0FBQ2xHLCtGQUErRjtBQUMvRixPQUFPLEVBQUUsU0FBUyxFQUFFLFNBQVMsRUFBRSxNQUFNLFNBQVMsQ0FBQztBQUMvQyxPQUFPLEVBQUUsT0FBTyxFQUFFLE1BQU0sU0FBUyxDQUFDO0FBQ2xDLE9BQU8sRUFBRSxPQUFPLEVBQUUsSUFBSSxFQUFFLE1BQU0sV0FBVyxDQUFDO0FBQzFDLE9BQU8sRUFBRSxZQUFZLEVBQUUsTUFBTSxhQUFhLENBQUM7QUFDM0MsT0FBTyxFQUNMLHVCQUF1QixFQUN2Qix1QkFBdUIsRUFDdkIscUJBQXFCLEVBQ3JCLHdCQUF3QixFQUN4QiwyQkFBMkIsRUFDM0IsdUJBQXVCLEVBQ3ZCLDZCQUE2QixFQUM3QixxQkFBcUIsRUFDckIsaUJBQWlCLEVBQ2pCLHlCQUF5QixFQUN6QixtQkFBbUIsRUFDbkIsMkJBQTJCLElBQUksaUNBQWlDLEdBQ2pFLE1BQU0sa0JBQWtCLENBQUM7QUFTMUIsT0FBTyxFQUFFLG9CQUFvQixFQUFFLE1BQU0sbUJBQW1CLENBQUM7QUFFekQsNEdBQTRHO0FBQzVHLCtHQUErRztBQUMvRyxrR0FBa0c7QUFDbEcsT0FBTyxFQUNMLHVCQUF1QixFQUN2Qix1QkFBdUIsRUFDdkIscUJBQXFCLEVBQ3JCLHdCQUF3QixFQUN4QiwyQkFBMkIsRUFDM0IsdUJBQXVCLEVBQ3ZCLDZCQUE2QixFQUM3Qix5QkFBeUIsRUFDekIsbUJBQW1CLEdBQ3BCLENBQUM7QUFTRixNQUFNLGlCQUFpQixHQUFHLDZCQUE2QixDQUFDO0FBbUN4RDs7Ozs7R0FLRztBQUNILE1BQU0sVUFBVSwyQkFBMkIsQ0FDekMsT0FBZ0IsRUFDaEIsU0FBMEIsRUFBRTtJQUU1QixP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