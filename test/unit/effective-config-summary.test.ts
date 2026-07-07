import { describe, expect, it } from "vitest";
import { summarizeEffectiveConfig } from "../../src/settings/effective-config-summary";
import type { RepositorySettings } from "../../src/types";

const base = (overrides: Partial<RepositorySettings> = {}): RepositorySettings =>
  ({
    autonomy: { review: "auto", merge: "observe" },
    slopGateMinScore: 70,
    blacklistLabel: "slop",
    commandAuthorization: { default: ["maintainer", "collaborator"], commands: { configuration: ["maintainer"] } },
    ...overrides,
  }) as RepositorySettings;

describe("summarizeEffectiveConfig", () => {
  it("renders execution mode, every action class's resolved autonomy, slop gate, blacklist label, and command auth", () => {
    const out = summarizeEffectiveConfig(base(), "live");
    expect(out).toContain("Agent execution mode: **live**");
    // set class shows its level; unset classes resolve to the deny-by-default floor `observe`
    expect(out).toContain("`review`: auto");
    expect(out).toContain("`merge`: observe");
    expect(out).toContain("`approve`: observe"); // unset → observe
    expect(out).toContain("Slop-gate minimum score: 70");
    expect(out).toContain("Blacklist label: `slop`");
    expect(out).toContain("default roles: maintainer, collaborator");
    expect(out).toContain("`configuration`: maintainer");
  });

  it("reflects the resolved execution mode verbatim", () => {
    expect(summarizeEffectiveConfig(base(), "paused")).toContain("execution mode: **paused**");
    expect(summarizeEffectiveConfig(base(), "dry_run")).toContain("execution mode: **dry_run**");
  });

  it("shows 'not set' when slopGateMinScore is absent or null", () => {
    expect(summarizeEffectiveConfig(base({ slopGateMinScore: undefined }), "live")).toContain("Slop-gate minimum score: not set");
    expect(summarizeEffectiveConfig(base({ slopGateMinScore: null }), "live")).toContain("Slop-gate minimum score: not set");
  });

  it("renders the blacklist label across configured / default / disabled cases", () => {
    expect(summarizeEffectiveConfig(base({ blacklistLabel: "spam" }), "live")).toContain("Blacklist label: `spam`");
    expect(summarizeEffectiveConfig(base({ blacklistLabel: undefined }), "live")).toContain("Blacklist label: `slop`"); // default
    expect(summarizeEffectiveConfig(base({ blacklistLabel: null }), "live")).toContain("Blacklist label: `(disabled)`");
  });

  it("renders the normalized default command overrides even when the repo configures none", () => {
    // An empty per-command config normalizes to the maintainer-only command defaults, so overrides are always listed.
    const out = summarizeEffectiveConfig(base({ commandAuthorization: { default: ["maintainer"], commands: {} } }), "live");
    expect(out).toContain("  - overrides:\n");
    expect(out).toMatch(/ {2}- `[a-z-]+`: /); // at least one override line
  });

  it("never leaks a secret/reward/trust/wallet field (public-safe, #2168 house rule)", () => {
    const out = summarizeEffectiveConfig(
      base({ autonomy: { review: "auto", request_changes: "propose", approve: "auto_with_approval", merge: "auto", close: "suggest" } }),
      "live",
    ).toLowerCase();
    for (const banned of ["reward", "payout", "emission", "wallet", "hotkey", "coldkey", "privatekey", "trustscore", "rawtrust", "coldkeys", "secret"]) {
      expect(out).not.toContain(banned);
    }
  });
});
