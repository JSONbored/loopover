// Gittensory Orb (#1219) webhook dispatcher — handles pull_request + installation events
// from the lightweight Orb GitHub App. Verifies HMAC-SHA256 (x-hub-signature-256),
// tracks per-repo installations, and records PR outcome signals on pull_request.closed.

import { createHmac, timingSafeEqual } from "node:crypto";
import { incr } from "./metrics";
import { recordOrbEvent } from "./orb-collector";

/** Verify a GitHub webhook signature (x-hub-signature-256: sha256=<hex>). */
export function verifyOrbSignature(payload: string, sig: string, secret: string): boolean {
  if (!sig.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  const actual = sig.slice("sha256=".length);
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
  } catch {
    return false;
  }
}

/** Look up the most recent gate verdict for a repo+PR from the review_targets table. */
export async function lookupGateVerdict(db: D1Database, repo: string, prNumber: number): Promise<string | null> {
  try {
    const row = await db
      .prepare(`SELECT verdict FROM review_targets WHERE repo = ? AND number = ? ORDER BY updated_at DESC LIMIT 1`)
      .bind(repo, prNumber)
      .first<{ verdict: string | null }>();
    return row?.verdict ?? null;
  } catch {
    return null;
  }
}

interface InstallationPayload {
  action: string;
  installation: { id: number };
  repositories?: Array<{ full_name: string }>;
  repositories_added?: Array<{ full_name: string }>;
  repositories_removed?: Array<{ full_name: string }>;
}

interface PullRequestPayload {
  action: string;
  pull_request: {
    number: number;
    head: { sha: string };
    merged: boolean;
    created_at: string;
    closed_at: string | null;
  };
  repository: { full_name: string };
}

/** Main dispatcher. Returns the HTTP status + body to reply with. */
export async function handleOrbWebhook(
  event: string,
  payload: string,
  db: D1Database,
): Promise<{ status: number; body: string }> {
  incr("gittensory_orb_webhook_total");

  if (event === "installation" || event === "installation_repositories") {
    return handleInstallation(JSON.parse(payload) as InstallationPayload, db);
  }

  if (event === "pull_request") {
    const body = JSON.parse(payload) as PullRequestPayload;
    if (body.action === "closed") return handlePrClosed(body, db);
    return { status: 204, body: "" };
  }

  return { status: 204, body: "" };
}

async function handleInstallation(
  body: InstallationPayload,
  db: D1Database,
): Promise<{ status: number; body: string }> {
  const installationId = body.installation.id;
  const now = new Date().toISOString();

  if (body.action === "created" || body.action === "added") {
    const repos = [...(body.repositories ?? []), ...(body.repositories_added ?? [])];
    for (const r of repos) {
      try {
        await db
          .prepare(`INSERT OR IGNORE INTO orb_installations (installation_id, repo, installed_at) VALUES (?, ?, ?)`)
          .bind(installationId, r.full_name, now)
          .run();
      } catch { /* best-effort — never crash on install tracking */ }
    }
    if (repos.length) incr("gittensory_orb_installs_total", {}, repos.length);
  }

  if (body.action === "deleted" || body.action === "removed") {
    const repos = body.action === "deleted"
      ? (body.repositories ?? [])
      : (body.repositories_removed ?? []);
    for (const r of repos) {
      try {
        await db
          .prepare(`UPDATE orb_installations SET removed_at = ? WHERE installation_id = ? AND repo = ? AND removed_at IS NULL`)
          .bind(now, installationId, r.full_name)
          .run();
      } catch { /* best-effort */ }
    }
  }

  return { status: 204, body: "" };
}

async function handlePrClosed(
  body: PullRequestPayload,
  db: D1Database,
): Promise<{ status: number; body: string }> {
  const repo = body.repository.full_name;
  const prNumber = body.pull_request.number;
  const headSha = body.pull_request.head.sha;
  const outcome: "merged" | "closed" = body.pull_request.merged ? "merged" : "closed";

  const closedMs = body.pull_request.closed_at ? new Date(body.pull_request.closed_at).getTime() : null;
  const createdMs = body.pull_request.created_at ? new Date(body.pull_request.created_at).getTime() : null;
  const timeToCloseMs = closedMs !== null && createdMs !== null ? closedMs - createdMs : undefined;

  const gateVerdict = await lookupGateVerdict(db, repo, prNumber);

  await recordOrbEvent(db, {
    repo,
    pr_number: prNumber,
    head_sha: headSha,
    outcome,
    ...(gateVerdict !== null ? { gate_verdict: gateVerdict } : {}),
    ...(timeToCloseMs !== undefined ? { time_to_close_ms: timeToCloseMs } : {}),
  });

  return { status: 204, body: "" };
}
