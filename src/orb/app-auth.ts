// Gittensory Orb central GitHub App (#1255) — App authentication. Mints the Orb App JWT (RS256, signed with the
// Orb App's OWN private key), lists the App's installations, and mints short-lived installation tokens. This is
// the token-broker foundation: a maintainer's self-hosted container (after enrollment) exchanges for one of these
// installation tokens to act on its own repos. Modeled on src/github/app.ts (the gittensory review App's auth),
// parameterized to the ORB_GITHUB_* credentials so the two Apps stay isolated.
import { timeoutFetch } from "../github/client";
import { signRs256Jwt } from "../utils/crypto";

function orbHeaders(jwt: string): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${jwt}`,
    "content-type": "application/json",
    "user-agent": "loopover-orb/0.1",
    "x-github-api-version": "2022-11-28",
  };
}

export async function createOrbAppJwt(env: Env): Promise<string> {
  if (!env.ORB_GITHUB_APP_ID || !env.ORB_GITHUB_APP_PRIVATE_KEY) {
    throw new Error("Orb App credentials are not configured.");
  }
  const now = Math.floor(Date.now() / 1000);
  // iat backdated 60s for clock skew; exp at the GitHub max of 10 minutes minus a margin.
  return signRs256Jwt({ iss: env.ORB_GITHUB_APP_ID, iat: now - 60, exp: now + 540 }, env.ORB_GITHUB_APP_PRIVATE_KEY);
}

export interface OrbAppInstallation {
  id: number;
  accountLogin: string | null;
  accountType: string | null;
  accountId: number | null;
  repositorySelection: string | null;
}

/** Lists every installation of the Orb App (paginated). The backfill reads this to recover installs whose
 *  `installation` webhook fired before the receiver's secret was configured. */
export async function listOrbAppInstallations(env: Env): Promise<OrbAppInstallation[]> {
  const jwt = await createOrbAppJwt(env);
  const installs: OrbAppInstallation[] = [];
  for (let page = 1; ; page += 1) {
    const response = await timeoutFetch(`https://api.github.com/app/installations?per_page=100&page=${page}`, { headers: orbHeaders(jwt) });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to list Orb App installations (${response.status}): ${body.slice(0, 200)}`);
    }
    const rows = (await response.json()) as Array<{ id?: number; account?: { login?: string; type?: string; id?: number } | null; repository_selection?: string }>;
    for (const row of rows) {
      if (row.id) installs.push({ id: row.id, accountLogin: row.account?.login ?? null, accountType: row.account?.type ?? null, accountId: row.account?.id ?? null, repositorySelection: row.repository_selection ?? null });
    }
    if (rows.length < 100) break; // short page → last page
    /* v8 ignore next 2 -- runaway-loop backstop: a single App would need 1000+ installs (>10 pages) to reach this */
    if (page >= 10) break;
  }
  return installs;
}

// GitHub's installation-token endpoint can take many seconds while the App is throttled (too-frequent mints). A
// generous timeout lets the rare cold mint complete; brokerOrbToken caches the result so this is hit ~once/hour.
const ORB_TOKEN_MINT_TIMEOUT_MS = 25_000;

/** Mints a short-lived GitHub installation access token for one installation — the broker primitive the
 *  self-hosted container ultimately receives (after enrollment). brokerOrbToken caches the result; this always mints. */
export async function createOrbInstallationToken(env: Env, installationId: number): Promise<{ token: string; expiresAt: string; permissions: Record<string, string> }> {
  const jwt = await createOrbAppJwt(env);
  const response = await timeoutFetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: orbHeaders(jwt),
    signal: AbortSignal.timeout(ORB_TOKEN_MINT_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to create Orb installation token (${response.status}): ${body.slice(0, 200)}`);
  }
  const payload = (await response.json()) as { token?: string; expires_at?: string; permissions?: Record<string, string> };
  if (!payload.token) throw new Error("Orb installation token response did not include a token.");
  // Surface GitHub's real expiry (~1h) so the broker never invents one; absent only on a malformed response.
  return { token: payload.token, expiresAt: payload.expires_at ?? "", permissions: payload.permissions ?? {} };
}
