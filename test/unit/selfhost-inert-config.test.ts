import { describe, expect, it } from "vitest";
import { inertConfigEntries, inertConfigGaugeSamples } from "../../src/selfhost/inert-config";

// #9433: a config-dependent fix that ships INERT behaves exactly like the pre-fix build, with a green test
// suite — tests verify the mechanism works WHEN ENABLED, never that an operator set the variable. The
// confirmed instance sat live for weeks. This report is the answerability layer: "which config-gated
// behaviours are currently inert on this box?", on demand, with zero steady-state noise.
describe("inertConfigEntries (#9433)", () => {
  /** Everything set to a real value — the fully-configured deployment. */
  const configured = {
    LOOPOVER_PUBLIC_SCORE_TERMS_ALLOWED_REPOS: "JSONbored/loopover",
    LOOPOVER_PUBLIC_STATS_REPOS: "JSONbored/loopover",
    LOOPOVER_REVIEW_SAFETY: "true",
  };

  it("reports nothing when every tracked var is set — a fully-configured box is silent", () => {
    expect(inertConfigEntries(configured)).toEqual([]);
    expect(inertConfigGaugeSamples(configured)).toEqual([]);
  });

  it("REGRESSION: reports the confirmed #9433 instance — an unset score-terms allowlist silently strips narrative sentences", () => {
    const entries = inertConfigEntries({ ...configured, LOOPOVER_PUBLIC_SCORE_TERMS_ALLOWED_REPOS: undefined });
    expect(entries.map((entry) => entry.key)).toEqual(["LOOPOVER_PUBLIC_SCORE_TERMS_ALLOWED_REPOS"]);
    // The impact string is what an operator actually reads, so it must describe the OBSERVABLE effect rather
    // than the mechanism — "the summary looks fine, just shorter" is the whole reason this went unnoticed.
    expect(entries[0]?.impact).toMatch(/silently|shorter/i);
  });

  it("reports each tracked var independently, and all of them on a bare env", () => {
    expect(inertConfigEntries({}).map((entry) => entry.key)).toEqual([
      "LOOPOVER_PUBLIC_SCORE_TERMS_ALLOWED_REPOS",
      "LOOPOVER_PUBLIC_STATS_REPOS",
      "LOOPOVER_REVIEW_SAFETY",
    ]);
  });

  it("treats whitespace-only and empty-string as unset — the shapes a half-written .env actually produces", () => {
    for (const blank of ["", "   ", "\t\n"]) {
      expect(inertConfigEntries({ ...configured, LOOPOVER_PUBLIC_STATS_REPOS: blank }).map((e) => e.key)).toEqual([
        "LOOPOVER_PUBLIC_STATS_REPOS",
      ]);
    }
  });

  // The judgment that keeps this report from becoming the next ignored alert: LOOPOVER_PUBLIC_STATS_REPOS is
  // unset on the ORB self-host box and that is CORRECT — the Worker serves public stats. Marking it
  // deployment-specific is what says "do not warn about this unconditionally".
  it("classifies every entry as deployment-specific, so nothing here is auto-escalated to a warning", () => {
    for (const entry of inertConfigEntries({})) {
      expect(entry.severity, entry.key).toBe("deployment-specific");
    }
  });

  it("INVARIANT: gauge samples carry a BOUNDED label set — key plus severity only, value always 1", () => {
    // Cardinality is bounded by construction: the key set is a fixed list in code, never derived from input,
    // so an operator can alert on a specific key with no cardinality risk.
    const samples = inertConfigGaugeSamples({});
    expect(samples.length).toBeGreaterThan(0);
    for (const sample of samples) {
      expect(Object.keys(sample.labels).sort()).toEqual(["key", "severity"]);
      expect(sample.value).toBe(1);
    }
  });

  it("INVARIANT: gauge samples and entries stay in lockstep — one series per inert entry, same keys", () => {
    // Three surfaces (metrics, a future /ready field, this test) must read ONE answer; hand-maintaining a
    // second list is the same drift class #9433 is about.
    for (const env of [{}, configured, { ...configured, LOOPOVER_REVIEW_SAFETY: "" }]) {
      const entries = inertConfigEntries(env);
      const samples = inertConfigGaugeSamples(env);
      expect(samples.map((sample) => sample.labels.key)).toEqual(entries.map((entry) => entry.key));
    }
  });

  it("INVARIANT: every entry carries a non-empty, actionable impact string", () => {
    for (const entry of inertConfigEntries({})) {
      expect(entry.impact.length, entry.key).toBeGreaterThan(40);
      expect(entry.key, entry.key).toMatch(/^[A-Z0-9_]+$/); // a real env var name, not prose
    }
  });

  it("is PURE — repeated calls on the same env return an identical answer, and never mutate it", () => {
    const env = { ...configured, LOOPOVER_PUBLIC_STATS_REPOS: undefined };
    const before = JSON.stringify(env);
    expect(inertConfigEntries(env)).toEqual(inertConfigEntries(env));
    expect(JSON.stringify(env)).toBe(before);
  });
});
