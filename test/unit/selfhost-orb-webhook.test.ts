import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createD1Adapter, nodeSqliteDriver } from "../../src/selfhost/d1-adapter";
import {
  handleOrbWebhook,
  lookupGateVerdict,
  verifyOrbSignature,
} from "../../src/selfhost/orb-webhook";
import { resetMetrics, renderMetrics } from "../../src/selfhost/metrics";

const SECRET = "test-webhook-secret";

function sign(payload: string, secret = SECRET): string {
  return "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
}

function makeDb(): D1Database {
  const driver = nodeSqliteDriver(new DatabaseSync(":memory:") as never);
  driver.exec(`
    CREATE TABLE orb_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL, pr_number INTEGER NOT NULL, head_sha TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('merged', 'closed')),
      gate_verdict TEXT, time_to_close_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      exported_at TEXT,
      UNIQUE (repo, pr_number, head_sha)
    );
    CREATE TABLE orb_installations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      installation_id INTEGER NOT NULL, repo TEXT NOT NULL,
      installed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      removed_at TEXT,
      UNIQUE (installation_id, repo)
    );
    CREATE TABLE review_targets (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL, kind TEXT NOT NULL, repo TEXT NOT NULL,
      number INTEGER NOT NULL, verdict TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (project, kind, repo, number)
    );
  `);
  return createD1Adapter(driver);
}

// ── verifyOrbSignature ────────────────────────────────────────────────────────

describe("verifyOrbSignature()", () => {
  it("returns true for a correctly signed payload", () => {
    const payload = '{"action":"closed"}';
    expect(verifyOrbSignature(payload, sign(payload), SECRET)).toBe(true);
  });

  it("returns false when the signature doesn't match", () => {
    expect(verifyOrbSignature("payload", sign("other"), SECRET)).toBe(false);
  });

  it("returns false when the secret is wrong", () => {
    const payload = "body";
    expect(verifyOrbSignature(payload, sign(payload, "wrong-secret"), SECRET)).toBe(false);
  });

  it("returns false when the sig header is missing the sha256= prefix", () => {
    const payload = "body";
    const raw = createHmac("sha256", SECRET).update(payload).digest("hex");
    expect(verifyOrbSignature(payload, raw, SECRET)).toBe(false);
  });

  it("returns false for empty sig", () => {
    expect(verifyOrbSignature("body", "", SECRET)).toBe(false);
  });

  it("returns false when sig hex is malformed/wrong length (timingSafeEqual throws — covers catch branch)", () => {
    // "sha256=" prefix passes, but odd-length hex → Buffer.from(..., 'hex') produces
    // a different byte length than the 32-byte expected HMAC → timingSafeEqual throws ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH
    expect(verifyOrbSignature("body", "sha256=abc", SECRET)).toBe(false);
  });
});

// ── lookupGateVerdict ─────────────────────────────────────────────────────────

describe("lookupGateVerdict()", () => {
  beforeEach(() => { process.env.ORB_ENABLED = "true"; });
  afterEach(() => { delete process.env.ORB_ENABLED; });

  it("returns the verdict from review_targets for a matching repo+PR", async () => {
    const db = makeDb();
    await db.prepare(`INSERT INTO review_targets (id, project, kind, repo, number, verdict, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind("t1", "proj", "PR", "owner/repo", 42, "merge", "2024-01-01T00:00:00Z").run();
    expect(await lookupGateVerdict(db, "owner/repo", 42)).toBe("merge");
  });

  it("returns null when no review_target row exists", async () => {
    const db = makeDb();
    expect(await lookupGateVerdict(db, "owner/repo", 99)).toBeNull();
  });

  it("returns null on DB error (best-effort)", async () => {
    const brokenDb = { prepare: () => ({ bind: () => ({ first: () => Promise.reject(new Error("disk full")) }) }) } as unknown as D1Database;
    expect(await lookupGateVerdict(brokenDb, "o/r", 1)).toBeNull();
  });

  it("picks the most recent verdict when multiple rows exist for the same repo+PR", async () => {
    const db = makeDb();
    await db.prepare(`INSERT INTO review_targets (id, project, kind, repo, number, verdict, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind("t1", "p", "PR", "o/r", 1, "close", "2024-01-01T00:00:00Z").run();
    await db.prepare(`INSERT INTO review_targets (id, project, kind, repo, number, verdict, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind("t2", "p2", "PR", "o/r", 1, "merge", "2024-01-02T00:00:00Z").run();
    expect(await lookupGateVerdict(db, "o/r", 1)).toBe("merge");
  });
});

// ── handleOrbWebhook ──────────────────────────────────────────────────────────

describe("handleOrbWebhook() — pull_request events", () => {
  beforeEach(() => { resetMetrics(); process.env.ORB_ENABLED = "true"; });
  afterEach(() => { delete process.env.ORB_ENABLED; });

  const prPayload = (action: string, merged: boolean, prNumber = 7) =>
    JSON.stringify({
      action,
      pull_request: {
        number: prNumber,
        head: { sha: "abc123" },
        merged,
        created_at: "2024-01-01T00:00:00Z",
        closed_at: "2024-01-01T01:00:00Z",
      },
      repository: { full_name: "owner/repo" },
    });

  it("returns 204 for a merged PR and records it in orb_events", async () => {
    const db = makeDb();
    const result = await handleOrbWebhook("pull_request", prPayload("closed", true), db);
    expect(result.status).toBe(204);
    const row = await db.prepare("SELECT outcome FROM orb_events WHERE repo='owner/repo' AND pr_number=7").first<{ outcome: string }>();
    expect(row?.outcome).toBe("merged");
  });

  it("records outcome='closed' for a non-merged closed PR", async () => {
    const db = makeDb();
    await handleOrbWebhook("pull_request", prPayload("closed", false), db);
    const row = await db.prepare("SELECT outcome FROM orb_events WHERE repo='owner/repo' AND pr_number=7").first<{ outcome: string }>();
    expect(row?.outcome).toBe("closed");
  });

  it("calculates time_to_close_ms from created_at and closed_at", async () => {
    const db = makeDb();
    await handleOrbWebhook("pull_request", prPayload("closed", true), db);
    const row = await db.prepare("SELECT time_to_close_ms FROM orb_events WHERE pr_number=7").first<{ time_to_close_ms: number }>();
    expect(row?.time_to_close_ms).toBe(3600000); // 1 hour
  });

  it("stores the gate verdict from review_targets when present", async () => {
    const db = makeDb();
    await db.prepare(`INSERT INTO review_targets (id, project, kind, repo, number, verdict, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind("t1", "p", "PR", "owner/repo", 7, "merge", "2024-01-01T00:00:00Z").run();
    await handleOrbWebhook("pull_request", prPayload("closed", true), db);
    const row = await db.prepare("SELECT gate_verdict FROM orb_events WHERE pr_number=7").first<{ gate_verdict: string }>();
    expect(row?.gate_verdict).toBe("merge");
  });

  it("stores null gate_verdict when no review_target exists for the PR", async () => {
    const db = makeDb();
    await handleOrbWebhook("pull_request", prPayload("closed", false), db);
    const row = await db.prepare("SELECT gate_verdict FROM orb_events WHERE pr_number=7").first<{ gate_verdict: string | null }>();
    expect(row?.gate_verdict).toBeNull();
  });

  it("records null time_to_close_ms when closed_at or created_at is absent (covers ternary null branches)", async () => {
    const db = makeDb();
    const payload = JSON.stringify({
      action: "closed",
      pull_request: { number: 5, head: { sha: "sha5" }, merged: true, created_at: null, closed_at: null },
      repository: { full_name: "owner/repo" },
    });
    const result = await handleOrbWebhook("pull_request", payload, db);
    expect(result.status).toBe(204);
    const row = await db.prepare("SELECT time_to_close_ms FROM orb_events WHERE pr_number=5").first<{ time_to_close_ms: number | null }>();
    expect(row?.time_to_close_ms).toBeNull();
  });

  it("records null time_to_close_ms when only closed_at is absent", async () => {
    const db = makeDb();
    const payload = JSON.stringify({
      action: "closed",
      pull_request: { number: 6, head: { sha: "sha6" }, merged: false, created_at: "2024-01-01T00:00:00Z", closed_at: null },
      repository: { full_name: "owner/repo" },
    });
    await handleOrbWebhook("pull_request", payload, db);
    const row = await db.prepare("SELECT time_to_close_ms FROM orb_events WHERE pr_number=6").first<{ time_to_close_ms: number | null }>();
    expect(row?.time_to_close_ms).toBeNull();
  });

  it("returns 204 and does NOT record for non-closed pull_request actions", async () => {
    const db = makeDb();
    const result = await handleOrbWebhook("pull_request", prPayload("opened", false), db);
    expect(result.status).toBe(204);
    const { results } = await db.prepare("SELECT * FROM orb_events").all();
    expect(results).toHaveLength(0);
  });

  it("increments gittensory_orb_webhook_total on every event", async () => {
    const db = makeDb();
    await handleOrbWebhook("pull_request", prPayload("closed", true), db);
    await handleOrbWebhook("pull_request", prPayload("closed", true, 8), db);
    expect(await renderMetrics()).toMatch(/gittensory_orb_webhook_total 2/);
  });
});

describe("handleOrbWebhook() — installation events", () => {
  beforeEach(() => { resetMetrics(); process.env.ORB_ENABLED = "true"; });
  afterEach(() => { delete process.env.ORB_ENABLED; });

  it("creates installation records for each repo on 'created' event", async () => {
    const db = makeDb();
    const payload = JSON.stringify({
      action: "created",
      installation: { id: 100 },
      repositories: [{ full_name: "owner/repo-a" }, { full_name: "owner/repo-b" }],
    });
    await handleOrbWebhook("installation", payload, db);
    const { results } = await db.prepare("SELECT repo FROM orb_installations").all<{ repo: string }>();
    expect(results.map((r) => r.repo).sort()).toEqual(["owner/repo-a", "owner/repo-b"]);
  });

  it("marks repos as removed on 'deleted' event by setting removed_at", async () => {
    const db = makeDb();
    const created = JSON.stringify({ action: "created", installation: { id: 100 }, repositories: [{ full_name: "owner/repo" }] });
    await handleOrbWebhook("installation", created, db);
    const deleted = JSON.stringify({ action: "deleted", installation: { id: 100 }, repositories: [{ full_name: "owner/repo" }] });
    await handleOrbWebhook("installation", deleted, db);
    const row = await db.prepare("SELECT removed_at FROM orb_installations WHERE repo='owner/repo'").first<{ removed_at: string | null }>();
    expect(row?.removed_at).not.toBeNull();
  });

  it("handles installation_repositories added event", async () => {
    const db = makeDb();
    const payload = JSON.stringify({
      action: "added",
      installation: { id: 200 },
      repositories_added: [{ full_name: "owner/new-repo" }],
      repositories_removed: [],
    });
    await handleOrbWebhook("installation_repositories", payload, db);
    const row = await db.prepare("SELECT repo FROM orb_installations WHERE repo='owner/new-repo'").first<{ repo: string }>();
    expect(row?.repo).toBe("owner/new-repo");
  });

  it("handles installation_repositories removed event", async () => {
    const db = makeDb();
    await db.prepare("INSERT INTO orb_installations (installation_id, repo) VALUES (?, ?)").bind(200, "owner/gone-repo").run();
    const payload = JSON.stringify({
      action: "removed",
      installation: { id: 200 },
      repositories_added: [],
      repositories_removed: [{ full_name: "owner/gone-repo" }],
    });
    await handleOrbWebhook("installation_repositories", payload, db);
    const row = await db.prepare("SELECT removed_at FROM orb_installations WHERE repo='owner/gone-repo'").first<{ removed_at: string | null }>();
    expect(row?.removed_at).not.toBeNull();
  });

  it("handles installation_repositories removed event with missing repositories_removed field (covers ?? [] branch)", async () => {
    const db = makeDb();
    await db.prepare("INSERT INTO orb_installations (installation_id, repo) VALUES (?, ?)").bind(300, "owner/repo-x").run();
    // No repositories_removed key — falls back to []
    const payload = JSON.stringify({
      action: "removed",
      installation: { id: 300 },
      repositories_added: [],
      // repositories_removed intentionally absent
    });
    const result = await handleOrbWebhook("installation_repositories", payload, db);
    expect(result.status).toBe(204);
    // No rows should be marked removed (empty list was used)
    const row = await db.prepare("SELECT removed_at FROM orb_installations WHERE repo='owner/repo-x'").first<{ removed_at: string | null }>();
    expect(row?.removed_at).toBeNull();
  });

  it("does not increment installs counter when repositories list is empty (covers if(repos.length) false branch)", async () => {
    const db = makeDb();
    const payload = JSON.stringify({ action: "created", installation: { id: 1 }, repositories: [] });
    await handleOrbWebhook("installation", payload, db);
    // Counter must not have been incremented
    expect(await renderMetrics()).not.toMatch(/gittensory_orb_installs_total [^0]/);
  });

  it("handles deleted event when repositories field is absent (covers repositories ?? [] branch)", async () => {
    const db = makeDb();
    await db.prepare("INSERT INTO orb_installations (installation_id, repo) VALUES (?, ?)").bind(400, "owner/to-delete").run();
    // 'deleted' with no repositories key → falls back to []
    const payload = JSON.stringify({ action: "deleted", installation: { id: 400 } });
    const result = await handleOrbWebhook("installation", payload, db);
    expect(result.status).toBe(204);
    // Nothing removed since repos list was empty
    const row = await db.prepare("SELECT removed_at FROM orb_installations WHERE repo='owner/to-delete'").first<{ removed_at: string | null }>();
    expect(row?.removed_at).toBeNull();
  });

  it("increments gittensory_orb_installs_total for each repo installed", async () => {
    const db = makeDb();
    const payload = JSON.stringify({ action: "created", installation: { id: 1 }, repositories: [{ full_name: "o/a" }, { full_name: "o/b" }] });
    await handleOrbWebhook("installation", payload, db);
    expect(await renderMetrics()).toMatch(/gittensory_orb_installs_total 2/);
  });

  it("is idempotent — duplicate install events do not create duplicate rows", async () => {
    const db = makeDb();
    const payload = JSON.stringify({ action: "created", installation: { id: 1 }, repositories: [{ full_name: "o/r" }] });
    await handleOrbWebhook("installation", payload, db);
    await handleOrbWebhook("installation", payload, db);
    const { results } = await db.prepare("SELECT * FROM orb_installations").all();
    expect(results).toHaveLength(1);
  });
});

describe("handleOrbWebhook() — unknown events", () => {
  it("returns 204 for unhandled event types (ping, etc.)", async () => {
    const db = makeDb();
    const result = await handleOrbWebhook("ping", '{"zen":"Keep it logically awesome."}', db);
    expect(result.status).toBe(204);
  });
});
