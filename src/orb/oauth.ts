// LoopOver Orb central GitHub App (#1255) — the post-install / OAuth landing + maintainer SELF-ENROLLMENT.
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
import { LOOPOVER_SITE_URL } from "../github/footer";
import { countLiveEnrollmentsForInstallation, isOrbBrokerEnabled, issueOrbEnrollment, ORB_SECRET_TYPE_GITHUB_TOKEN, revokeAllLiveEnrollmentsForInstallation } from "./broker";

type GitHubUser = { login: string; id?: number };
type GitHubOrgMembership = { role?: string; state?: string; organization?: { id?: number } };

/** Exchange the OAuth code for the maintainer's access token using the ORB App's OAuth credentials. Null when the
 *  credentials aren't configured or GitHub returns no token. */
export async function exchangeOrbOAuthCode(env: Env, code: string, fetchImpl: typeof fetch = timeoutFetch): Promise<string | null> {
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

/** What a maintainer landing on the OAuth callback is asking to do, and which installation it's bound to.
 *  `installation_id` normally comes from the GitHub-controlled query string (the install/update Setup-URL
 *  redirect); `rotate`/`revoke` have no such channel (GitHub only ever echoes back `code` + `state` on a bare
 *  `login/oauth/authorize` bounce, not arbitrary query params we didn't put there ourselves), so those two
 *  actions are carried in `state` instead, as `"<installationId>:rotate"` / `"<installationId>:revoke"` (#9149)
 *  — the value {@link orbOAuthAuthorizeUrl} puts in the "Rotate" / "Revoke all" links on the secret page. */
type OrbOAuthIntent = { installationId: number | null; action: "enroll" | "rotate" | "revoke" };

function parseOAuthState(raw: string | undefined): OrbOAuthIntent {
  if (!raw) return { installationId: null, action: "enroll" };
  const [idPart, actionPart] = raw.split(":");
  const parsedId = Number(idPart);
  const installationId = Number.isInteger(parsedId) && parsedId > 0 ? parsedId : null;
  const action = actionPart === "rotate" ? "rotate" : actionPart === "revoke" ? "revoke" : "enroll";
  return { installationId, action };
}

/** A `login/oauth/authorize` link that lands the maintainer back on THIS SAME callback with a fresh, single-
 *  use `code` and `state=<installationId>:<action>` (#9149) — the only way to re-prove admin-of-installation
 *  for a rotate/revoke action without our own persisted maintainer session. Null when the client id isn't
 *  configured (broker effectively unusable anyway), so the caller can omit the link entirely rather than
 *  point at a URL that can never work. */
function orbOAuthAuthorizeUrl(env: Env, installationId: number, action: "rotate" | "revoke"): string | null {
  /* v8 ignore next 2 -- defensive: every caller of this function is already past exchangeOrbOAuthCode, which
     itself returns null (→ the identity-error page, never reaching secretPage) without ORB_GITHUB_CLIENT_ID
     set — so this branch can't be live-reached through the real callback flow. Kept so a future change that
     loosens that upstream guard degrades to an omitted link rather than a broken one. */
  if (!env.ORB_GITHUB_CLIENT_ID) return null;
  const params = new URLSearchParams({ client_id: env.ORB_GITHUB_CLIENT_ID, state: `${installationId}:${action}` });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

async function handleOrbEnrollment(c: Context<{ Bindings: Env }>, code: string, installationId: number, action: "enroll" | "rotate" | "revoke" = "enroll"): Promise<Response> {
  // A thrown network error (DNS failure, or a timeout past timeoutFetch's own retry budget) from any of the three
  // GitHub calls below degrades to the same clean landing page a bad HTTP *response* already produces, instead of
  // escaping handleOrbOAuthCallback as an uncaught framework 500. Mirrors the failure-doesn't-escape convention in
  // webhook.ts/relay.ts/ingest.ts. The calls stay separate (not one body-wide wrapper) so a throw is never confused
  // with a DB/broker fault after identity is established.
  const identityError = () => c.html(landingPage(c.env, "Couldn't verify your GitHub identity", "We couldn't reach GitHub to verify your identity — try the install again."), 400);
  let token: string | null;
  try {
    token = await exchangeOrbOAuthCode(c.env, code);
  } catch {
    return identityError();
  }
  if (!token) return c.html(landingPage(c.env, "Couldn't verify your GitHub identity", "The authorization didn't complete — re-run the install from GitHub and try again."), 400);
  let user: GitHubUser | null;
  try {
    user = await fetchOrbOAuthUser(token);
  } catch {
    return identityError();
  }
  if (!user) return c.html(landingPage(c.env, "Couldn't verify your GitHub identity", "We couldn't read your GitHub account — try the install again."), 400);
  const install = await c.env.DB.prepare("SELECT account_login, account_type, account_id, registered, self_enrollment_disabled, suspended_at, removed_at FROM orb_github_installations WHERE installation_id = ?")
    .bind(installationId)
    .first<{ account_login: string | null; account_type: string | null; account_id: number | null; registered: number; self_enrollment_disabled: number; suspended_at: string | null; removed_at: string | null }>();
  if (!install) return c.html(landingPage(c.env, "Installation not recognized", "We haven't recorded this installation yet — give it a moment after installing, then retry."), 404);
  // The admin-of-installation check is the authorization gate — it runs BEFORE we reveal or change any state, so a
  // non-admin learns nothing about the install and can never enroll someone else's. It binds to the immutable
  // GitHub account id (logins can be renamed/reused), so a stale account_login can never grant access.
  let isAdmin: boolean;
  try {
    isAdmin = await verifyInstallationAdmin(token, user.login, user.id, install.account_login, install.account_type, install.account_id);
  } catch {
    return identityError();
  }
  if (!isAdmin) return c.html(landingPage(c.env, "Admin access required", "You must be an admin of this installation's account to enroll it for self-host."), 403);
  // #9149: a REVOKE request skips the active/disabled checks below on purpose — a maintainer revoking a
  // leaked secret must be able to do so EVEN ON an installation the operator has since suspended or disabled;
  // there is no reason unrelated administrative state should block someone locking down their own credential.
  // It also never touches `registered` (no auto-registration side effect for a request that isn't enrolling).
  if (action === "revoke") {
    const revokedCount = await revokeAllLiveEnrollmentsForInstallation(c.env, installationId);
    return c.html(revokedPage(revokedCount));
  }
  if (install.removed_at !== null || install.suspended_at !== null) return c.html(landingPage(c.env, "Installation not active", "This installation is suspended or uninstalled — re-install the Orb App, then retry."), 403);
  if (install.self_enrollment_disabled === 1) return c.html(landingPage(c.env, "Installation disabled", "This installation was disabled by the operator — contact the operator to re-enable self-host enrollment."), 403);
  // Zero-touch self-service: a verified admin of an ACTIVE, non-disabled install self-registers it (registered=1).
  // installation_id stays bound server-side in the enrollment, so brokered tokens remain scoped to this install.
  if (install.registered !== 1) {
    await c.env.DB.prepare("UPDATE orb_github_installations SET registered = 1, last_event_at = CURRENT_TIMESTAMP WHERE installation_id = ?").bind(installationId).run();
  }
  const result = await issueOrbEnrollment(c.env, installationId, { login: user.login, githubId: user.id ?? null }, ORB_SECRET_TYPE_GITHUB_TOKEN, { rotate: action === "rotate" });
  /* v8 ignore next -- defensive: the existence + admin + active checks above passed and we just set registered=1, so
     issueOrbEnrollment (which re-checks existence + registered) cannot return an error here; kept to degrade safely. */
  if ("error" in result) return c.html(landingPage(c.env, "Couldn't issue an enrollment", "Please retry, or contact the operator."), 409);
  const liveCount = await countLiveEnrollmentsForInstallation(c.env, installationId);
  c.header("Cache-Control", "no-store"); // #9149: this response body is a plaintext secret shown exactly once — never cacheable
  return c.html(secretPage(c.env, result.secret, installationId, liveCount));
}

export async function handleOrbOAuthCallback(c: Context<{ Bindings: Env }>): Promise<Response> {
  const code = c.req.query("code");
  // #9149: installation_id normally arrives in the query string (GitHub's own install/update Setup-URL
  // redirect); a rotate/revoke request instead carries it inside `state` (see parseOAuthState's doc comment
  // for why) — the query value, when itself valid, still wins, so a genuine install/update redirect is never
  // second-guessed by a stray/malformed `state`.
  const state = parseOAuthState(c.req.query("state"));
  const rawInstallationId = Number(c.req.query("installation_id"));
  const queryInstallationId = Number.isInteger(rawInstallationId) && rawInstallationId > 0 ? rawInstallationId : null;
  const installationId = queryInstallationId ?? state.installationId;
  // Self-enrollment (or a rotate/revoke of one): a maintainer authorized with an OAuth code + a resolved
  // installation_id, and the broker is enabled.
  if (code && installationId !== null && isOrbBrokerEnabled(c.env)) {
    return handleOrbEnrollment(c, code, installationId, state.action);
  }
  const updated = c.req.query("setup_action") === "update";
  return c.html(
    updated
      ? landingPage(c.env, "LoopOver Orb updated", "Your repository selection was updated — the dashboard reflects the change shortly.")
      : landingPage(c.env, "LoopOver Orb connected", "Your repositories are linked. Their review activity now flows to the global LoopOver dashboard."),
  );
}

function shell(heading: string, inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${heading}</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0b0d;color:#e7e7ea;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}.card{max-width:34rem;margin:1.5rem;padding:2.75rem;background:#16161a;border:1px solid #2a2a30;border-radius:14px;text-align:center}h1{font-size:1.35rem;font-weight:600;margin:0 0 .7rem}p{font-size:.95rem;line-height:1.6;color:#a8a8b0;margin:0 0 1.6rem}a{display:inline-block;padding:.6rem 1.4rem;background:#1f6feb;color:#fff;text-decoration:none;border-radius:8px;font-size:.9rem}code{background:#0b0b0d;border:1px solid #2a2a30;border-radius:6px;padding:.15rem .4rem;font-size:.85rem}pre{background:#0b0b0d;border:1px solid #2a2a30;border-radius:8px;padding:1rem;overflow:auto;text-align:left;color:#7ee787;font-size:.9rem;user-select:all}</style></head><body><div class="card"><h1>${heading}</h1>${inner}</div></body></html>`;
}

// The Orb App itself stays a single centrally-hosted hub (broker.ts: loopover holds the App key centrally
// and mints tokens on demand) -- that part is architecturally fixed. This link is just where the browser lands
// after OAuth, so it follows the SAME self-hoster-configurable pattern as maintainerControlPanelUrl one
// file-family over (github/footer.ts): env.PUBLIC_SITE_ORIGIN when set, else the public loopover dashboard
// (#4615).
function landingPage(env: Env, heading: string, message: string): string {
  const dashboardOrigin = (env.PUBLIC_SITE_ORIGIN ?? LOOPOVER_SITE_URL).replace(/\/$/, "");
  return shell(heading, `<p>${message}</p><a href="${dashboardOrigin}">Open the dashboard</a>`);
}

/** Show the freshly-issued enrollment secret ONCE. The secret is a generated opaque token (no user input), safe
 *  to embed; it is never logged. #9149: also surfaces how many enrollments are now live for this installation
 *  (an operator/maintainer previously had no way to see this had accumulated) and, when the client id is
 *  configured, links to re-authorize with a `state`-carried rotate/revoke intent (see orbOAuthAuthorizeUrl) —
 *  a self-hoster otherwise had no reachable path to either action at all. `installationId` is never
 *  user-supplied at render time (bound server-side, same as the enrollment itself), so it is safe to embed. */
function secretPage(env: Env, secret: string, installationId: number, liveCount: number): string {
  const rotateUrl = orbOAuthAuthorizeUrl(env, installationId, "rotate");
  const revokeUrl = orbOAuthAuthorizeUrl(env, installationId, "revoke");
  const manageSection =
    rotateUrl && revokeUrl
      ? `<p>This installation now has <strong>${liveCount}</strong> live enrollment secret${liveCount === 1 ? "" : "s"}, including this one. <a href="${rotateUrl}">Rotate</a> (revokes every other one and issues this as the only valid secret) or <a href="${revokeUrl}">revoke all</a> if you no longer need self-host access for this installation.</p>`
      : "";
  return shell(
    "Your enrollment secret",
    `<p>Set this as <code>ORB_ENROLLMENT_SECRET</code> in your self-host <code>.env</code>, then restart the container. It is shown <strong>once</strong> — store it now.</p><pre>${secret}</pre>${manageSection}`,
  );
}

/** Confirms a revoke-all action (#9149) — the self-hoster-reachable counterpart to secretPage. `count` is
 *  never user-supplied (it's the return of revokeAllLiveEnrollmentsForInstallation), so it's safe to embed. */
function revokedPage(count: number): string {
  const plural = count === 1 ? "secret has" : "secrets have";
  return shell(
    "Enrollment secrets revoked",
    `<p><strong>${count}</strong> live enrollment ${plural} been revoked for this installation. Any self-hosted container still using ${count === 1 ? "it" : "one of them"} loses broker access immediately. Re-run the install flow to issue a new one.</p>`,
  );
}
