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

  it("sanitizes extension packet markdown before returning it", () => {
    const markdown = __routesInternals.buildExtensionPublicSafePacket({
      repoFullName: "owner/repo",
      pullNumber: 12,
      contributor: "alice",
      reviewability: {
        action: "review_now",
        noiseSources: ["avoid payout language in public"],
        maintainerNextSteps: ["remove wallet references"],
      },
    });
    expect(markdown).toContain("# Public-safe PR packet");
    expect(markdown).not.toMatch(/wallet|payout|hotkey|reward estimate|estimated score|raw trust score/i);
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
