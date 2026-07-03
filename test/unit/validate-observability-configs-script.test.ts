import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateAlertRules, validateDashboards } from "../../scripts/validate-observability-configs.mjs";

function tmpDashboardDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "gt-dash-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

function tmpAlertFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "gt-alerts-"));
  const path = join(dir, "alerts.yml");
  writeFileSync(path, content);
  return path;
}

describe("validate-observability-configs (#1943)", () => {
  it("passes the real dashboards and alert rules shipped in the repo", () => {
    expect(validateDashboards("grafana/dashboards")).toEqual([]);
    expect(validateAlertRules("prometheus/rules/alerts.yml")).toEqual([]);
  });

  describe("validateDashboards", () => {
    it("flags invalid JSON", () => {
      const dir = tmpDashboardDir({ "broken.json": "{ not json" });
      const errors = validateDashboards(dir);
      expect(errors.some((e) => e.includes("invalid JSON"))).toBe(true);
    });

    it("flags a dashboard missing title or panels", () => {
      const dir = tmpDashboardDir({ "incomplete.json": JSON.stringify({}) });
      const errors = validateDashboards(dir);
      expect(errors.some((e) => e.includes('missing a non-empty top-level "title"'))).toBe(true);
      expect(errors.some((e) => e.includes('missing a top-level "panels" array'))).toBe(true);
    });

    it("flags an empty dashboards directory", () => {
      const dir = mkdtempSync(join(tmpdir(), "gt-dash-empty-"));
      const errors = validateDashboards(dir);
      expect(errors).toEqual([`${dir}: no dashboard JSON files found`]);
    });

    it("passes a well-formed dashboard", () => {
      const dir = tmpDashboardDir({
        "ok.json": JSON.stringify({ title: "OK Dashboard", panels: [] }),
      });
      expect(validateDashboards(dir)).toEqual([]);
    });

    it("reports the directory itself when unreadable", () => {
      const errors = validateDashboards(join(tmpdir(), "gt-does-not-exist-" + Math.random()));
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain("could not read directory");
    });

    it("reports a validation error (not a crash) when a dashboard file is valid JSON but not an object", () => {
      const dir = tmpDashboardDir({ "null.json": "null", "array.json": "[]", "string.json": '"hi"' });
      const errors = validateDashboards(dir);
      expect(errors.some((e) => e.includes("null.json") && e.includes("must be a JSON object"))).toBe(true);
      expect(errors.some((e) => e.includes("array.json") && e.includes("must be a JSON object"))).toBe(true);
      expect(errors.some((e) => e.includes("string.json") && e.includes("must be a JSON object"))).toBe(true);
    });
  });

  describe("validateAlertRules", () => {
    it("flags invalid YAML", () => {
      const path = tmpAlertFile("groups:\n  - name: [unterminated");
      const errors = validateAlertRules(path);
      expect(errors.some((e) => e.includes("invalid YAML"))).toBe(true);
    });

    it("flags a missing top-level groups array", () => {
      const path = tmpAlertFile("not_groups: []");
      expect(validateAlertRules(path)).toEqual([`${path}: missing a top-level "groups" array`]);
    });

    it("flags a group missing name or rules", () => {
      const path = tmpAlertFile("groups:\n  - {}\n");
      const errors = validateAlertRules(path);
      expect(errors.some((e) => e.includes('missing a non-empty "name"'))).toBe(true);
      expect(errors.some((e) => e.includes('missing a "rules" array'))).toBe(true);
    });

    it("flags a rule missing alert, expr, severity, or summary", () => {
      const path = tmpAlertFile(
        ["groups:", "  - name: test-group", "    rules:", "      - expr: up == 0"].join("\n"),
      );
      const errors = validateAlertRules(path);
      expect(errors.some((e) => e.includes('missing "alert"'))).toBe(true);
      expect(errors.some((e) => e.includes('missing "labels.severity"'))).toBe(true);
      expect(errors.some((e) => e.includes('missing "annotations.summary"'))).toBe(true);
    });

    it("passes a well-formed rule", () => {
      const path = tmpAlertFile(
        [
          "groups:",
          "  - name: test-group",
          "    rules:",
          "      - alert: TestAlert",
          "        expr: up == 0",
          "        for: 5m",
          "        labels:",
          "          severity: warning",
          "        annotations:",
          "          summary: test",
        ].join("\n"),
      );
      expect(validateAlertRules(path)).toEqual([]);
    });

    it("reports the file itself when unreadable", () => {
      const path = join(tmpdir(), "gt-does-not-exist-" + Math.random() + ".yml");
      const errors = validateAlertRules(path);
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain("invalid YAML");
    });

    it("reports a validation error (not a crash) when a group entry is not an object", () => {
      const path = tmpAlertFile("groups:\n  - null\n  - 5\n  - just-a-string\n");
      const errors = validateAlertRules(path);
      expect(errors.length).toBe(3);
      for (const e of errors) expect(e).toContain("must be an object");
    });

    it("reports a validation error (not a crash) when a rule entry is not an object", () => {
      const path = tmpAlertFile(["groups:", "  - name: test-group", "    rules:", "      - null"].join("\n"));
      const errors = validateAlertRules(path);
      expect(errors.some((e) => e.includes("rules[0]") && e.includes("must be an object"))).toBe(true);
    });

    function ruleFile(expr: string): string {
      return tmpAlertFile(
        [
          "groups:",
          "  - name: test-group",
          "    rules:",
          "      - alert: TestAlert",
          `        expr: ${expr}`,
          "        labels:",
          "          severity: warning",
          "        annotations:",
          "          summary: test",
        ].join("\n"),
      );
    }

    it("flags an expr with a dangling binary operator", () => {
      const errors = validateAlertRules(ruleFile("up =="));
      expect(errors.some((e) => e.includes("dangling") || e.includes('binary operator "=="'))).toBe(true);
    });

    it("flags an expr with unbalanced brackets", () => {
      const errors = validateAlertRules(ruleFile("sum(rate(foo[5m])"));
      expect(errors.some((e) => e.includes("unbalanced brackets"))).toBe(true);
    });

    it("flags an expr with an unexpected closing bracket", () => {
      const errors = validateAlertRules(ruleFile("up)"));
      expect(errors.some((e) => e.includes("unbalanced brackets"))).toBe(true);
    });

    it("flags mismatched bracket TYPES even when nesting depth balances out (REGRESSION)", () => {
      // sum(foo[5m)) -- opened with "(" and "[", closed with ")" and ")". A naive depth counter (net
      // opens - closes = 0) wrongly calls this balanced; the closer must match its actual opener.
      const errors = validateAlertRules(ruleFile("sum(foo[5m))"));
      expect(errors.some((e) => e.includes("unbalanced brackets") && e.includes('expected the match for "["'))).toBe(
        true,
      );
    });

    it("passes well-formed real-shaped PromQL expressions", () => {
      for (const expr of [
        "up == 0",
        "sum(rate(gittensory_jobs_total[5m])) by (status) > 10",
        'histogram_quantile(0.95, rate(gittensory_http_duration_seconds_bucket{route="/health"}[5m]))',
        "(a + b) / c",
      ]) {
        expect(validateAlertRules(ruleFile(expr))).toEqual([]);
      }
    });
  });
});
