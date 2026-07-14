import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// REGRESSION guard (#orb-grafana-ai-usage-all-filter, 2026-07-14): a hand-rolled SQL "no filter" sentinel
// must never itself look like one of Grafana's reserved `$__`-prefixed global macros (`$__all`, `$__from`,
// `$__to`, `$__interval`, ...). Confirmed live against a real Grafana + frser-sqlite-datasource instance:
// `${var:sqlstring}` does NOT sql-quote a value that starts with `$__` (Grafana treats it as a macro
// reference, not literal data), so a query comparing a variable against a literal '$__all' sentinel gets a
// raw, UNQUOTED token substituted in — which SQLite then misparses as its own `$__` named bind parameter,
// silently returning zero rows or erroring outright, even with real underlying data. This shipped
// undetected in ai-usage.json/maintainer-reviews.json/miner-usage.json until a live incident surfaced it
// (see those files' own git history + selfhost-grafana-ai-usage-dashboard.test.ts's doc comment). A plain
// string (e.g. `__ALL__`) sidesteps the ambiguity entirely and is the pattern every dashboard now uses.

const dashboardsDir = join(process.cwd(), "grafana/dashboards");

type TemplateVar = { name: string; allValue?: string; current?: { value?: string } };
type Dashboard = { uid?: string; templating?: { list?: TemplateVar[] } };

function dashboardFiles(): string[] {
  return readdirSync(dashboardsDir).filter((f) => f.endsWith(".json"));
}

function readDashboard(file: string): { raw: string; parsed: Dashboard } {
  const raw = readFileSync(join(dashboardsDir, file), "utf8");
  return { raw, parsed: JSON.parse(raw) as Dashboard };
}

describe("LoopOver — Grafana dashboards never use a Grafana-reserved $__ macro as a hand-rolled sentinel", () => {
  it.each(dashboardFiles())("%s: no templating variable's allValue/current.value starts with '$__'", (file) => {
    const { parsed } = readDashboard(file);
    for (const templateVar of parsed.templating?.list ?? []) {
      if (typeof templateVar.allValue === "string") {
        expect(templateVar.allValue.startsWith("$__"), `${file} templating var "${templateVar.name}" allValue`).toBe(false);
      }
      if (typeof templateVar.current?.value === "string") {
        expect(templateVar.current.value.startsWith("$__"), `${file} templating var "${templateVar.name}" current.value`).toBe(false);
      }
    }
  });

  it.each(dashboardFiles())("%s: no panel query embeds a '$__' literal as a hand-rolled sentinel comparison", (file) => {
    const { raw } = readDashboard(file);
    // Grafana's own real macros ($__from/$__to/$__interval/etc.) are always used BARE, never inside a
    // quoted string literal -- a quoted occurrence ('$__anything') is exactly the broken pattern this
    // guards against, so only that shape is flagged (bare $__from/$__to usage elsewhere is expected/fine).
    const quotedDollarUnderscoreLiteral = /'\$__[a-zA-Z_]*'/;
    expect(quotedDollarUnderscoreLiteral.test(raw), file).toBe(false);
  });
});
