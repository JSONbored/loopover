import { describe, expect, it } from "vitest";
import { __agentActionExplanationCardInternals } from "../../src/services/agent-action-explanation-card";

const { sanitizePublicCardText } = __agentActionExplanationCardInternals;

describe("agent-action explanation-card public-text sanitizer — token redaction (#9697)", () => {
  it.each([
    ["ghp_", `ghp_${"A".repeat(24)}`],
    ["gho_", `gho_${"A".repeat(24)}`],
    ["ghu_", `ghu_${"A".repeat(24)}`],
    ["ghs_", `ghs_${"A".repeat(24)}`],
    ["ghr_", `ghr_${"A".repeat(24)}`],
    ["github_pat_", `github_pat_${"A".repeat(24)}`],
    ["gts_", `gts_${"A".repeat(24)}`],
    ["orbenr_", `orbenr_${"A".repeat(24)}`],
    ["orbsec_", `orbsec_${"A".repeat(24)}`],
    ["glpat-", `glpat-${"A".repeat(24)}`],
    ["sk-", `sk-${"A".repeat(24)}`],
    ["xoxb-", `xoxb-${"A".repeat(24)}`],
  ])("REGRESSION (#9697): redacts a %s token (unified PUBLIC_TOKEN_INLINE)", (_prefix, token) => {
    const out = sanitizePublicCardText(`blocked until ${token} rotates`);
    expect(out).toContain("<redacted>");
    expect(out).not.toContain(token);
  });

  it("leaves non-token card text unmodified by the token scrubber (#9697)", () => {
    expect(sanitizePublicCardText("waiting on branch to be ready")).toBe("waiting on branch to be ready");
  });
});
