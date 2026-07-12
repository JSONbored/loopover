import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

function readYaml(path: string): unknown {
  return parse(readFileSync(join(process.cwd(), path), "utf8"));
}

function record(value: unknown): Record<string, any> {
  expect(value).toBeTruthy();
  expect(typeof value).toBe("object");
  return value as Record<string, any>;
}

type DashboardTarget = {
  expr?: string;
  queryType?: string;
  projectIds?: string[];
  issuesQuery?: string;
  issuesSort?: string;
  eventsStatsQuery?: string;
  eventsStatsYAxis?: string[];
};
type DashboardPanel = {
  title?: string;
  type?: string;
  datasource?: { type?: string; uid?: string };
  targets?: DashboardTarget[];
};
type Dashboard = { uid: string; title: string; tags: string[]; panels: DashboardPanel[] };

const dashboardPath = join(process.cwd(), "grafana/dashboards/sentry-issues.json");
function readDashboard(): Dashboard {
  return JSON.parse(readFileSync(dashboardPath, "utf8")) as Dashboard;
}
function allTargets(dashboard = readDashboard()): DashboardTarget[] {
  return dashboard.panels.flatMap((panel) => panel.targets ?? []);
}

describe("Grafana Sentry data source (#5369)", () => {
  it("installs the grafana-sentry-datasource plugin, confirmed Grafana-signed and installable on the pinned Grafana version", () => {
    const compose = record(readYaml("docker-compose.yml"));
    const grafana = record(record(compose.services).grafana);
    expect(grafana.environment?.GF_INSTALL_PLUGINS).toContain("grafana-sentry-datasource");
    // Never regress the two plugins already relied on elsewhere.
    expect(grafana.environment?.GF_INSTALL_PLUGINS).toContain("frser-sqlite-datasource");
    expect(grafana.environment?.GF_INSTALL_PLUGINS).toContain("grafana-github-datasource");
  });

  it("is API-provisioned (no file-based YAML datasource), matching the GitHub data source's own boot-crash-avoidance rationale", () => {
    const datasourceFiles = readdirSync(join(process.cwd(), "grafana/provisioning/datasources"));
    for (const file of datasourceFiles) {
      const contents = readFileSync(join(process.cwd(), "grafana/provisioning/datasources", file), "utf8");
      expect(contents, file).not.toContain("grafana-sentry-datasource");
    }
  });

  it("ships an idempotent setup-sentry-datasource.sh that requires a token DISTINCT from SENTRY_DSN", () => {
    const script = readFileSync(join(process.cwd(), "scripts/setup-sentry-datasource.sh"), "utf8");

    expect(script).toContain("SENTRY_API_TOKEN");
    expect(script).toContain("SENTRY_ORG_SLUG");
    expect(script).toContain("grafana-sentry-datasource");
    // The whole point of this script's own doc comment: a DSN cannot substitute for the API token.
    expect(script).toMatch(/SENTRY_DSN.*NOT sufficient|not sufficient.*SENTRY_DSN|NOT reusable|cannot be reused/i);
    // Idempotent update-vs-create, mirroring setup-github-datasource.sh's own pattern.
    expect(script).toContain("api/datasources/uid/sentry");
    expect(script).toMatch(/-X PUT/);
    expect(script).toMatch(/-X POST/);
    expect(script).toContain("secureJsonData");
    expect(script).toContain("authToken");
    expect(script).toContain("orgSlug");
    // Health check, same shape as the GitHub script.
    expect(script).toContain("/health");
  });

  it("keeps Sentry and Grafana credentials out of curl argv and child environments", () => {
    const script = readFileSync(join(process.cwd(), "scripts/setup-sentry-datasource.sh"), "utf8");

    expect(script).not.toContain("set -a");
    expect(script).not.toContain('AUTH="admin:${GRAFANA_ADMIN_PASSWORD}"');
    expect(script).not.toContain('-u "$AUTH"');
    expect(script).not.toContain('-d "$(payload)"');
    expect(script).toContain('--netrc-file "$NETRC_FILE"');
    expect(script).toContain('--data-binary @-');
    expect(script).toMatch(/env -u GRAFANA_ADMIN_PASSWORD -u SENTRY_API_TOKEN curl/);
  });

  it("setup-sentry-datasource.sh is executable, matching setup-github-datasource.sh's own mode", () => {
    const mode = statSync(join(process.cwd(), "scripts/setup-sentry-datasource.sh")).mode;
    // Owner-execute bit (0o100).
    expect(mode & 0o100).not.toBe(0);
  });

  it("documents SENTRY_API_TOKEN/SENTRY_ORG_SLUG in .env.example, distinct from the existing SENTRY_DSN block", () => {
    const env = readFileSync(join(process.cwd(), ".env.example"), "utf8");
    expect(env).toContain("SENTRY_API_TOKEN");
    expect(env).toContain("SENTRY_ORG_SLUG");
    expect(env).toContain("setup-sentry-datasource.sh");
  });

  it("declares the expected uid/title/tags and a $DS_SENTRY datasource-type template variable", () => {
    const dashboard = readDashboard();
    expect(dashboard.uid).toBe("gittensory-sentry");
    expect(dashboard.title).toBe("Gittensory — Sentry issues");
    expect(dashboard.tags).toEqual(["gittensory", "sentry", "observability"]);
  });

  it("every panel uses the grafana-sentry-datasource type and the ${DS_SENTRY} variable, never a hardcoded uid", () => {
    const dashboard = readDashboard();
    for (const panel of dashboard.panels) {
      if (panel.type === "row") continue;
      expect(panel.datasource?.type, panel.title).toBe("grafana-sentry-datasource");
      expect(panel.datasource?.uid, panel.title).toBe("${DS_SENTRY}");
    }
  });

  it("uses the real query schema confirmed against the live plugin (queryType/issuesQuery/issuesSort/eventsStatsYAxis)", () => {
    const targets = allTargets();
    expect(targets.some((t) => t.queryType === "eventsStats" && t.eventsStatsQuery === "event.type:error" && t.eventsStatsYAxis?.includes("count()"))).toBe(true);
    expect(targets.some((t) => t.queryType === "issues" && t.issuesQuery === "is:unresolved" && t.issuesSort === "date")).toBe(true);
    expect(targets.some((t) => t.queryType === "issues" && t.issuesQuery === "is:unresolved" && t.issuesSort === "freq")).toBe(true);
    for (const target of targets) {
      expect(Array.isArray(target.projectIds), JSON.stringify(target)).toBe(true);
    }
  });

  it("links the new in-Grafana Sentry dashboard from resource-hub.json, without dropping the existing external Sentry link", () => {
    const hub = JSON.parse(readFileSync(join(process.cwd(), "grafana/dashboards/resource-hub.json"), "utf8")) as {
      links: Array<{ title?: string; url?: string }>;
      panels: Array<{ options?: { content?: string } }>;
    };
    expect(hub.links.some((l) => l.title === "Sentry — errors")).toBe(true);
    const markdown = hub.panels.map((p) => p.options?.content ?? "").join("\n");
    expect(markdown).toContain("/d/gittensory-sentry");
  });
});
