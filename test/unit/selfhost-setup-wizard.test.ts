import { describe, expect, it, vi } from "vitest";
import { buildManifest, credentialsToEnv, exchangeManifestCode, renderSetupPage } from "../../src/selfhost/setup-wizard";

describe("setup-wizard (#981 GitHub App Manifest)", () => {
  it("builds a manifest with the webhook + redirect URLs, permissions, events", () => {
    const m = buildManifest("https://gt.example.com/");
    expect(m.url).toBe("https://gt.example.com"); // trailing slash trimmed
    expect((m.hook_attributes as { url: string }).url).toBe("https://gt.example.com/v1/github/webhook");
    expect(m.redirect_url).toBe("https://gt.example.com/setup/callback");
    expect((m.default_permissions as Record<string, string>).pull_requests).toBe("write");
    expect(m.default_events).toContain("pull_request");
  });

  it("renders a form that POSTs the manifest to GitHub", () => {
    const html = renderSetupPage("https://gt.example.com");
    expect(html).toContain('action="https://github.com/settings/apps/new"');
    expect(html).toContain('name="manifest"');
    expect(html).toContain("Gittensory Self-Host");
  });

  it("exchanges the code and serializes credentials to .env lines", async () => {
    const fakeFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 42, slug: "gt-sh", webhook_secret: "whsec", pem: "-----BEGIN-----\nk\n-----END-----", client_id: "cid", client_secret: "csec" }), { status: 200 }),
    ) as unknown as typeof fetch;
    const creds = await exchangeManifestCode("the-code", fakeFetch);
    expect(creds.id).toBe(42);
    const env = credentialsToEnv(creds);
    expect(env).toContain("GITHUB_APP_ID=42");
    expect(env).toContain("GITHUB_APP_SLUG=gt-sh");
    expect(env).toContain("GITHUB_WEBHOOK_SECRET=whsec");
    expect(env).toContain("GITHUB_OAUTH_CLIENT_ID=cid");
    expect(env).toMatch(/GITHUB_APP_PRIVATE_KEY=".*BEGIN/);
  });

  it("throws on a non-OK exchange", async () => {
    const fakeFetch = vi.fn(async () => new Response("e", { status: 422 })) as unknown as typeof fetch;
    await expect(exchangeManifestCode("x", fakeFetch)).rejects.toThrow(/manifest_exchange_http_422/);
  });
});
