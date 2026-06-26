import { describe, expect, it, vi } from "vitest";
import {
  buildManifest,
  cookieValue,
  credentialsToEnv,
  exchangeManifestCode,
  isValidSetupAuthCookie,
  renderBrokeredSetupPage,
  renderSetupPage,
  renderTokenEntryPage,
  SETUP_TOKEN_FORM_MAX_BYTES,
  setupAuthCookieValue,
  setupTokenFormRejection,
  timingSafeStrEqual,
} from "../../src/selfhost/setup-wizard";

describe("setup-wizard (#981 GitHub App Manifest)", () => {
  it("builds a manifest with the webhook + redirect URLs (including CSRF state), permissions, events", () => {
    const m = buildManifest("https://gt.example.com/", "test-state-123");
    expect(m.url).toBe("https://gt.example.com"); // trailing slash trimmed
    expect((m.hook_attributes as { url: string }).url).toBe("https://gt.example.com/v1/github/webhook");
    expect(m.redirect_url).toBe("https://gt.example.com/setup/callback?state=test-state-123");
    expect((m.default_permissions as Record<string, string>).pull_requests).toBe("write");
    expect(m.default_events).toContain("pull_request");
  });

  it("encodes special characters in the state parameter", () => {
    const m = buildManifest("https://gt.example.com", "a b+c=d&e");
    expect(m.redirect_url).toContain("state=a%20b%2Bc%3Dd%26e");
  });

  it("renders a form that POSTs the manifest to GitHub with the CSRF state embedded", () => {
    const html = renderSetupPage("https://gt.example.com", "nonce-abc");
    expect(html).toContain('action="https://github.com/settings/apps/new"');
    expect(html).toContain('name="manifest"');
    expect(html).toContain("Gittensory Self-Host");
    expect(html).toContain("nonce-abc"); // state is baked into the manifest value
  });

  it("renders a brokered-mode page that does NOT create a GitHub App", () => {
    const html = renderBrokeredSetupPage();
    expect(html).toContain("brokered mode");
    expect(html).toContain("ORB_ENROLLMENT_SECRET");
    expect(html).not.toContain("github.com/settings/apps/new"); // no own-App creation form in brokered mode
  });

  it("signs the setup cookie so only token-authorized setup visits can finish the callback", () => {
    const cookie = setupAuthCookieValue("operator-token", "nonce-abc");
    expect(isValidSetupAuthCookie("operator-token", "nonce-abc", cookie)).toBe(true);
    expect(isValidSetupAuthCookie("operator-token", "other-nonce", cookie)).toBe(false);
    expect(isValidSetupAuthCookie("wrong-token", "nonce-abc", cookie)).toBe(false);
    expect(isValidSetupAuthCookie("operator-token", "nonce-abc", "bad-cookie")).toBe(false);
    expect(isValidSetupAuthCookie("operator-token", "nonce-abc", undefined)).toBe(false);
  });

  it("extracts setup cookies from a multi-cookie header", () => {
    const cookie = setupAuthCookieValue("operator-token", "nonce-abc");
    expect(cookieValue(`theme=dark; setup_auth=${cookie}; session=xyz`, "setup_auth")).toBe(cookie);
    expect(cookieValue("theme=dark", "setup_auth")).toBeUndefined();
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

  it("credentialsToEnv omits optional OAuth lines when client_id / client_secret are absent", () => {
    const env = credentialsToEnv({ id: 1, slug: "s", webhook_secret: "w", pem: "k" });
    expect(env).toContain("GITHUB_APP_ID=1");
    expect(env).not.toContain("GITHUB_OAUTH_CLIENT_ID");
    expect(env).not.toContain("GITHUB_OAUTH_CLIENT_SECRET");
  });

  it("timingSafeStrEqual compares constant-time: equal vs differing-value vs differing-length", () => {
    expect(timingSafeStrEqual("s3cret-token", "s3cret-token")).toBe(true);
    expect(timingSafeStrEqual("s3cret-token", "s3cret-toker")).toBe(false); // same length, different bytes
    expect(timingSafeStrEqual("short", "longer-token")).toBe(false); // length mismatch must not throw
    expect(timingSafeStrEqual("", "")).toBe(true);
  });

  it("rejects unsafe setup token form uploads before parsing the body", async () => {
    const oversized = setupTokenFormRejection(
      new Headers({ "content-length": String(SETUP_TOKEN_FORM_MAX_BYTES + 1), "content-type": "application/x-www-form-urlencoded" }),
    );
    expect(oversized?.status).toBe(413);
    await expect(oversized?.text()).resolves.toContain("too large");

    expect(setupTokenFormRejection(new Headers({ "content-type": "application/x-www-form-urlencoded" }))?.status).toBe(411);
    expect(
      setupTokenFormRejection(new Headers({ "content-length": "nope", "content-type": "application/x-www-form-urlencoded" }))?.status,
    ).toBe(400);
    expect(
      setupTokenFormRejection(new Headers({ "content-length": "-1", "content-type": "application/x-www-form-urlencoded" }))?.status,
    ).toBe(400);
    expect(setupTokenFormRejection(new Headers({ "content-length": "5", "content-type": "text/plain" }))?.status).toBe(415);

    expect(
      setupTokenFormRejection(new Headers({ "content-length": "12", "content-type": "application/x-www-form-urlencoded; charset=UTF-8" })),
    ).toBeUndefined();
    expect(
      setupTokenFormRejection(new Headers({ "content-length": "12", "content-type": "multipart/form-data; boundary=x" })),
    ).toBeUndefined();
  });

  it("renderTokenEntryPage renders a POST form (token in the body, not the URL) + an error variant", () => {
    const page = renderTokenEntryPage();
    expect(page).toContain(`<form action="/setup" method="post">`);
    expect(page).toContain(`name="token"`);
    expect(page).toContain(`type="password"`); // never echoed/visible
    expect(page).not.toContain("Invalid setup token");
    expect(renderTokenEntryPage(true)).toContain("Invalid setup token"); // shown after a wrong submission
  });
});
