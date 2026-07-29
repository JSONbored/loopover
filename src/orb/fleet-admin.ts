// Fleet administration, extracted from the `/v1/internal/orb/*` route handlers (#9522).
//
// These lived inline in src/api/routes.ts, which was fine while HTTP was the only transport. The MCP fleet
// tools are a second transport over the same capabilities, and #9522 requires one implementation behind
// both -- a copy in the tool handler is exactly how the two would drift into two behaviors with one audit
// trail between them. The routes now call these too, so the extraction is a move, not a fork.
import { createOpaqueToken, hashToken } from "../auth/security";

export type FleetInstance = {
  instanceId: string;
  registered: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  registeredAt: string | null;
  signalCount: number;
};

/** Every instance that has ingested signals, most recently active first. */
export async function listFleetInstances(env: Env): Promise<{ instances: FleetInstance[] }> {
  const rows = await env.DB.prepare(
    `SELECT i.instance_id AS instanceId, i.registered AS registered, i.first_seen_at AS firstSeenAt,
            i.last_seen_at AS lastSeenAt, i.registered_at AS registeredAt,
            (SELECT COUNT(*) FROM orb_signals s WHERE s.instance_id = i.instance_id) AS signalCount
     FROM orb_instances i ORDER BY i.last_seen_at DESC`,
  ).all<{ instanceId: string; registered: number; firstSeenAt: string; lastSeenAt: string; registeredAt: string | null; signalCount: number }>();
  return { instances: (rows.results ?? []).map((row) => ({ ...row, registered: row.registered === 1 })) };
}

export type RegisterFleetInstanceResult = { instanceId: string; registered: boolean; instanceSecret?: string };

/**
 * Opt an instance into (or out of) fleet calibration, upserting so an operator can register an instance
 * that has ingested but was never recorded.
 *
 * #9121: registering ALSO mints a fresh per-instance ingest credential -- "registered" can only mean
 * something on the risk-control write path if the identity it trusts is proven by a secret only the real
 * instance holds, rather than merely claimed in the request body. The plaintext is returned ONCE and only
 * its hash is persisted, so a repeat register call ROTATES it and invalidates the previous value.
 */
export async function registerFleetInstance(env: Env, input: { instanceId: string; registered?: boolean }): Promise<RegisterFleetInstanceResult> {
  const registered = input.registered === false ? 0 : 1;
  const instanceSecret = registered === 1 ? createOpaqueToken("orbis") : null;
  const instanceSecretHash = instanceSecret ? await hashToken(instanceSecret) : null;
  await env.DB.prepare(
    `INSERT INTO orb_instances (instance_id, registered, registered_at, ingest_secret_hash) VALUES (?, ?, CURRENT_TIMESTAMP, ?)
     ON CONFLICT(instance_id) DO UPDATE SET registered = excluded.registered,
       registered_at = CASE WHEN excluded.registered = 1 THEN CURRENT_TIMESTAMP ELSE NULL END,
       ingest_secret_hash = CASE WHEN excluded.registered = 1 THEN excluded.ingest_secret_hash ELSE orb_instances.ingest_secret_hash END`,
  )
    .bind(input.instanceId, registered, instanceSecretHash)
    .run();
  return { instanceId: input.instanceId, registered: registered === 1, ...(instanceSecret ? { instanceSecret } : {}) };
}

export type FleetInstallation = { installationId: number; registered: boolean };

/** The central Orb App installation registry -- the onboarding gate, with each install's live enrollment count. */
export async function listFleetInstallations(env: Env): Promise<{ installations: Record<string, unknown>[] }> {
  const rows = await env.DB.prepare(
    `SELECT installation_id AS installationId, account_login AS accountLogin, account_type AS accountType,
            repository_selection AS repositorySelection, registered, suspended_at AS suspendedAt,
            removed_at AS removedAt, first_seen_at AS firstSeenAt, last_event_at AS lastEventAt,
            (SELECT COUNT(*) FROM orb_enrollments oe WHERE oe.installation_id = orb_github_installations.installation_id AND oe.state = 'enrolled' AND oe.revoked_at IS NULL) AS liveEnrollmentCount
     FROM orb_github_installations ORDER BY last_event_at DESC`,
  ).all<{ registered: number } & Record<string, unknown>>();
  return { installations: (rows.results ?? []).map((row) => ({ ...row, registered: row.registered === 1 })) };
}

export type RegisterFleetInstallationResult = { installationId: number; registered: boolean } | { error: "installation_not_found" };

/**
 * Flip an already-recorded installation's registration. Deliberately refuses an UNKNOWN installation
 * instead of inserting one: the webhook is what records an install, and letting an operator conjure a row
 * here would register an installation the App may not actually hold.
 */
export async function registerFleetInstallation(env: Env, input: { installationId: number; registered?: boolean }): Promise<RegisterFleetInstallationResult> {
  const existing = await env.DB.prepare("SELECT installation_id FROM orb_github_installations WHERE installation_id = ?").bind(input.installationId).first();
  if (!existing) return { error: "installation_not_found" };
  const registered = input.registered === false ? 0 : 1;
  await env.DB.prepare("UPDATE orb_github_installations SET registered = ?, self_enrollment_disabled = ? WHERE installation_id = ?")
    .bind(registered, registered === 1 ? 0 : 1, input.installationId)
    .run();
  return { installationId: input.installationId, registered: registered === 1 };
}
