// Content-addressed decision records (#8836, epic #8828 Phase 4) — the legibility layer.
//
// WHY: a contributor closed by ORB today cannot see WHICH ruleset version or clause closed them — and the
// authoritative config being private (LOOPOVER_REPO_CONFIG_DIR on the operator's host) makes that worse, not
// better. The remedy is a per-decision record whose inputs are pinned by content address: the digest is
// published even where the contents stay private, so "the bot closed me" becomes "clause X of ruleset
// abc123 closed me" — inspectable, arguable, and stable under challenge. The shape follows SLSA's
// Verification Summary Attestation (verifier + policy digest + result), which exists for exactly this
// delegate-a-decision pattern.
//
// This record is also the input schema the golden-corpus replay (#8832) and the deterministic replay harness
// (#8838) consume — one schema, three consumers, so drift between "what we published" and "what we can
// replay" is structurally impossible.
import { errorMessage, nowIso } from "../utils/json";

/** Bump when the record's FIELD SET changes meaning — consumers compare records only within a version. */
export const DECISION_RECORD_SCHEMA_VERSION = "1";

/**
 * Canonical JSON: recursively key-sorted, no insignificant whitespace — the ONE serialization every digest
 * in this system is computed over. Identical logical inputs must always hash identically, so object key
 * order (an artifact of construction, not meaning) can never influence a digest. Arrays keep their order
 * (order IS meaning there). undefined object members are dropped (JSON has no undefined); undefined inside
 * arrays follows JSON.stringify's own null coercion. PURE.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "undefined") return "null";
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  // Functions/symbols/bigints have no JSON meaning; refusing loudly beats a silent wrong digest.
  throw new Error(`canonicalJson: unsupported value type "${typeof value}"`);
}

/** SHA-256 hex over UTF-8 text via Web Crypto (available in the Workers runtime AND Node ≥20). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Digest of any JSON-shaped value via the canonical serialization above. */
export async function contentDigest(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value));
}

/** The published, public-safe decision record. Counts/digests/enums only — no diffs, no private config
 *  contents (their DIGEST is the commitment), no author identity beyond what the PR page already shows. */
export type DecisionRecord = {
  schemaVersion: string;
  repoFullName: string;
  pullNumber: number;
  headSha: string;
  baseSha: string | null;
  /** The disposition the bot actually acted on (merge/close/hold) — never the raw check conclusion (#8825). */
  action: string;
  /** The clause that decided it: a blocker class, `policy_close:<kind>`, or the gate conclusion. */
  reasonCode: string;
  /** Digest of the RESOLVED effective settings (canonical JSON) — commits the operator to the exact config
   *  that judged this PR, including private overlays, without publishing their contents. */
  configDigest: string;
  /** The gate policy pack in force (public enum, safe to publish alongside the digest). */
  gatePack: string | null;
  /** CI aggregate consumed by the decision, when one was read. */
  ciState: string | null;
  /** Model + prompt commitments when an AI review contributed; null for rule-only decisions. */
  modelId: string | null;
  promptDigest: string | null;
  decidedAt: string;
};

/** Assemble the record and its own content digest. PURE given pre-computed digests. Normalizes the
 *  optional-shaped caller fields (undefined -> null) HERE so call sites carry no fallback arms of their own. */
export async function buildDecisionRecord(
  input: Omit<DecisionRecord, "schemaVersion" | "decidedAt" | "gatePack" | "ciState" | "baseSha"> & {
    decidedAt?: string;
    gatePack?: string | null | undefined;
    ciState?: string | null | undefined;
    baseSha?: string | null | undefined;
  },
): Promise<{ record: DecisionRecord; recordDigest: string }> {
  const record: DecisionRecord = {
    schemaVersion: DECISION_RECORD_SCHEMA_VERSION,
    decidedAt: input.decidedAt ?? nowIso(),
    ...input,
    gatePack: input.gatePack ?? null,
    ciState: input.ciState ?? null,
    baseSha: input.baseSha ?? null,
  };
  return { record, recordDigest: await contentDigest(record) };
}

/**
 * Persist the record (decision_records, migration 0179), keyed per (target, head sha) with
 * latest-finalize-wins — the same replacement contract as the gate_decision row it explains. Best-effort:
 * recording legibility must never break finalization (mirrors recordNativeGateDecision's posture).
 */
export async function persistDecisionRecord(env: Env, record: DecisionRecord, recordDigest: string): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO decision_records (id, repo_full_name, pull_number, head_sha, action, reason_code, record_digest, record_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET action = excluded.action, reason_code = excluded.reason_code,
         record_digest = excluded.record_digest, record_json = excluded.record_json, created_at = excluded.created_at`,
    )
      .bind(
        `record:${record.repoFullName}#${record.pullNumber}@${record.headSha}`.slice(0, 250),
        record.repoFullName.slice(0, 200),
        record.pullNumber,
        record.headSha,
        record.action,
        record.reasonCode.slice(0, 200),
        recordDigest,
        canonicalJson(record),
        record.decidedAt,
      )
      .run();
  } catch (error) {
    console.warn(JSON.stringify({ event: "decision_record_persist_error", target: `${record.repoFullName}#${record.pullNumber}`, message: errorMessage(error).slice(0, 160) }));
  }
}

/** Bounded, human-readable markdown body for the public review surface: the claim ("clause X of config
 *  abc123…") plus the digests a challenger needs. Digests are truncated for display; the full values live in
 *  the persisted record. Returned WITHOUT a details wrapper — the unified-comment bridge renders the
 *  collapsible chrome itself (UnifiedCollapsible). */
export function renderDecisionRecordSection(record: DecisionRecord, recordDigest: string): string {
  const short = (digest: string): string => digest.slice(0, 12);
  const lines = [
    `- **action**: ${record.action} · **clause**: \`${record.reasonCode}\``,
    `- **config**: \`${short(record.configDigest)}\`${record.gatePack ? ` · **pack**: ${record.gatePack}` : ""}${record.ciState ? ` · **ci**: ${record.ciState}` : ""}`,
    ...(record.modelId !== null || record.promptDigest !== null
      ? [`- **model**: ${record.modelId ?? "n/a"}${record.promptDigest !== null ? ` · **prompt**: \`${short(record.promptDigest)}\`` : ""}`]
      : []),
    `- **record**: \`${short(recordDigest)}\` (schema v${record.schemaVersion}, head \`${record.headSha.slice(0, 7)}\`)`,
  ];
  return lines.join("\n");
}

/** Load the latest persisted record for a PR as a ready-to-append UnifiedCollapsible body; null when none
 *  exists yet (first publish precedes the first finalize) or the stored JSON is unreadable (fail-safe: the
 *  comment simply omits the section rather than failing the publish). */
export async function loadDecisionRecordCollapsible(env: Env, repoFullName: string, pullNumber: number): Promise<{ title: string; body: string } | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT record_digest AS recordDigest, record_json AS recordJson FROM decision_records
        WHERE repo_full_name = ? AND pull_number = ? ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(repoFullName, pullNumber)
      .first<{ recordDigest: string; recordJson: string }>();
    if (!row) return null;
    const record = JSON.parse(row.recordJson) as DecisionRecord;
    return { title: "Decision record", body: renderDecisionRecordSection(record, row.recordDigest) };
  } catch (error) {
    console.warn(JSON.stringify({ event: "decision_record_load_error", target: `${repoFullName}#${pullNumber}`, message: errorMessage(error).slice(0, 160) }));
    return null;
  }
}
