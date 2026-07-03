import { describe, expect, it } from "vitest";
import { LOCAL_WRITE_BOUNDARY } from "../../src/mcp/local-write-tools";
import { buildSoftClaimCommentBody, buildSoftClaimSpec } from "../../src/miner/soft-claim";

describe("soft-claim spec builder (#2315)", () => {
  it("buildSoftClaimCommentBody: formats a deterministic body with miner id + claimed-at, no expiry line when absent", () => {
    const body = buildSoftClaimCommentBody({ minerId: "miner-7", claimedAt: "2026-07-03T12:00:00Z" });
    expect(body).toContain("`miner-7`");
    expect(body).toContain("claimed at 2026-07-03T12:00:00Z");
    expect(body).toContain("Soft claim only — not an assignment");
    expect(body).not.toContain("expires at"); // no expiry note without expiresAt
    // deterministic
    expect(buildSoftClaimCommentBody({ minerId: "miner-7", claimedAt: "2026-07-03T12:00:00Z" })).toBe(body);
  });

  it("buildSoftClaimCommentBody: includes an expiry note when expiresAt is provided", () => {
    const body = buildSoftClaimCommentBody({
      minerId: "miner-7",
      claimedAt: "2026-07-03T12:00:00Z",
      expiresAt: "2026-07-04T12:00:00Z",
    });
    expect(body).toContain("This claim expires at 2026-07-04T12:00:00Z");
  });

  it("buildSoftClaimSpec: delegates to the eligibility-comment builder, carrying the local-write boundary", () => {
    const spec = buildSoftClaimSpec({
      repoFullName: "octo/repo",
      number: 42,
      minerId: "miner-7",
      claimedAt: "2026-07-03T12:00:00Z",
    });
    expect(spec.action).toBe("post_eligibility_comment");
    expect(spec.boundary).toBe(LOCAL_WRITE_BOUNDARY);
    // the command is the reused builder's shell-safe `gh issue comment`, with the composed body as --body
    expect(spec.command).toContain("gh issue comment 42 --repo 'octo/repo' --body '");
    expect(spec.inputs.body).toBe(buildSoftClaimCommentBody({ minerId: "miner-7", claimedAt: "2026-07-03T12:00:00Z" }));
  });

  it("buildSoftClaimSpec: a single quote in minerId is POSIX-escaped by the reused builder (injection-safe)", () => {
    const spec = buildSoftClaimSpec({
      repoFullName: "octo/repo",
      number: 42,
      minerId: "evil'; rm -rf / #",
      claimedAt: "2026-07-03T12:00:00Z",
    });
    // the embedded single quote is escaped as '\'' so the command stays a single, safe --body argument
    expect(spec.command).toContain("evil'\\''; rm -rf / #");
    // and the whole --body value remains wrapped in one pair of single quotes (no unescaped break-out quote)
    const unescaped = spec.command.replace(/'\\''/g, "");
    expect((unescaped.match(/'/g) ?? []).length % 2).toBe(0);
  });
});
