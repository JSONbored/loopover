// Synthesize PreToolUse deny-hook rule proposals from per-repo blocker/path history (#4522). Pure synthesis
// plus an optional local SQLite store for refresh + maintainer review before any synthesized rule takes effect.
// Approved rules merge with {@link DEFAULT_DENY_RULES}; unapproved proposals never block tool calls. Feeds the
// consumption surface #2343 will wire into evaluateDenyHooks — this issue owns derivation + audit, not live hook
// interception.
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_DENY_RULES, evaluateDenyHooks } from "./deny-hooks.js";
import { DEFAULT_FORGE_CONFIG } from "./forge-config.js";

const defaultDbFileName = "deny-hook-synthesis.sqlite3";
const PROPOSAL_STATUSES = Object.freeze(["proposed", "approved", "rejected"]);
const proposalStatusSet = new Set(PROPOSAL_STATUSES);

export const DEFAULT_SYNTHESIS_CONFIG = Object.freeze({
  minPathOccurrences: 2,
  maxProposals: 20,
});

function normalizeRepoFullName(repoFullName) {
  if (typeof repoFullName !== "string") throw new Error("invalid_repo_full_name");
  const [owner, repo, extra] = repoFullName.trim().split("/");
  if (!owner || !repo || extra !== undefined) throw new Error("invalid_repo_full_name");
  return `${owner}/${repo}`;
}

/** Optional forge host, scoping rows so two hosts serving the same owner/repo name never collide (#5563).
 *  Omitted/nullish → the github.com default, so every pre-existing single-forge caller is unaffected. */
function normalizeApiBaseUrl(apiBaseUrl) {
  if (apiBaseUrl === undefined || apiBaseUrl === null) return DEFAULT_FORGE_CONFIG.apiBaseUrl;
  if (typeof apiBaseUrl !== "string" || !apiBaseUrl.trim()) throw new Error("invalid_api_base_url");
  return apiBaseUrl.trim();
}

function normalizeOptionalStringArray(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim());
}

/** Validate one blocker-history row from the review stack (gate block/close audit). */
export function normalizeBlockerHistoryRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const blockerCodes = normalizeOptionalStringArray(record.blockerCodes);
  if (blockerCodes.length === 0) return null;
  const changedPaths = normalizeOptionalStringArray(record.changedPaths);
  const guardrailMatches = normalizeOptionalStringArray(record.guardrailMatches);
  const repoFullName = typeof record.repoFullName === "string" && record.repoFullName.trim()
    ? normalizeRepoFullName(record.repoFullName)
    : null;
  return {
    repoFullName,
    blockerCodes,
    changedPaths,
    guardrailMatches,
    pullNumber: Number.isInteger(record.pullNumber) && record.pullNumber > 0 ? record.pullNumber : null,
    recordedAt: typeof record.recordedAt === "string" && record.recordedAt.trim() ? record.recordedAt.trim() : null,
  };
}

export function normalizeBlockerHistory(records) {
  if (!Array.isArray(records)) return [];
  const normalized = [];
  for (const record of records) {
    const entry = normalizeBlockerHistoryRecord(record);
    if (entry) normalized.push(entry);
  }
  return normalized;
}

/** Canonicalize a changed path the same way guardrail matching does (case/separator insensitive). */
export function canonicalizeChangedPath(path) {
  if (typeof path !== "string") return null;
  const trimmed = path.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
  if (!trimmed || trimmed.includes("..")) return null;
  return trimmed.toLowerCase();
}

/** Convert a repo-relative changed path into a deny-hook glob matching DEFAULT_DENY_RULES shape. */
export function changedPathToDenyGlob(path) {
  const canonical = canonicalizeChangedPath(path);
  if (!canonical) return null;
  return `**/${canonical}`;
}

function ruleSignature(rule) {
  return JSON.stringify({
    matcher: rule.matcher,
    pathPattern: rule.pathPattern ?? null,
    inputIncludesAll: rule.inputIncludesAll ?? null,
    reason: rule.reason,
  });
}

/** True when a synthesized glob is already enforced by a built-in default deny rule. */
export function isCoveredByDefaultDenyRules(pathPattern) {
  if (typeof pathPattern !== "string" || !pathPattern.trim()) return false;
  const samplePath = pathPattern.replace(/^\*\*\//, "");
  if (!samplePath) return false;
  return !evaluateDenyHooks({ name: "Write", input: { file_path: samplePath } }, DEFAULT_DENY_RULES).allowed;
}

function collectPathsFromRecord(record) {
  const paths = new Set();
  for (const path of [...record.changedPaths, ...record.guardrailMatches]) {
    const canonical = canonicalizeChangedPath(path);
    if (canonical) paths.add(canonical);
  }
  return paths;
}

/** Aggregate path and blocker-code frequencies from normalized history. Pure. */
export function aggregateBlockerHistory(records) {
  const normalized = normalizeBlockerHistory(records);
  const pathCounts = new Map();
  const pathBlockers = new Map();
  const blockerCounts = new Map();

  for (const record of normalized) {
    for (const code of record.blockerCodes) {
      blockerCounts.set(code, (blockerCounts.get(code) ?? 0) + 1);
    }
    for (const path of collectPathsFromRecord(record)) {
      pathCounts.set(path, (pathCounts.get(path) ?? 0) + 1);
      const blockers = pathBlockers.get(path) ?? new Set();
      for (const code of record.blockerCodes) blockers.add(code);
      pathBlockers.set(path, blockers);
    }
  }

  return {
    pathCounts,
    pathBlockers,
    blockerCounts,
    recordCount: normalized.length,
  };
}

function stableProposalId(kind, key) {
  const digest = createHash("sha256").update(`${kind}:${key}`).digest("hex").slice(0, 16);
  return `${kind}:${digest}`;
}

function buildPathProposal(path, occurrenceCount, blockerCodes) {
  const pathPattern = changedPathToDenyGlob(path);
  if (!pathPattern || isCoveredByDefaultDenyRules(pathPattern)) return null;
  const sortedBlockers = [...blockerCodes].sort();
  const reason = `Synthesized deny rule: ${occurrenceCount} gate block(s) touched ${path} (${sortedBlockers.join(", ") || "path history"}). Review before enabling.`;
  const rule = { matcher: "*", pathPattern, reason };
  return {
    id: stableProposalId("path", pathPattern),
    status: "proposed",
    rule,
    audit: {
      kind: "path_history",
      path,
      pathPattern,
      occurrenceCount,
      blockerCodes: sortedBlockers,
      synthesizedAt: new Date(0).toISOString(),
    },
  };
}

/**
 * Derive candidate deny-hook rules from blocker/path history. Returns proposal objects only — nothing is active
 * until a maintainer approves them (see resolveEffectiveDenyRules).
 */
export function synthesizeDenyRuleProposals(records, config = {}) {
  const minPathOccurrences = Number.isInteger(config.minPathOccurrences)
    ? Math.max(1, config.minPathOccurrences)
    : DEFAULT_SYNTHESIS_CONFIG.minPathOccurrences;
  const maxProposals = Number.isInteger(config.maxProposals)
    ? Math.max(1, config.maxProposals)
    : DEFAULT_SYNTHESIS_CONFIG.maxProposals;

  const { pathCounts, pathBlockers, recordCount } = aggregateBlockerHistory(records);
  if (recordCount === 0) return [];

  const rankedPaths = [...pathCounts.entries()]
    .filter(([, count]) => count >= minPathOccurrences)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));

  const proposals = [];
  const seenSignatures = new Set(DEFAULT_DENY_RULES.map(ruleSignature));
  for (const [path, count] of rankedPaths) {
    const proposal = buildPathProposal(path, count, pathBlockers.get(path) ?? new Set());
    if (!proposal) continue;
    const signature = ruleSignature(proposal.rule);
    if (seenSignatures.has(signature)) continue;
    seenSignatures.add(signature);
    proposals.push({
      ...proposal,
      audit: { ...proposal.audit, synthesizedAt: new Date().toISOString() },
    });
    if (proposals.length >= maxProposals) break;
  }
  return proposals;
}

/** Merge built-in defaults with maintainer-approved synthesized rules (deduped, defaults first). */
export function resolveEffectiveDenyRules(options = {}) {
  const includeDefaults = options.includeDefaults !== false;
  const approvedProposals = Array.isArray(options.approvedProposals) ? options.approvedProposals : [];
  const merged = includeDefaults ? [...DEFAULT_DENY_RULES] : [];
  const seen = new Set(merged.map(ruleSignature));
  for (const proposal of approvedProposals) {
    if (proposal?.status !== "approved") continue;
    const rule = proposal.rule;
    if (!rule || typeof rule !== "object") continue;
    const signature = ruleSignature(rule);
    if (seen.has(signature)) continue;
    seen.add(signature);
    merged.push(rule);
  }
  return merged;
}

/** Apply maintainer approval/rejection to in-memory proposals. Pure. */
export function setProposalStatuses(proposals, updates) {
  if (!Array.isArray(proposals)) throw new Error("invalid_proposals");
  const updateMap = updates instanceof Map
    ? updates
    : new Map(Object.entries(updates ?? {}).filter(([id]) => typeof id === "string"));
  return proposals.map((proposal) => {
    const nextStatus = updateMap.get(proposal.id);
    if (!nextStatus || !proposalStatusSet.has(nextStatus)) return proposal;
    return { ...proposal, status: nextStatus };
  });
}

export function resolveDenyHookSynthesisDbPath(env = process.env) {
  const explicitPath = typeof env.GITTENSORY_MINER_DENY_HOOK_SYNTHESIS_DB === "string"
    ? env.GITTENSORY_MINER_DENY_HOOK_SYNTHESIS_DB.trim()
    : "";
  if (explicitPath) return explicitPath;

  const explicitConfigDir = typeof env.GITTENSORY_MINER_CONFIG_DIR === "string"
    ? env.GITTENSORY_MINER_CONFIG_DIR.trim()
    : "";
  if (explicitConfigDir) return join(explicitConfigDir, defaultDbFileName);

  const configHome = typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()
    ? env.XDG_CONFIG_HOME.trim()
    : join(homedir(), ".config");
  return join(configHome, "gittensory-miner", defaultDbFileName);
}

function normalizeDbPath(dbPath) {
  const path = (dbPath ?? resolveDenyHookSynthesisDbPath()).trim();
  if (!path) throw new Error("invalid_deny_hook_synthesis_db_path");
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
  const getStatusStatement = db.prepare(
    "SELECT status FROM deny_rule_proposals WHERE api_base_url = ? AND repo_full_name = ? AND id = ?",
  );
  const listStatement = db.prepare(
    "SELECT repo_full_name, id, status, rule_json, audit_json, updated_at FROM deny_rule_proposals WHERE api_base_url = ? AND repo_full_name = ? ORDER BY id ASC",
  );
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
