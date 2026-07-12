// Gittensory Orb central GitHub App (#1255) — the post-install / OAuth landing + maintainer SELF-ENROLLMENT.
// GitHub redirects here after a maintainer installs/authorizes the Orb App (the App's Callback URL, OAuth-during-
// install ON) with an OAuth `code` + the `installation_id`. The maintainer can then self-issue their brokered
// enrollment secret WITHOUT the operator — but ONLY after we prove, server-side, that they are an ADMIN of the
// account the installation belongs to.
//
// SECURITY: the admin-of-installation check is what closes the privilege-escalation hole. `installation_id` is an
// attacker-controllable query param, so a stolen OAuth code paired with a VICTIM's installation_id must NEVER
// enroll the victim's install. We require: a valid OAuth code (single-use, GitHub-issued) → the authenticated
// user → that user is an admin of the install's account (org admin, or the user account owner) → the install is
// active (not suspended/removed) and not operator-disabled. A verified admin AUTO-REGISTERS the install
// (registered=1) — zero-touch, no operator step — and installation_id is then bound server-side in the enrollment
// (read back at token-exchange, never from a request). No request input is echoed into the markup (no injection
// surface).
import type { Context } from "hono";
import { PRODUCT_USER_AGENT, timeoutFetch } from "../github/client";
import { GITTENSORY_SITE_URL } from "../github/footer";
import { isOrbBrokerEnabled, issueOrbEnrollment } from "./broker";

type GitHubUser = { login: string; id?: number };
type GitHubOrgMembership = { role?: string; state?: string; organization?: { id?: number } };

/** Exchange the OAuth code for the maintainer's access token using the ORB App's OAuth credentials. Null when the
 *  credentials aren't configured or GitHub returns no token. */
export async function exchangeOrbOAuthCode(env: Env, code: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (!env.ORB_GITHUB_CLIENT_ID || !env.ORB_GITHUB_CLIENT_SECRET) return null;
  const res = await fetchImpl("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: env.ORB_GITHUB_CLIENT_ID, client_secret: env.ORB_GITHUB_CLIENT_SECRET, code }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string };
  return body.access_token ?? null;
}

/** Identify the authenticated maintainer (GET /user with their token). Null on any non-OK / loginless response. */
export async function fetchOrbOAuthUser(token: string, fetchImpl: typeof fetch = timeoutFetch): Promise<GitHubUser | null> {
  const res = await fetchImpl("https://api.github.com/user", {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": PRODUCT_USER_AGENT },
  });
  const user = (await res.json().catch(() => ({}))) as GitHubUser;
  return res.ok && user.login ? user : null;
}

/** CRITICAL admin-of-installation check — the gate that closes the privilege-escalation hole. The maintainer must
 *  be an ADMIN of the account the installation belongs to: for a User install they must BE that account owner;
 *  for an Org install they must be an ACTIVE org ADMIN (checked against their OWN membership, requires read:org).
 *  Anything else (member, non-member, unknown account, API error) → false. */
export async function verifyInstallationAdmin(
  token: string,
  userLogin: string,
  userId: number | null | undefined,
  accountLogin: string | null,
  accountType: string | null,
  accountId: number | null,
  fetchImpl: typeof fetch = timeoutFetch,
): Promise<boolean> {
  if (!accountLogin || accountId === null) return false;
  if (accountType !== "Organization") {
    return userId === accountId && userLogin.toLowerCase() === accountLogin.toLowerCase();
  }
  const res = await fetchImpl(`https://api.github.com/user/memberships/orgs/${encodeURIComponent(accountLogin)}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": PRODUCT_USER_AGENT },
  });
  if (!res.ok) return false;
  const body = (await res.json().catch(() => ({}))) as GitHubOrgMembership;
  return body.state === "active" && body.role === "admin" && body.organization?.id === accountId;
}

async function handleOrbEnrollment(c: Context<{ Bindings: Env }>, code: string, installationId: number): Promise<Response> {
  const token = await exchangeOrbOAuthCode(c.env, code);
  if (!token) return c.html(landingPage(c.env, "Couldn't verify your GitHub identity", "The authorization didn't complete — re-run the install from GitHub and try again."), 400);
  const user = await fetchOrbOAuthUser(token);
  if (!user) return c.html(landingPage(c.env, "Couldn't verify your GitHub identity", "We couldn't read your GitHub account — try the install again."), 400);
  const install = await c.env.DB.prepare("SELECT account_login, account_type, account_id, registered, self_enrollment_disabled, suspended_at, removed_at FROM orb_github_installations WHERE installation_id = ?")
    .bind(installationId)
    .first<{ account_login: string | null; account_type: string | null; account_id: number | null; registered: number; self_enrollment_disabled: number; suspended_at: string | null; removed_at: string | null }>();
  if (!install) return c.html(landingPage(c.env, "Installation not recognized", "We haven't recorded this installation yet — give it a moment after installing, then retry."), 404);
  // The admin-of-installation check is the authorization gate — it runs BEFORE we reveal or change any state, so a
  // non-admin learns nothing about the install and can never enroll someone else's. It binds to the immutable
  // GitHub account id (logins can be renamed/reused), so a stale account_login can never grant access.
  const isAdmin = await verifyInstallationAdmin(token, user.login, user.id, install.account_login, install.account_type, install.account_id);
  if (!isAdmin) return c.html(landingPage(c.env, "Admin access required", "You must be an admin of this installation's account to enroll it for self-host."), 403);
  if (install.removed_at !== null || install.suspended_at !== null) return c.html(landingPage(c.env, "Installation not active", "This installation is suspended or uninstalled — re-install the Orb App, then retry."), 403);
  if (install.self_enrollment_disabled === 1) return c.html(landingPage(c.env, "Installation disabled", "This installation was disabled by the operator — contact the operator to re-enable self-host enrollment."), 403);
  // Zero-touch self-service: a verified admin of an ACTIVE, non-disabled install self-registers it (registered=1).
  // installation_id stays bound server-side in the enrollment, so brokered tokens remain scoped to this install.
  if (install.registered !== 1) {
    await c.env.DB.prepare("UPDATE orb_github_installations SET registered = 1, last_event_at = CURRENT_TIMESTAMP WHERE installation_id = ?").bind(installationId).run();
  }
  const result = await issueOrbEnrollment(c.env, installationId, { login: user.login, githubId: user.id ?? null });
  /* v8 ignore next -- defensive: the existence + admin + active checks above passed and we just set registered=1, so
     issueOrbEnrollment (which re-checks existence + registered) cannot return an error here; kept to degrade safely. */
  if ("error" in result) return c.html(landingPage(c.env, "Couldn't issue an enrollment", "Please retry, or contact the operator."), 409);
  return c.html(secretPage(result.secret));
}

export async function handleOrbOAuthCallback(c: Context<{ Bindings: Env }>): Promise<Response> {
  const code = c.req.query("code");
  const installationId = Number(c.req.query("installation_id"));
  // Self-enrollment: a maintainer authorized with an OAuth code + an installation_id, and the broker is enabled.
  if (code && Number.isInteger(installationId) && installationId > 0 && isOrbBrokerEnabled(c.env)) {
    return handleOrbEnrollment(c, code, installationId);
  }
  const updated = c.req.query("setup_action") === "update";
  return c.html(
    updated
      ? landingPage(c.env, "Gittensory Orb updated", "Your repository selection was updated — the dashboard reflects the change shortly.")
      : landingPage(c.env, "Gittensory Orb connected", "Your repositories are linked. Their review activity now flows to the global Gittensory dashboard."),
  );
}

function shell(heading: string, inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${heading}</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0b0d;color:#e7e7ea;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}.card{max-width:34rem;margin:1.5rem;padding:2.75rem;background:#16161a;border:1px solid #2a2a30;border-radius:14px;text-align:center}h1{font-size:1.35rem;font-weight:600;margin:0 0 .7rem}p{font-size:.95rem;line-height:1.6;color:#a8a8b0;margin:0 0 1.6rem}a{display:inline-block;padding:.6rem 1.4rem;background:#1f6feb;color:#fff;text-decoration:none;border-radius:8px;font-size:.9rem}code{background:#0b0b0d;border:1px solid #2a2a30;border-radius:6px;padding:.15rem .4rem;font-size:.85rem}pre{background:#0b0b0d;border:1px solid #2a2a30;border-radius:8px;padding:1rem;overflow:auto;text-align:left;color:#7ee787;font-size:.9rem;user-select:all}</style></head><body><div class="card"><h1>${heading}</h1>${inner}</div></body></html>`;
}

// The Orb App itself stays a single centrally-hosted hub (broker.ts: gittensory holds the App key centrally
// and mints tokens on demand) -- that part is architecturally fixed. This link is just where the browser lands
// after OAuth, so it follows the SAME self-hoster-configurable pattern as maintainerControlPanelUrl one
// file-family over (github/footer.ts): env.PUBLIC_SITE_ORIGIN when set, else the public gittensory dashboard
// (#4615).
function landingPage(env: Env, heading: string, message: string): string {
  const dashboardOrigin = (env.PUBLIC_SITE_ORIGIN ?? GITTENSORY_SITE_URL).replace(/\/$/, "");
  return shell(heading, `<p>${message}</p><a href="${dashboardOrigin}">Open the dashboard</a>`);
}

/** Show the freshly-issued enrollment secret ONCE. The secret is a generated opaque token (no user input), safe
 *  to embed; it is never logged. */
function secretPage(secret: string): string {
  return shell(
    "Your enrollment secret",
    `<p>Set this as <code>ORB_ENROLLMENT_SECRET</code> in your self-host <code>.env</code>, then restart the container. It is shown <strong>once</strong> — store it now.</p><pre>${secret}</pre>`,
  );
}
