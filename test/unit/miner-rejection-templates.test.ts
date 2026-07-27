import { describe, expect, it } from "vitest";
import {
  REJECTION_REASONS,
  containsPrivateLanguage,
  renderRejectionMessage,
  resolvePlaceholders,
} from "../../packages/loopover-miner/lib/rejection-templates";

const CONTEXT = { repoFullName: "JSONbored/loopover", prNumber: 2751 } as const;

describe("loopover-miner rejection templates (#2324)", () => {
  it("exposes the frozen reason vocabulary", () => {
    expect(REJECTION_REASONS).toEqual(["gate_close", "maintainer_close_no_reason", "superseded_by_duplicate"]);
    expect(Object.isFrozen(REJECTION_REASONS)).toBe(true);
  });

  it("renders every reason bucket with no unresolved placeholders and the resolved context", () => {
    for (const reason of REJECTION_REASONS) {
      const message = renderRejectionMessage(reason, CONTEXT);
      expect(message).not.toMatch(/\{[^}]+\}/); // no unresolved {placeholder}
      expect(message).toContain("JSONbored/loopover");
      expect(message).toContain("#2751");
    }
  });

  it("keeps every rendered note courteous and free of private-language tokens", () => {
    for (const reason of REJECTION_REASONS) {
      const message = renderRejectionMessage(reason, CONTEXT);
      expect(containsPrivateLanguage(message)).toBe(false);
      // Non-defensive: no blaming / decision re-litigation language.
      expect(message.toLowerCase()).not.toMatch(/\b(wrong|unfair|mistake|should have|disagree)\b/);
    }
  });

  it("detects private-language tokens (the public-safe guard)", () => {
    expect(containsPrivateLanguage("thanks for the review")).toBe(false);
    expect(containsPrivateLanguage("do not expose the hotkey")).toBe(true);
    expect(containsPrivateLanguage("no trust score here")).toBe(true);
  });

  it("throws on an unknown reason bucket", () => {
    // @ts-expect-error — reason must be a known bucket
    expect(() => renderRejectionMessage("unknown_reason", CONTEXT)).toThrow("invalid_rejection_reason");
  });

  it("throws on a malformed context rather than emitting a half-rendered note", () => {
    expect(() => renderRejectionMessage("gate_close", { repoFullName: "no-slash", prNumber: 1 })).toThrow(
      "invalid_repo_full_name",
    );
    expect(() => renderRejectionMessage("gate_close", { repoFullName: "o/a", prNumber: 0 })).toThrow(
      "invalid_pr_number",
    );
    // @ts-expect-error — prNumber is required
    expect(() => renderRejectionMessage("gate_close", { repoFullName: "o/a" })).toThrow("invalid_pr_number");
  });

  it("rejects a repoFullName carrying control characters, markup, or an extra slash (no display-text leakage)", () => {
    for (const bad of ["owner/repo\nextra", "owner/repo extra", "owner/<repo>", "owner/repo/extra", "-owner/repo", "owner/re*po"]) {
      expect(() => renderRejectionMessage("gate_close", { repoFullName: bad, prNumber: 1 })).toThrow(
        "invalid_repo_full_name",
      );
    }
    // A well-formed owner/repo with the allowed punctuation still renders.
    expect(renderRejectionMessage("gate_close", { repoFullName: "JSONbored/loopover.io_test-1", prNumber: 9 })).toContain(
      "JSONbored/loopover.io_test-1",
    );
  });

  it("rejects a non-string repoFullName", () => {
    for (const bad of [null, undefined, 42, {}]) {
      // @ts-expect-error — exercising the runtime guard against a non-string repoFullName
      expect(() => renderRejectionMessage("gate_close", { repoFullName: bad, prNumber: 1 })).toThrow(
        "invalid_repo_full_name",
      );
    }
  });

  describe("resolvePlaceholders (the defense-in-depth guard behind renderRejectionMessage)", () => {
    it("renders every placeholder present in values", () => {
      expect(resolvePlaceholders("PR #{prNumber} on {repoFullName}", { prNumber: 7, repoFullName: "o/r" })).toBe(
        "PR #7 on o/r",
      );
    });

    it("throws missing_placeholder for a template referencing a key values doesn't supply", () => {
      expect(() => resolvePlaceholders("Hello {missingKey}", {})).toThrow("missing_placeholder:missingKey");
    });

    it("throws unresolved_placeholder when a substituted value's own text still looks like a placeholder", () => {
      // Not reachable via renderRejectionMessage (GITHUB_FULL_NAME forbids `{`/`}` in repoFullName), but a real
      // guard against any future caller of this pure helper that doesn't pre-validate its values the same way.
      expect(() => resolvePlaceholders("{repoFullName}", { repoFullName: "{injected}" })).toThrow(
        "unresolved_placeholder",
      );
    });
  });
});
