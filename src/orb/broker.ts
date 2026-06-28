// Gittensory Orb central GitHub App (#1255) — the token-broker. A maintainer's self-hosted container exchanges a
// one-time enrollment secret for short-lived GitHub installation tokens, so it can act on its own repos WITHOUT
// ever holding the Orb App private key (gittensory holds it centrally and mints on demand).
//
// Trust model (das-github-mirror): the OPERATOR is the authority. An enrollment is issued only for an install the
// operator has already opted in (registered=1) via the internal-token-gated POST /v1/internal/orb/enrollments;
// the secret is shown to the operator ONCE and stored only as a SHA-256 hash. The container then presents that
// secret to /v1/orb/token. The minted token's installation_id comes from the enrollment ROW (bound server-side at
// issue time) — never from the request — so a stolen secret for install X can never mint a token for install Y.
// Every path is inert (404) until ORB_BROKER_ENABLED is set. Two issue paths exist: the operator-issued internal
// endpoint here, and maintainer-OAuth SELF-enrollment (src/orb/oauth.ts), which proves the caller is an admin of
// the installation's account server-side before issuing — both bind installation_id at issue time, so the OAuth
// privilege-escalation surface the red-team flagged stays closed.
import { createOpaqueToken, hashToken } from "../auth/security";
import { createOrbInstallationToken } from "./app-auth";

export function isOrbBrokerEnabled(env: Env): boolean {
  return /^(1|true|yes|on)$/i.test(String(env.ORB_BROKER_ENABLED ?? "").trim());
}

export type IssueResult = { enrollId: string; secret: string } | { error: "installation_not_found" | "installation_not_registered" };

/** Mint a one-time enrollment secret for a REGISTERED install. Returns the plaintext secret ONCE (stored only
 *  hashed). Issued by the operator (internal endpoint) OR by a maintainer who proved install-admin via OAuth —
 *  in the latter case the maintainer's GitHub identity is recorded for audit. installation_id is bound here and
 *  read back (never from the request) at token-exchange time, so a secret can never mint a token for another install. */
export async function issueOrbEnrollment(
  env: Env,
  installationId: number,
  maintainer?: { login: string; githubId?: number | null | undefined },
): Promise<IssueResult> {
  const install = await env.DB.prepare("SELECT registered FROM orb_github_installations WHERE installation_id = ?").bind(installationId).first<{ registered: number }>();
  if (!install) return { error: "installation_not_found" };
  if (install.registered !== 1) return { error: "installation_not_registered" };
  const enrollId = createOpaqueToken("orbenr");
  const secret = createOpaqueToken("orbsec");
  await env.DB.prepare(
    `INSERT INTO orb_enrollments (enroll_id, installation_id, maintainer_login, maintainer_github_id, secret_hash, state, authorized_at, enrolled_at)
     VALUES (?, ?, ?, ?, ?, 'enrolled', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  )
    .bind(enrollId, installationId, maintainer?.login ?? null, maintainer?.githubId ?? null, await hashToken(secret))
    .run();
  return { enrollId, secret };
}

export type BrokerResult = { token: string; installationId: number; expiresAt: string } | { error: "invalid_enrollment" | "installation_not_eligible" };

/** The container's token-exchange: a valid enrollment secret → a short-lived installation token for the BOUND
 *  install. installation_id is read from the enrollment row, never the caller; the install must still be
 *  registered=1 and neither suspended nor removed at mint time (the gate is re-checked, not trusted from issue). */
export async function brokerOrbToken(env: Env, secret: string): Promise<BrokerResult> {
  const row = await env.DB
    .prepare("SELECT enroll_id, installation_id, state, revoked_at FROM orb_enrollments WHERE secret_hash = ?")
    .bind(await hashToken(secret))
    .first<{ enroll_id: string; installation_id: number; state: string; revoked_at: string | null }>();
  if (!row || row.state !== "enrolled" || row.revoked_at !== null) return { error: "invalid_enrollment" };
  const install = await env.DB
    .prepare("SELECT registered, suspended_at, removed_at FROM orb_github_installations WHERE installation_id = ?")
    .bind(row.installation_id)
    .first<{ registered: number; suspended_at: string | null; removed_at: string | null }>();
  if (!install || install.registered !== 1 || install.suspended_at !== null || install.removed_at !== null) return { error: "installation_not_eligible" };
  const minted = await createOrbInstallationToken(env, row.installation_id);
  await env.DB.prepare("UPDATE orb_enrollments SET last_token_at = CURRENT_TIMESTAMP WHERE enroll_id = ?").bind(row.enroll_id).run();
  return { token: minted.token, installationId: row.installation_id, expiresAt: minted.expiresAt };
}
