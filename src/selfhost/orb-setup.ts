// Gittensory Orb (#1219) setup wizard. Mirrors setup-wizard.ts but for the lightweight
// "Gittensory Orb" GitHub App — pull_requests:read + metadata:read + pull_request +
// installation events only. Creates a separate App so operators can install Orb
// independently of the main review App, and revoke data collection without touching reviews.
//
// Routes (server.ts): GET /orb/setup → form page; GET /orb/setup/callback → exchange code.

export interface OrbCredentials {
  id: number;
  slug: string;
  webhook_secret: string;
  pem: string;
}

/** Minimal Orb App manifest — read-only permissions, no write capabilities. */
export function buildOrbManifest(origin: string, state: string): Record<string, unknown> {
  const base = origin.replace(/\/+$/, "");
  return {
    name: "Gittensory Orb",
    url: base,
    hook_attributes: { url: `${base}/orb/webhook` },
    redirect_url: `${base}/orb/setup/callback?state=${encodeURIComponent(state)}`,
    public: false,
    default_permissions: {
      pull_requests: "read",
      metadata: "read",
    },
    default_events: ["pull_request", "installation", "installation_repositories"],
  };
}

/** HTML page with a single button that POSTs the manifest to GitHub's App-creation flow. */
export function renderOrbSetupPage(origin: string, state: string): string {
  const manifest = JSON.stringify(buildOrbManifest(origin, state)).replace(/'/g, "&#39;");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gittensory Orb setup</title></head>
<body style="font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem">
<h1>Gittensory Orb setup</h1>
<p>This creates a lightweight read-only GitHub App that observes PR outcomes for local calibration
and optional aggregate telemetry. Install it on the same repositories as your main Gittensory App.
GitHub will redirect back here with the credentials — then restart the container to activate collection.</p>
<form action="https://github.com/settings/apps/new" method="post">
  <input type="hidden" name="manifest" value='${manifest}'>
  <button type="submit" style="padding:.6rem 1.2rem;font-size:1rem;cursor:pointer">Create Gittensory Orb App →</button>
</form>
</body></html>`;
}

/** Exchange a one-time manifest code (from GitHub's callback) for the App's credentials. */
export async function exchangeOrbManifestCode(code: string, fetchImpl: typeof fetch = fetch): Promise<OrbCredentials> {
  const res = await fetchImpl(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json", "user-agent": "gittensory-selfhost" },
  });
  if (!res.ok) throw new Error(`orb_manifest_exchange_http_${res.status}`);
  return (await res.json()) as OrbCredentials;
}

/** Serialize Orb credentials as env-file lines for the operator to load. */
export function orbCredentialsToEnv(creds: OrbCredentials): string {
  return [
    `ORB_APP_ID=${creds.id}`,
    `ORB_APP_SLUG=${creds.slug}`,
    `ORB_WEBHOOK_SECRET=${creds.webhook_secret}`,
    `ORB_PRIVATE_KEY=${JSON.stringify(creds.pem)}`,
  ].join("\n") + "\n";
}
