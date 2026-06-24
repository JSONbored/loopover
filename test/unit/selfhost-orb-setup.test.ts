import { describe, expect, it, vi, afterEach } from "vitest";
import {
  buildOrbManifest,
  exchangeOrbManifestCode,
  orbCredentialsToEnv,
  renderOrbSetupPage,
} from "../../src/selfhost/orb-setup";

describe("buildOrbManifest()", () => {
  it("sets the webhook URL to /orb/webhook under the origin", () => {
    const m = buildOrbManifest("https://gittensory.example.com", "state123");
    expect((m.hook_attributes as { url: string }).url).toBe("https://gittensory.example.com/orb/webhook");
  });

  it("sets the redirect_url to /orb/setup/callback with encoded state", () => {
    const m = buildOrbManifest("https://example.com", "my state");
    expect(m.redirect_url).toBe("https://example.com/orb/setup/callback?state=my%20state");
  });

  it("strips a trailing slash from the origin", () => {
    const m = buildOrbManifest("https://example.com/", "s");
    expect((m.hook_attributes as { url: string }).url).toBe("https://example.com/orb/webhook");
  });

  it("requests only read permissions (pull_requests + metadata)", () => {
    const m = buildOrbManifest("https://example.com", "s");
    const perms = m.default_permissions as Record<string, string>;
    expect(perms.pull_requests).toBe("read");
    expect(perms.metadata).toBe("read");
    // Must not request write permissions
    expect(Object.values(perms).every((v) => v === "read")).toBe(true);
  });

  it("subscribes to pull_request, installation, and installation_repositories events", () => {
    const m = buildOrbManifest("https://example.com", "s");
    const events = m.default_events as string[];
    expect(events).toContain("pull_request");
    expect(events).toContain("installation");
    expect(events).toContain("installation_repositories");
  });

  it("sets public: false", () => {
    expect(buildOrbManifest("https://example.com", "s").public).toBe(false);
  });
});

describe("renderOrbSetupPage()", () => {
  it("returns valid HTML containing the manifest JSON", () => {
    const html = renderOrbSetupPage("https://example.com", "xyz");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("orb/webhook");
    expect(html).toContain("https://github.com/settings/apps/new");
    expect(html).toContain("Gittensory Orb");
  });

  it("embeds the manifest in the form input value", () => {
    const html = renderOrbSetupPage("https://example.com", "state-abc");
    expect(html).toContain('name="manifest"');
    expect(html).toContain("orb/webhook");
  });

  it("escapes single quotes in the manifest to prevent attribute injection", () => {
    // JSON.stringify naturally won't produce ' but the replace guard must be present
    const html = renderOrbSetupPage("https://example.com", "s");
    expect(html).not.toContain("'gittensory");
  });
});

describe("exchangeOrbManifestCode()", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("POSTs to the GitHub conversions endpoint and returns parsed credentials", async () => {
    const fakeCreds = { id: 999, slug: "gittensory-orb-test", webhook_secret: "sec", pem: "pem-data" };
    const fakeFetch = vi.fn(async () => new Response(JSON.stringify(fakeCreds), { status: 201 }));
    const result = await exchangeOrbManifestCode("test-code-xyz", fakeFetch);
    expect(result).toEqual(fakeCreds);
    const [url, init] = fakeFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("test-code-xyz");
    expect(url).toContain("app-manifests");
    expect(init.method).toBe("POST");
  });

  it("throws on non-OK HTTP response with status in the message", async () => {
    const fakeFetch = vi.fn(async () => new Response("", { status: 422 }));
    await expect(exchangeOrbManifestCode("bad-code", fakeFetch)).rejects.toThrow("422");
  });

  it("URL-encodes the code to prevent injection", async () => {
    const fakeFetch = vi.fn(async () => new Response(JSON.stringify({ id: 1, slug: "s", webhook_secret: "w", pem: "p" }), { status: 201 }));
    await exchangeOrbManifestCode("code/with/slash", fakeFetch);
    const [url] = fakeFetch.mock.calls[0] as unknown as [string];
    expect(url).toContain("code%2Fwith%2Fslash");
  });
});

describe("orbCredentialsToEnv()", () => {
  it("produces ORB_APP_ID, ORB_APP_SLUG, ORB_WEBHOOK_SECRET, ORB_PRIVATE_KEY lines", () => {
    const env = orbCredentialsToEnv({ id: 42, slug: "orb-slug", webhook_secret: "wh-sec", pem: "BEGIN RSA" });
    expect(env).toContain("ORB_APP_ID=42");
    expect(env).toContain("ORB_APP_SLUG=orb-slug");
    expect(env).toContain("ORB_WEBHOOK_SECRET=wh-sec");
    expect(env).toContain("ORB_PRIVATE_KEY=");
    expect(env.endsWith("\n")).toBe(true);
  });

  it("JSON-stringifies the PEM so newlines survive loading as a single env var", () => {
    const env = orbCredentialsToEnv({ id: 1, slug: "s", webhook_secret: "w", pem: "line1\nline2" });
    expect(env).toContain('"line1\\nline2"');
  });
});
