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

// #9139: alertmanager.yml's inhibit-rule EXAMPLES reference a Prometheus alertname by string
// (`alertname="…"`), entirely inside YAML comments (every inhibit_rules block ships commented-out until an
// operator opts in) -- so parseYaml can never see them; a plain regex scan over the RAW file text is the
// only way to catch a stale/misspelled name before an operator uncomments it and gets a rule that silently
// never inhibits (the exact live bug: `alertname="LoopOverTargetDown"`, capital O, against the real rule
// `LoopoverTargetDown`).
const ALERTNAME_PATTERN = /alertname="([A-Za-z0-9_]+)"/g;

/** Every `alertname="…"` value referenced anywhere in `text` (comments included), in order of appearance. */
function alertnameReferences(text: string): string[] {
  return [...text.matchAll(ALERTNAME_PATTERN)].map((match) => match[1]!);
}

/** Every referenced alertname that does NOT match a real `alert:` rule name in `knownAlertNames`. */
function findUnknownAlertnameReferences(text: string, knownAlertNames: ReadonlySet<string>): string[] {
  return alertnameReferences(text).filter((name) => !knownAlertNames.has(name));
}

describe("alertmanager.yml alertname references (#9139)", () => {
  const alertsDoc = parseYaml(readFileSync("prometheus/rules/alerts.yml", "utf8")) as AlertsDoc;
  const knownAlertNames = new Set(alertsDoc.groups.flatMap((group) => group.rules.map((rule) => rule.alert)));

  it("resolves every alertname reference in the real alertmanager.yml (including commented inhibit-rule examples) to a real alerts.yml rule", () => {
    const raw = readFileSync("alertmanager/alertmanager.yml", "utf8");
    // Sanity: the file actually contains at least one alertname reference to check -- otherwise this
    // assertion would trivially pass even if the commented example were deleted entirely.
    expect(alertnameReferences(raw).length).toBeGreaterThan(0);
    expect(findUnknownAlertnameReferences(raw, knownAlertNames)).toEqual([]);
  });

  it("REGRESSION (#9139): flags the exact prior live bug -- a capitalization mismatch against the real rule name", () => {
    const fixture = '#   - source_matchers:\n#       - alertname="LoopOverTargetDown"\n';
    expect(findUnknownAlertnameReferences(fixture, knownAlertNames)).toEqual(["LoopOverTargetDown"]);
    // The corrected spelling is a real rule and is not flagged (the fix this regression test pins).
    expect(findUnknownAlertnameReferences('alertname="LoopoverTargetDown"', knownAlertNames)).toEqual([]);
  });

  it("does not flag a fabricated, never-registered alertname", () => {
    expect(findUnknownAlertnameReferences('alertname="TotallyMadeUpAlertThatDoesNotExist"', knownAlertNames)).toEqual([
      "TotallyMadeUpAlertThatDoesNotExist",
    ]);
  });
});

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
