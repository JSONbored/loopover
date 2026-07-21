import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { DEFAULT_METRIC_META } from "../../src/selfhost/metrics";

// Regression check (#5816): a hand-authored alert annotation (summary/description/runbook) can reference a
// `loopover_*` metric name that was never registered, or was renamed/removed, without any existing tooling
// catching it -- scripts/validate-observability-configs.ts only validates PromQL `expr` syntax, never
// free-text annotation prose. Scans every `loopover_*`-shaped token in every alert's annotation text and
// asserts it is either a real registered metric (src/selfhost/metrics.ts's DEFAULT_METRIC_META) or matches
// one of the documented external-source prefixes (the backup exporter, the opt-in Cloudflare D1 probe, and
// the miner CLI's own pushed metrics -- none of which register through DEFAULT_METRIC_META).

interface AlertRule {
  alert: string;
  annotations?: Record<string, string>;
}
interface AlertGroup {
  name: string;
  rules: AlertRule[];
}
interface AlertsDoc {
  groups: AlertGroup[];
}

// Prefixes documented at the top of their respective rule groups in prometheus/rules/alerts.yml as coming
// from a source other than this process's own in-memory metrics registry.
const EXTERNAL_METRIC_PREFIXES = ["loopover_backup_", "loopover_d1_", "loopover_miner_"];

const METRIC_TOKEN_PATTERN = /loopover_[a-z0-9_]+\*?/g;

/** Every `loopover_*`-shaped token (a trailing `*` denotes a deliberate label-wildcard family reference, e.g.
 *  "loopover_jobs_rate_limit_* labels") found across every alert's annotation values. */
function annotationMetricTokens(doc: AlertsDoc): { alert: string; token: string }[] {
  const found: { alert: string; token: string }[] = [];
  for (const group of doc.groups) {
    for (const rule of group.rules) {
      for (const text of Object.values(rule.annotations ?? {})) {
        for (const match of text.matchAll(METRIC_TOKEN_PATTERN)) {
          found.push({ alert: rule.alert, token: match[0] });
        }
      }
    }
  }
  return found;
}

/** True when `token` resolves to a real metric: an exact match in `registeredNames`, a wildcard prefix
 *  (trailing `*`) matched by at least one registered name, or one of the documented external prefixes. */
function isKnownMetricToken(token: string, registeredNames: ReadonlySet<string>): boolean {
  if (token.endsWith("*")) {
    const prefix = token.slice(0, -1);
    return [...registeredNames].some((name) => name.startsWith(prefix));
  }
  if (EXTERNAL_METRIC_PREFIXES.some((prefix) => token.startsWith(prefix))) return true;
  return registeredNames.has(token);
}

/** Every annotation metric-name reference that resolves to neither a registered metric, a recognized
 *  wildcard family, nor a documented external prefix -- a dangling/stale reference. */
function findUnknownMetricReferences(doc: AlertsDoc, registeredNames: ReadonlySet<string>): { alert: string; token: string }[] {
  return annotationMetricTokens(doc).filter(({ token }) => !isKnownMetricToken(token, registeredNames));
}

const registeredNames = new Set(DEFAULT_METRIC_META.map(([name]) => name));

describe("alert annotation metric-name references (#5816)", () => {
  it("references only registered metrics, a recognized wildcard family, or a documented external prefix in the real alerts.yml", () => {
    const doc = parseYaml(readFileSync("prometheus/rules/alerts.yml", "utf8")) as AlertsDoc;
    expect(findUnknownMetricReferences(doc, registeredNames)).toEqual([]);
  });

  it("flags a fabricated, never-registered metric name referenced in an annotation", () => {
    const fixture: AlertsDoc = {
      groups: [
        {
          name: "fixture-group",
          rules: [{ alert: "FixtureAlert", annotations: { runbook: "Check loopover_totally_made_up_metric_total for drift." } }],
        },
      ],
    };
    expect(findUnknownMetricReferences(fixture, registeredNames)).toEqual([{ alert: "FixtureAlert", token: "loopover_totally_made_up_metric_total" }]);
  });

  it("does not flag a documented external-prefix metric or a wildcard label-family reference", () => {
    const fixture: AlertsDoc = {
      groups: [
        {
          name: "fixture-group",
          rules: [
            {
              alert: "FixtureExternalAndWildcard",
              annotations: {
                runbook: "loopover_backup_files and loopover_d1_database_size_bytes are external. loopover_jobs_rate_limit_* covers the whole family.",
              },
            },
          ],
        },
      ],
    };
    expect(findUnknownMetricReferences(fixture, registeredNames)).toEqual([]);
  });
});
