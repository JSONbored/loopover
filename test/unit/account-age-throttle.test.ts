import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestEnv } from "../helpers/d1";
import {
  effectiveIssueCapForAccountAge,
  isBelowAccountAgeThreshold,
  repoOwnerLoginFromFullName,
} from "../../src/queue/account-age-throttle";

function generatePrivateKeyPem(): string {
  return generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
}

describe("account-age throttle helpers (#2561 issue path)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("repoOwnerLoginFromFullName returns the owner segment for owner/repo names", () => {
    expect(repoOwnerLoginFromFullName("JSONbored/loopover")).toBe("JSONbored");
  });

  it("repoOwnerLoginFromFullName returns empty for a no-slash repo name", () => {
    expect(repoOwnerLoginFromFullName("noslash")).toBe("");
  });

  it("effectiveIssueCapForAccountAge halves and rounds up for new accounts", () => {
    expect(effectiveIssueCapForAccountAge(4, true)).toBe(2);
    expect(effectiveIssueCapForAccountAge(5, true)).toBe(3);
    expect(effectiveIssueCapForAccountAge(1, true)).toBe(1);
  });

  it("effectiveIssueCapForAccountAge preserves the full cap for established accounts", () => {
    expect(effectiveIssueCapForAccountAge(4, false)).toBe(4);
  });

  it("isBelowAccountAgeThreshold returns false when the threshold is off", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generatePrivateKeyPem() });
    let fetched = false;
    vi.stubGlobal("fetch", async () => { fetched = true; return Response.json({}); });
    expect(await isBelowAccountAgeThreshold(env, 123, "newbie", null)).toBe(false);
    expect(fetched).toBe(false);
  });

  it("isBelowAccountAgeThreshold fail-opens when created_at is unavailable", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generatePrivateKeyPem() });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      if (url.includes("/users/")) return new Response("missing", { status: 404 });
      return Response.json({});
    });
    expect(await isBelowAccountAgeThreshold(env, 123, "newbie", 30)).toBe(false);
  });

  it("isBelowAccountAgeThreshold returns true for a below-threshold account", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generatePrivateKeyPem() });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      if (url.includes("/users/")) {
        return Response.json({ login: "newbie", created_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() });
      }
      return Response.json({});
    });
    expect(await isBelowAccountAgeThreshold(env, 123, "newbie", 30)).toBe(true);
  });
});

// #9492: `isNewAccount` HALVES the contributor open-PR cap (effectiveIssueCapForAccountAge) and can therefore
// flip a cap CLOSE — it is a decision INPUT, not telemetry. The maintenance decision pass captures ONE
// `decisionClock` instant and records it into the replay input; before this, the account-age comparison read
// the clock again, independently, so the recorded instant and the instant that actually decided the cap could
// differ and a replay could never reproduce the latter. This helper had no `nowMs` seam at all.
describe("account-age recorded decision clock (#9492)", () => {
  const stubUserCreatedAt = (createdAt: string) =>
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      if (url.includes("/users/")) return Response.json({ created_at: createdAt });
      return Response.json({});
    });

  it("REGRESSION: evaluates the age against the SUPPLIED instant, not the live clock", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generatePrivateKeyPem() });
    // An account created 10 days ago against a 30-day threshold: NEW by the live clock.
    stubUserCreatedAt(new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString());

    expect(await isBelowAccountAgeThreshold(env, 123, "newbie", 30)).toBe(true);
    // The same account judged at an instant 60 days on is ESTABLISHED. The two answers differ, which is what
    // makes the recorded instant load-bearing rather than cosmetic.
    expect(await isBelowAccountAgeThreshold(env, 123, "newbie", 30, Date.now() + 60 * 24 * 60 * 60 * 1000)).toBe(false);
  });

  it("INVARIANT: omitting nowMs preserves the live-clock behaviour exactly — the three callers outside the decision pass are unaffected", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generatePrivateKeyPem() });
    stubUserCreatedAt(new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString());
    expect(await isBelowAccountAgeThreshold(env, 123, "veteran", 30)).toBe(false);
  });

  it("INVARIANT: the threshold-off and unavailable-created_at fail-open paths ignore nowMs entirely", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generatePrivateKeyPem() });
    let fetched = false;
    vi.stubGlobal("fetch", async () => {
      fetched = true;
      return Response.json({});
    });
    expect(await isBelowAccountAgeThreshold(env, 123, "newbie", null, 0)).toBe(false);
    expect(fetched).toBe(false);
  });
});
