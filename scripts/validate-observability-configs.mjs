#!/usr/bin/env node
// Validate Grafana dashboard JSON and Prometheus alert-rule YAML syntax + basic shape (#1943 deliverable:
// "Add validation for dashboard JSON / alert rule syntax"). Catches a broken JSON/YAML file or a
// structurally malformed dashboard/rule before it silently fails to load in the running stack -- Grafana
// and Prometheus both fail OPEN on a malformed file (skip it, log a warning), so nothing else would catch
// this until an operator notices a panel or alert is simply missing.
//
// The alert-rule `expr` check is a lightweight sanity check (balanced brackets, no dangling binary
// operator), NOT a real PromQL parser -- this repo has no promtool/PromQL-grammar dependency, and adding
// one is out of scope for this "if available" deliverable. It catches the obvious copy-paste/typo class
// of mistake; it does not validate PromQL semantics (unknown functions, wrong label matchers, etc.).
import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

// Valid JSON/YAML can parse to a non-object (null, a string, a number, an array of non-objects) --
// dereferencing a property on that crashes instead of producing a validation error. Every dereference
// below goes through this guard first.
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const BINARY_OPERATORS = ["==", "!=", ">=", "<=", ">", "<", "+", "-", "*", "/", "%", "^", "and", "or", "unless"];

// A deliberately lightweight PromQL sanity check -- NOT a real parser (no promtool dependency; see the
// module doc comment). Catches the class of mistake a copy-paste/typo produces: unbalanced brackets, or
// an expression left dangling on a binary operator with no right-hand side (e.g. "up ==").
function promqlSanityIssue(expr) {
  const trimmed = expr.trim();
  // A stack, not a depth counter: a depth counter only checks NESTING COUNT, so "sum(foo[5m))" -- opened
  // with "(" and "[", closed with ")" and ")" -- reaches depth 0 and would wrongly look balanced. The
  // stack checks each closer against the delimiter it's actually supposed to match.
  const pairs = { ")": "(", "]": "[", "}": "{" };
  const opens = new Set(["(", "[", "{"]);
  const stack = [];
  for (const ch of trimmed) {
    if (opens.has(ch)) {
      stack.push(ch);
    } else if (ch in pairs) {
      const top = stack.pop();
      if (top !== pairs[ch]) {
        return `unbalanced brackets (unexpected "${ch}"${top ? `, expected the match for "${top}"` : ""})`;
      }
    }
  }
  if (stack.length > 0) return `unbalanced brackets (unclosed "${stack[stack.length - 1]}")`;
  const lastToken = trimmed.split(/\s+/).pop() ?? "";
  if (BINARY_OPERATORS.includes(lastToken)) {
    return `expression ends in the binary operator "${lastToken}" with no right-hand side`;
  }
  return null;
}

export function validateDashboards(dir) {
  const errors = [];
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch (error) {
    return [`${dir}: could not read directory — ${error.message}`];
  }
  if (files.length === 0) errors.push(`${dir}: no dashboard JSON files found`);
  for (const file of files) {
    const path = `${dir}/${file}`;
    let dashboard;
    try {
      dashboard = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      errors.push(`${path}: invalid JSON — ${error.message}`);
      continue;
    }
    if (!isObject(dashboard)) {
      errors.push(`${path}: top level must be a JSON object, not ${JSON.stringify(dashboard)}`);
      continue;
    }
    if (typeof dashboard.title !== "string" || !dashboard.title) {
      errors.push(`${path}: missing a non-empty top-level "title"`);
    }
    if (!Array.isArray(dashboard.panels)) {
      errors.push(`${path}: missing a top-level "panels" array`);
    }
  }
  return errors;
}

export function validateAlertRules(path) {
  const errors = [];
  let doc;
  try {
    doc = parseYaml(readFileSync(path, "utf8"));
  } catch (error) {
    return [`${path}: invalid YAML — ${error.message}`];
  }
  if (!Array.isArray(doc?.groups)) {
    return [`${path}: missing a top-level "groups" array`];
  }
  for (const [groupIndex, group] of doc.groups.entries()) {
    if (!isObject(group)) {
      errors.push(`${path}: groups[${groupIndex}] must be an object, not ${JSON.stringify(group)}`);
      continue;
    }
    if (typeof group.name !== "string" || !group.name) {
      errors.push(`${path}: a group is missing a non-empty "name"`);
    }
    if (!Array.isArray(group.rules)) {
      errors.push(`${path}: group "${group.name ?? "?"}" is missing a "rules" array`);
      continue;
    }
    for (const [ruleIndex, rule] of group.rules.entries()) {
      if (!isObject(rule)) {
        errors.push(
          `${path}: group "${group.name}" rules[${ruleIndex}] must be an object, not ${JSON.stringify(rule)}`,
        );
        continue;
      }
      const label = rule.alert ?? "(unnamed rule)";
      if (typeof rule.alert !== "string" || !rule.alert) {
        errors.push(`${path}: a rule in group "${group.name}" is missing "alert"`);
      }
      if (typeof rule.expr !== "string" || !rule.expr) {
        errors.push(`${path}: rule "${label}" is missing a non-empty "expr"`);
      } else {
        const issue = promqlSanityIssue(rule.expr);
        if (issue) errors.push(`${path}: rule "${label}" has a suspect "expr" — ${issue}`);
      }
      if (typeof rule.labels?.severity !== "string" || !rule.labels.severity) {
        errors.push(`${path}: rule "${label}" is missing "labels.severity"`);
      }
      if (typeof rule.annotations?.summary !== "string" || !rule.annotations.summary) {
        errors.push(`${path}: rule "${label}" is missing "annotations.summary"`);
      }
    }
  }
  return errors;
}

/* v8 ignore start -- CLI entrypoint; the exported functions above carry the tested logic. */
function main() {
  const errors = [...validateDashboards("grafana/dashboards"), ...validateAlertRules("prometheus/rules/alerts.yml")];
  if (errors.length > 0) {
    console.error(`validate-observability-configs: ${errors.length} problem(s) found:`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log("validate-observability-configs: dashboards and alert rules are valid");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
/* v8 ignore stop */
