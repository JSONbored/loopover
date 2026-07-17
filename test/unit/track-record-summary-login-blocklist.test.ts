import { describe, expect, it } from "vitest";
import {
  computeTrackRecordSummary,
  renderTrackRecordSummaryMarkdown,
} from "../../packages/loopover-engine/src/track-record-summary";

const NOW = "2026-07-04T18:00:00.000Z";

function summaryFor(login: string, incidentLabelSource?: string) {
  return computeTrackRecordSummary({
    login,
    now: NOW,
    config: { includeTrackRecordSummary: true, warnings: [] },
    outcomes: [
      { id: "pr-1", repoFullName: "owner/repo", authorLogin: login.toLowerCase(), state: "merged", createdAt: "2026-06-01T00:00:00Z" },
      // An open PR too, so the `openIgnored > 0` line the scan also builds is exercised.
      { id: "pr-2", repoFullName: "owner/repo", authorLogin: login.toLowerCase(), state: "open", createdAt: "2026-07-01T00:00:00Z" },
    ],
    ...(incidentLabelSource
      ? { incidents: [{ login: login.toLowerCase(), kind: "moderation", publicEvidenceUrl: incidentLabelSource }] }
      : {}),
  });
}

// #6772: PUBLIC_FIELD_BLOCKLIST exists to catch leaked COMPUTED fields. A hyphen is a legal GitHub username
// character, so a real login like `team-wallet` matches `/\bwallet\b/iu` as a whole word and used to throw on
// that contributor's OWN summary. The identity line is now excluded from the scan.
describe("renderTrackRecordSummaryMarkdown login vs the public-field blocklist (#6772)", () => {
  it("REGRESSION: renders instead of throwing for a login containing a blocklisted word", () => {
    for (const login of ["team-wallet", "payout-bot", "coldkey-labs", "hotkey-ops", "reward-guild", "ranking-labs"]) {
      const markdown = renderTrackRecordSummaryMarkdown(summaryFor(login));
      expect(markdown).toContain(`- GitHub login: ${login}`);
    }
  });

  it("keeps the login on its original line, right after the heading's blank line", () => {
    const lines = renderTrackRecordSummaryMarkdown(summaryFor("team-wallet")).split("\n");
    expect(lines[0]).toBe("### Public contributor record");
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe("- GitHub login: team-wallet");
    expect(lines[3]).toContain("- Resolved public PRs:");
  });

  it("an ordinary login still renders byte-identically (no positional drift, escaping intact)", () => {
    const markdown = renderTrackRecordSummaryMarkdown(summaryFor("Miner_Name"));
    // Normalized to lowercase and markdown-escaped, exactly as before this change.
    expect(markdown).toContain("- GitHub login: miner\\_name");
    expect(markdown.startsWith("### Public contributor record\n\n- GitHub login:")).toBe(true);
  });

  it("still fails closed when a COMPUTED field carries a blocked term (injection guard intact)", () => {
    // The evidence URL is computed/leakable content, not identity — it must still trip the blocklist.
    expect(() => renderTrackRecordSummaryMarkdown(summaryFor("miner", "http://example.test/wallet"))).toThrow(
      /blocked public field/i,
    );
  });

  it("a disabled summary still renders empty (unchanged short-circuit)", () => {
    const disabled = computeTrackRecordSummary({
      login: "team-wallet",
      now: NOW,
      config: { includeTrackRecordSummary: false, warnings: [] },
      outcomes: [],
    });
    expect(renderTrackRecordSummaryMarkdown(disabled)).toBe("");
  });
});
