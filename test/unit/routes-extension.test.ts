import { describe, expect, it } from "vitest";
import { __routesInternals } from "../../src/api/routes";
import { createSessionForGitHubUser } from "../../src/auth/security";
import { createTestEnv } from "../helpers/d1";

describe("extension packet helper internals", () => {
  it("falls back when extension packet text contains forbidden public terms", () => {
    const result = __routesInternals.ensureExtensionPublicSafeText("# Public-safe PR packet\n\n- reviewability 91/100");
    expect(result).toContain("Public-safe packet unavailable");
  });

  it("keeps safe extension packet text unchanged", () => {
    const text = "# Public-safe PR packet\n\n- Repository: owner/repo\n- Keep public comments focused on linked context.";
    expect(__routesInternals.ensureExtensionPublicSafeText(text)).toBe(text);
  });

  it("builds private blocker fallback when no blocker signals are present", () => {
    const blockers = __routesInternals.buildExtensionPrivateBlockers({
      noiseSources: [],
      maintainerNextSteps: [],
      privateSummary: "",
    });
    expect(blockers).toEqual([{ id: "blocker-1", detail: "No private blocker detail is currently cached." }]);
  });

  it("builds extension packet markdown from public-safe allowlisted text", () => {
    const markdown = __routesInternals.buildExtensionPublicSafePacket({
      repoFullName: "owner/repo",
      pullNumber: 12,
      contributor: "alice",
      reviewability: {
        action: "needs_author",
        noiseSources: ["Contributor repo-specific closed PR rate is 40%.", "avoid payout language in public"],
        maintainerNextSteps: ["remove wallet references", "Contributor repo-specific closed PR rate is 40%."],
      },
    });
    expect(markdown).toContain("# Public-safe PR packet");
    expect(markdown).toContain("author input may be needed before deep review");
    expect(markdown).not.toMatch(/closed PR rate|repo-specific|wallet|payout|hotkey|reward estimate|estimated score|raw trust score/i);
  });

  it.each([
    ["review_now", "ready for maintainer review"],
    ["maintainer_lane", "maintainer follow-up recommended"],
    ["likely_duplicate", "possible overlap to verify"],
    ["close_or_redirect", "triage may be needed before review"],
    ["unknown", "keep monitoring the public PR context"],
  ])("describes %s extension readiness with public-safe guidance", (action, expectedText) => {
    const markdown = __routesInternals.buildExtensionPublicSafePacket({
      repoFullName: "owner/repo",
      pullNumber: 12,
      contributor: "alice",
      reviewability: {
        action,
        noiseSources: [],
        maintainerNextSteps: [],
      },
    });

    expect(markdown).toContain(expectedText);
    expect(markdown).not.toMatch(/private reviewability|trust score|reward estimate|payout|\/100/i);
  });

  it("authenticates request identity from browser session cookie fallback", async () => {
    const env = createTestEnv();
    const { token } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 7 });
    const identity = await __routesInternals.authenticateRequestIdentity({
      env,
      req: {
        header(name: string) {
          if (name.toLowerCase() === "cookie") return `gittensory_session=${token}`;
          return undefined;
        },
      },
      json: (_payload: { error: string }, status?: number) => Response.json({}, status === undefined ? undefined : { status }),
    });
    expect(identity).toMatchObject({ kind: "session", actor: "jsonbored" });
  });
});
