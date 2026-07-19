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
 * objects only вЂ” nothing is active until a maintainer approves them (see resolveEffectiveDenyRules).
 */
export function synthesizeDenyRuleProposals(records, config = {}) {
    return engineSynthesizeDenyRuleProposals(records, config, Date.now());
}
/** Optional forge host, scoping rows so two hosts serving the same owner/repo name never collide (#5563).
 *  Omitted/nullish в†’ the github.com default, so every pre-existing single-forge caller is unaffected. */
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
    const hasApiBaseUrlColumn = db
        .prepare("PRAGMA table_info(deny_rule_proposals)")
        .all()
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
    return {
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
                    const status = existing?.status && proposalStatusSet.has(existing.status) && existing.status !== "proposed"
                        ? existing.status
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
            const proposals = this.listProposals(repoFullName, options.apiBaseUrl);
            return resolveEffectiveDenyRules({
                includeDefaults: options.includeDefaults,
                approvedProposals: proposals,
            });
        },
        close() {
            db.close();
        },
    };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGVueS1ob29rLXN5bnRoZXNpcy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImRlbnktaG9vay1zeW50aGVzaXMudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsZ0hBQWdIO0FBQ2hILDRHQUE0RztBQUM1Ryw0R0FBNEc7QUFDNUcsa0dBQWtHO0FBQ2xHLCtGQUErRjtBQUMvRixPQUFPLEVBQUUsU0FBUyxFQUFFLFNBQVMsRUFBRSxNQUFNLFNBQVMsQ0FBQztBQUMvQyxPQUFPLEVBQUUsT0FBTyxFQUFFLE1BQU0sU0FBUyxDQUFDO0FBQ2xDLE9BQU8sRUFBRSxPQUFPLEVBQUUsSUFBSSxFQUFFLE1BQU0sV0FBVyxDQUFDO0FBQzFDLE9BQU8sRUFBRSxZQUFZLEVBQUUsTUFBTSxhQUFhLENBQUM7QUFDM0MsT0FBTyxFQUNMLHVCQUF1QixFQUN2Qix1QkFBdUIsRUFDdkIscUJBQXFCLEVBQ3JCLHdCQUF3QixFQUN4QiwyQkFBMkIsRUFDM0IsdUJBQXVCLEVBQ3ZCLDZCQUE2QixFQUM3QixxQkFBcUIsRUFDckIsaUJBQWlCLEVBQ2pCLHlCQUF5QixFQUN6QixtQkFBbUIsRUFDbkIsMkJBQTJCLElBQUksaUNBQWlDLEdBQ2pFLE1BQU0sa0JBQWtCLENBQUM7QUFHMUIsT0FBTyxFQUFFLG9CQUFvQixFQUFFLE1BQU0sbUJBQW1CLENBQUM7QUFFekQsNEdBQTRHO0FBQzVHLCtHQUErRztBQUMvRyxrR0FBa0c7QUFDbEcsT0FBTyxFQUNMLHVCQUF1QixFQUN2Qix1QkFBdUIsRUFDdkIscUJBQXFCLEVBQ3JCLHdCQUF3QixFQUN4QiwyQkFBMkIsRUFDM0IsdUJBQXVCLEVBQ3ZCLDZCQUE2QixFQUM3Qix5QkFBeUIsRUFDekIsbUJBQW1CLEdBQ3BCLENBQUM7QUFnQkYsTUFBTSxpQkFBaUIsR0FBRyw2QkFBNkIsQ0FBQztBQUV4RDs7Ozs7R0FLRztBQUNILE1BQU0sVUFBVSwyQkFBMkIsQ0FBQyxPQUFnQixFQUFFLFNBQTBCLEVBQUU7SUFDeEYsT0FB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