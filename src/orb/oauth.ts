// Gittensory Orb central GitHub App (#1255) — the post-install / OAuth landing endpoint. GitHub redirects here
// after a maintainer installs or updates the Orb App (the App's Callback URL, with OAuth-during-install ON). For
// now it confirms the connection so the install flow lands on a real page instead of a 401; the full OAuth
// code-exchange + container enrollment (the token-broker) layers onto this same endpoint next. Token-EXEMPT —
// GitHub drives the redirect with no API token (see requiresApiToken). No request input is echoed into the
// markup, so there is no injection surface.
import type { Context } from "hono";

function landingPage(heading: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${heading}</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0b0d;color:#e7e7ea;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}.card{max-width:30rem;margin:1.5rem;padding:2.75rem;background:#16161a;border:1px solid #2a2a30;border-radius:14px;text-align:center}h1{font-size:1.35rem;font-weight:600;margin:0 0 .7rem}p{font-size:.95rem;line-height:1.6;color:#a8a8b0;margin:0 0 1.6rem}a{display:inline-block;padding:.6rem 1.4rem;background:#1f6feb;color:#fff;text-decoration:none;border-radius:8px;font-size:.9rem}</style></head><body><div class="card"><h1>${heading}</h1><p>${message}</p><a href="https://gittensory.aethereal.dev">Open the dashboard</a></div></body></html>`;
}

export function handleOrbOAuthCallback(c: Context<{ Bindings: Env }>): Response {
  const updated = c.req.query("setup_action") === "update";
  return c.html(
    updated
      ? landingPage("Gittensory Orb updated", "Your repository selection was updated — the dashboard reflects the change shortly.")
      : landingPage("Gittensory Orb connected", "Your repositories are linked. Their review activity now flows to the global Gittensory dashboard."),
  );
}
