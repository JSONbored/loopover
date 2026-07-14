import { describe, expect, it } from "vitest";
import { isLoopoverSeverity, meetsSeverityThreshold, resolveSeverityThreshold } from "../../src/services/severity-threshold";
import { createTestEnv } from "../helpers/d1";

const withEnv = (over: Record<string, string> = {}): Env => Object.assign(createTestEnv(), over) as Env;

describe("isLoopoverSeverity", () => {
  it("accepts exactly the four recognized severities", () => {
    for (const value of ["critical", "error", "warning", "info"]) expect(isLoopoverSeverity(value)).toBe(true);
  });
  it("rejects anything else, including near-misses and non-strings", () => {
    for (const value of ["fatal", "warn", "debug", "", undefined, null, 1, {}]) expect(isLoopoverSeverity(value)).toBe(false);
  });
});

describe("meetsSeverityThreshold", () => {
  it("a severity meets an equal or lower threshold", () => {
    expect(meetsSeverityThreshold("error", "error")).toBe(true);
    expect(meetsSeverityThreshold("error", "warning")).toBe(true);
    expect(meetsSeverityThreshold("critical", "info")).toBe(true);
  });
  it("a severity below the threshold does not meet it", () => {
    expect(meetsSeverityThreshold("warning", "error")).toBe(false);
    expect(meetsSeverityThreshold("info", "critical")).toBe(false);
  });
});

describe("resolveSeverityThreshold", () => {
  it("a valid repo-map entry wins over the global override", () => {
    const env = withEnv({ SENTRY_REPO_MIN_SEVERITY: JSON.stringify({ "acme/widgets": "info" }), SENTRY_MIN_SEVERITY: "critical" });
    expect(resolveSeverityThreshold(env, "acme/widgets", "SENTRY_MIN_SEVERITY", "SENTRY_REPO_MIN_SEVERITY")).toBe("info");
  });

  it("repo-map lookup is case-insensitive", () => {
    const env = withEnv({ SENTRY_REPO_MIN_SEVERITY: JSON.stringify({ "acme/widgets": "warning" }) });
    expect(resolveSeverityThreshold(env, "ACME/Widgets", "SENTRY_MIN_SEVERITY", "SENTRY_REPO_MIN_SEVERITY")).toBe("warning");
  });

  it("an invalid/absent repo entry falls back to a valid global override", () => {
    expect(resolveSeverityThreshold(withEnv({ SENTRY_MIN_SEVERITY: "info" }), "acme/widgets", "SENTRY_MIN_SEVERITY", "SENTRY_REPO_MIN_SEVERITY")).toBe("info");
    const env = withEnv({ SENTRY_REPO_MIN_SEVERITY: JSON.stringify({ "acme/widgets": "not-a-severity" }), SENTRY_MIN_SEVERITY: "critical" });
    expect(resolveSeverityThreshold(env, "acme/widgets", "SENTRY_MIN_SEVERITY", "SENTRY_REPO_MIN_SEVERITY")).toBe("critical");
  });

  it("no repo entry + no/invalid global → defaults to the caller-supplied fallback (error unless overridden)", () => {
    expect(resolveSeverityThreshold(withEnv(), "acme/widgets", "SENTRY_MIN_SEVERITY", "SENTRY_REPO_MIN_SEVERITY")).toBe("error");
    expect(resolveSeverityThreshold(withEnv({ SENTRY_MIN_SEVERITY: "not-a-severity" }), "acme/widgets", "SENTRY_MIN_SEVERITY", "SENTRY_REPO_MIN_SEVERITY")).toBe("error");
    expect(resolveSeverityThreshold(withEnv(), "acme/widgets", "SENTRY_MIN_SEVERITY", "SENTRY_REPO_MIN_SEVERITY", "critical")).toBe("critical");
  });

  it("an empty repoFullName (non-repo-scoped event) falls through an unrelated repo map to the global fallback", () => {
    const env = withEnv({ SENTRY_REPO_MIN_SEVERITY: JSON.stringify({ "acme/widgets": "info" }), SENTRY_MIN_SEVERITY: "warning" });
    expect(resolveSeverityThreshold(env, "", "SENTRY_MIN_SEVERITY", "SENTRY_REPO_MIN_SEVERITY")).toBe("warning");
  });

  it("ignores malformed or non-object repo-map values and falls back to the global override", () => {
    expect(resolveSeverityThreshold(withEnv({ SENTRY_REPO_MIN_SEVERITY: "{not json", SENTRY_MIN_SEVERITY: "info" }), "acme/widgets", "SENTRY_MIN_SEVERITY", "SENTRY_REPO_MIN_SEVERITY")).toBe("info");
    expect(resolveSeverityThreshold(withEnv({ SENTRY_REPO_MIN_SEVERITY: "[]", SENTRY_MIN_SEVERITY: "info" }), "acme/widgets", "SENTRY_MIN_SEVERITY", "SENTRY_REPO_MIN_SEVERITY")).toBe("info");
  });

  it("uses process.env as a self-host fallback when the runtime Env object does not carry the var", () => {
    process.env.SENTRY_MIN_SEVERITY = "info";
    try {
      expect(resolveSeverityThreshold(withEnv(), "acme/widgets", "SENTRY_MIN_SEVERITY", "SENTRY_REPO_MIN_SEVERITY")).toBe("info");
    } finally {
      delete process.env.SENTRY_MIN_SEVERITY;
    }
  });
});
