import { describe, expect, it } from "vitest";
import { planIdeaClaimsPayload } from "../../packages/loopover-mcp/lib/plan-idea-claims.js";

const VALID = {
  id: "idea-1",
  title: "Retry uploads on 5xx",
  body: "Uploads fail silently on 5xx.",
  targetRepo: { kind: "existing" as const, repo: "acme/widgets" },
};

describe("planIdeaClaimsPayload (#7635)", () => {
  it("returns a claim plan for an existing-repo target", () => {
    const result = planIdeaClaimsPayload(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.verdict).toBe("go");
    expect(result.claimPlan.targetRepo).toBe("acme/widgets");
    expect(result.claimPlan.claimable).toHaveLength(1);
  });

  it("rejects a provision target (no concrete owner/name yet)", () => {
    const result = planIdeaClaimsPayload({ ...VALID, targetRepo: { kind: "provision" } });
    expect(result).toEqual({ ok: false, errors: ["target_repo_required"] });
  });

  it("returns validation errors for malformed input", () => {
    const result = planIdeaClaimsPayload({ title: "missing fields" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual(expect.arrayContaining(["id_required", "body_required", "target_repo_required"]));
  });
});
