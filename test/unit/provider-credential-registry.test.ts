import { afterEach, describe, expect, it } from "vitest";
import { getProviderCredentialResolver, setProviderCredentialResolver } from "../../src/selfhost/provider-credential-registry";

// The Workers-safe nullable slot that carries the fleet-mode (DB-backed) credential lookup into
// src/selfhost/ai.ts without ai.ts ever importing the DB layer (#9543). Same shape as
// redeploy-companion-registry.test.ts, which covers the sibling slot.

afterEach(() => {
  setProviderCredentialResolver(null);
});

describe("provider-credential-registry (#9543)", () => {
  it("returns null before anything is set (cloud, or a box with no stored credential)", () => {
    expect(getProviderCredentialResolver()).toBeNull();
  });

  it("returns the injected resolver and passes the provider through", async () => {
    const seen: string[] = [];
    setProviderCredentialResolver(async (provider) => {
      seen.push(provider);
      return "stored-credential";
    });
    const resolver = getProviderCredentialResolver();
    expect(resolver).not.toBeNull();
    await expect(resolver!("claude-code")).resolves.toBe("stored-credential");
    await expect(resolver!("codex")).resolves.toBe("stored-credential");
    expect(seen).toEqual(["claude-code", "codex"]);
  });

  it("carries a null result through for a provider with nothing stored", async () => {
    setProviderCredentialResolver(async () => null);
    await expect(getProviderCredentialResolver()!("claude-code")).resolves.toBeNull();
  });

  it("clears back to null", () => {
    setProviderCredentialResolver(async () => "x");
    setProviderCredentialResolver(null);
    expect(getProviderCredentialResolver()).toBeNull();
  });
});
