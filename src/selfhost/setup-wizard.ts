// GitHub App Manifest one-click setup wizard for self-host (#981). On first run (no GITHUB_APP_ID), GET /setup
// renders a form that POSTs an App "manifest" to github.com/settings/apps/new; GitHub creates the App with the
// right permissions/events + webhook URL and redirects back to /setup/callback?code=…, which exchanges the
// code for the App's credentials and writes them to a file the operator loads (then restarts). The routes are
// disabled once an App is configured (server.ts gates on GITHUB_APP_ID), so this can't rebind a live install.
import { createHmac, timingSafeEqual } from "node:crypto";
import { timeoutFetch } from "../github/client";

export const SETUP_TOKEN_FORM_MAX_BYTES = 4096;

export function setupTokenFormRejection(headers: Headers): Response | undefined {
  const contentLength = headers.get("content-length");
  if (!contentLength) return new Response("setup token form requires Content-Length", { status: 411 });
  const byteLength = Number(contentLength);
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    return new Response("invalid setup token form length", { status: 400 });
  }
  if (byteLength > SETUP_TOKEN_FORM_MAX_BYTES) {
    return new Response("setup token form is too large", { status: 413 });
  }

  const mediaType = headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/x-www-form-urlencoded" && mediaType !== "multipart/form-data") {
    return new Response("unsupported setup token form content type", { status: 415 });
  }
  return undefined;
}

export interface AppCredentials {
  id: number;
  slug: string;
  webhook_secret: string;
  pem: string;
  client_id?: string;
  client_secret?: string;
}

/** The GitHub App manifest — permissions + events mirror docs §2 (the manual-setup instructions). */
export function buildManifest(origin: string, state: string): Record<string, unknown> {
  const base = origin.replace(/\/+$/, "");
  return {
    name: "Gittensory Self-Host",
    url: base,
    hook_attributes: { url: `${base}/v1/github/webhook` },
    redirect_url: `${base}/setup/callback?state=${encodeURIComponent(state)}`,
    public: false,
    default_permissions: {
      pull_requests: "write",
      contents: "write",
      issues: "write",
      // checks:write — the gate posts a check-run (POST /repos/{o}/{r}/check-runs in src/github/app.ts);
      // checks:read would 403 that write (swallowed as a permission_missing warning → silent first-review failure).
      checks: "write",
      metadata: "read",
      statuses: "read",
    },
    default_events: ["pull_request", "pull_request_review", "push", "issues", "check_suite", "check_run", "status"],
  };
}

/** HTML page that POSTs the manifest to GitHub's App-creation flow (one click).
 *  `state` is a random CSRF nonce tied to the session via an HttpOnly cookie in the caller. */
export function renderSetupPage(origin: string, state: string): string {
  const manifest = JSON.stringify(buildManifest(origin, state)).replace(/'/g, "&#39;");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gittensory self-host setup</title></head>
<body style="font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem">
<h1>Gittensory self-host setup</h1>
<p>This creates a GitHub App for your self-host instance. GitHub will redirect back here with the credentials,
which are written to a file for you to load — then restart the container.</p>
<form action="https://github.com/settings/apps/new" method="post">
  <input type="hidden" name="manifest" value='${manifest}'>
  <button type="submit" style="padding:.6rem 1.2rem;font-size:1rem;cursor:pointer">Create GitHub App →</button>
</form>
</body></html>`;
}

/** Setup page shown in BROKERED mode (ORB_ENROLLMENT_SECRET is set): there is no own GitHub App to create —
 *  the central Gittensory Orb App provides installation tokens on demand via the enrollment secret. */
export function renderBrokeredSetupPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gittensory self-host setup</title></head>
<body style="font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem">
<h1>Gittensory self-host — brokered mode</h1>
<p>This instance is configured for the <strong>central Gittensory Orb App</strong> (<code>ORB_ENROLLMENT_SECRET</code> is set), so there is <strong>no GitHub App to create here</strong> — installation tokens are brokered from the Orb on demand.</p>
<p>To onboard: install the Gittensory Orb App on your repositories and complete enrollment to obtain your <code>ORB_ENROLLMENT_SECRET</code>. No further setup is needed on this page.</p>
</body></html>`;
}

/** Signed cookie value proving the setup flow was started by someone who knows the operator token. */
export function setupAuthCookieValue(secret: string, state: string): string {
  const mac = createHmac("sha256", secret).update(state).digest("base64url");
  return `${state}.${mac}`;
}

/** Extract a named cookie value from the Cookie header. */
export function cookieValue(cookieHeader: string, name: string): string | undefined {
  return cookieHeader.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);
}

/** Constant-time string equality (avoids timing side-channels when comparing secrets/tokens). */
export function timingSafeStrEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Validate the signed setup cookie without trusting a client-supplied state alone. */
export function isValidSetupAuthCookie(secret: string, state: string, cookie: string | undefined): boolean {
  if (!cookie) return false;
  return timingSafeStrEqual(cookie, setupAuthCookieValue(secret, state));
}

/** First step of the browser setup flow: a form that POSTs the operator's setup token in the request BODY.
 *  The token is never put in the URL — a query-string secret leaks to access logs, proxies, and history. */
export function renderTokenEntryPage(invalid = false): string {
  const error = invalid ? `<p style="color:#b00">Invalid setup token.</p>\n` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gittensory self-host setup</title></head>
<body style="font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem">
<h1>Gittensory self-host setup</h1>
<p>Enter your <code>SELFHOST_SETUP_TOKEN</code> to continue.</p>
${error}<form action="/setup" method="post">
  <input type="password" name="token" autocomplete="off" autofocus aria-label="Setup token" style="padding:.5rem;font-size:1rem;width:20rem">
  <button type="submit" style="padding:.6rem 1.2rem;font-size:1rem;cursor:pointer">Continue →</button>
</form>
</body></html>`;
}

/** Exchange the temporary manifest code for the App's credentials (id, slug, webhook secret, private key). */
export async function exchangeManifestCode(code: string, fetchImpl: typeof fetch = timeoutFetch): Promise<AppCredentials> {
  const res = await fetchImpl(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json", "user-agent": "gittensory-selfhost" },
  });
  if (!res.ok) throw new Error(`manifest_exchange_http_${res.status}`);
  return (await res.json()) as AppCredentials;
}

/** Serialize the credentials as .env lines for the operator to load. */
export function credentialsToEnv(creds: AppCredentials): string {
  const lines = [
    `GITHUB_APP_ID=${creds.id}`,
    `GITHUB_APP_SLUG=${creds.slug}`,
    `GITHUB_WEBHOOK_SECRET=${creds.webhook_secret}`,
    `GITHUB_APP_PRIVATE_KEY=${JSON.stringify(creds.pem)}`,
  ];
  if (creds.client_id) lines.push(`GITHUB_OAUTH_CLIENT_ID=${creds.client_id}`);
  if (creds.client_secret) lines.push(`GITHUB_OAUTH_CLIENT_SECRET=${creds.client_secret}`);
  return `${lines.join("\n")}\n`;
}
