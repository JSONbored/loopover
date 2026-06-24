// GitHub App Manifest one-click setup wizard for self-host (#981). On first run (no GITHUB_APP_ID), GET /setup
// renders a form that POSTs an App "manifest" to github.com/settings/apps/new; GitHub creates the App with the
// right permissions/events + webhook URL and redirects back to /setup/callback?code=…, which exchanges the
// code for the App's credentials and writes them to a file the operator loads (then restarts). The routes are
// disabled once an App is configured (server.ts gates on GITHUB_APP_ID), so this can't rebind a live install.

export interface AppCredentials {
  id: number;
  slug: string;
  webhook_secret: string;
  pem: string;
  client_id?: string;
  client_secret?: string;
}

/** The GitHub App manifest — permissions + events mirror docs §2 (the manual-setup instructions). */
export function buildManifest(origin: string): Record<string, unknown> {
  const base = origin.replace(/\/+$/, "");
  return {
    name: "Gittensory Self-Host",
    url: base,
    hook_attributes: { url: `${base}/v1/github/webhook` },
    redirect_url: `${base}/setup/callback`,
    public: false,
    default_permissions: {
      pull_requests: "write",
      contents: "write",
      issues: "write",
      checks: "read",
      metadata: "read",
      statuses: "read",
    },
    default_events: ["pull_request", "pull_request_review", "push", "issues", "check_suite", "check_run", "status"],
  };
}

/** HTML page that POSTs the manifest to GitHub's App-creation flow (one click). */
export function renderSetupPage(origin: string): string {
  const manifest = JSON.stringify(buildManifest(origin)).replace(/'/g, "&#39;");
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

/** Exchange the temporary manifest code for the App's credentials (id, slug, webhook secret, private key). */
export async function exchangeManifestCode(code: string, fetchImpl: typeof fetch = fetch): Promise<AppCredentials> {
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
