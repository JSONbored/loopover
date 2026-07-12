import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type DashboardTarget = { expr?: string; legendFormat?: string };
type DashboardPanel = {
  id?: number;
  title?: string;
  type?: string;
  description?: string;
  datasource?: { type?: string; uid?: string };
  targets?: DashboardTarget[];
};
type Dashboard = {
  uid: string;
  title: string;
  tags: string[];
  panels: DashboardPanel[];
};

const dashboardPath = join(process.cwd(), "grafana/dashboards/infra-health.json");

function readDashboard(): Dashboard {
  return JSON.parse(readFileSync(dashboardPath, "utf8")) as Dashboard;
}

function allTargets(dashboard = readDashboard()): DashboardTarget[] {
  return dashboard.panels.flatMap((panel) => panel.targets ?? []);
}

describe("Gittensory — Infra Health dashboard (#5366)", () => {
  it("declares the expected uid/title/tags", () => {
    const dashboard = readDashboard();
    expect(dashboard.uid).toBe("gittensory-infra-health");
    expect(dashboard.title).toBe("Gittensory — Infra Health (Host/Container/Redis/Qdrant)");
    expect(dashboard.tags).toEqual(["gittensory", "infra", "observability"]);
  });

  it("every panel target uses the Prometheus datasource variable, never a hardcoded uid", () => {
    const dashboard = readDashboard();
    for (const panel of dashboard.panels) {
      if (panel.type === "row") continue;
      expect(panel.datasource?.type, panel.title).toBe("prometheus");
      expect(panel.datasource?.uid, panel.title).toBe("${DS_PROMETHEUS}");
      for (const target of panel.targets ?? []) {
        expect(target.expr, panel.title).toBeTruthy();
      }
    }
  });

  it("watches every stack component's own /metrics, not just the app's", () => {
    const targets = allTargets();
    expect(targets.some((t) => t.expr === 'up{job="observability-stack"}')).toBe(true);
    expect(targets.some((t) => t.expr === 'up{job=~"node-exporter|cadvisor|redis|qdrant"}')).toBe(true);
  });

  it("never assumes Docker socket access for cAdvisor container labeling (matches the docker-compose.yml service's own no-socket posture)", () => {
    const dashboard = readDashboard();
    const serialized = JSON.stringify(dashboard);
    // No panel query relies on a docker-compose-service label -- that label only exists with Docker API
    // access, which the cadvisor service deliberately doesn't have (see its docker-compose.yml comment).
    expect(serialized).not.toContain("container_label_com_docker_compose_service");

    const cadvisorPanels = dashboard.panels.filter(
      (p) => p.type !== "row" && (p.title ?? "").toLowerCase().includes("container"),
    );
    expect(cadvisorPanels.length).toBeGreaterThan(0);
    for (const panel of cadvisorPanels) {
      // Every container-scoped panel must document the raw-cgroup-ID tradeoff so an operator isn't
      // surprised by unfriendly labels (see the cadvisor service's own comment in docker-compose.yml).
      expect(panel.description ?? "", panel.title).toMatch(/container.?id|docker ps/i);
    }
  });

  it("shortens raw cAdvisor cgroup IDs to a 12-char docker-ps-style prefix via label_replace, never raw multi-segment cgroup paths as the legend", () => {
    const targets = allTargets().filter((t) => t.expr?.includes("container_"));
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(target.expr).toContain('label_replace(');
      expect(target.expr).toContain('"short_id"');
      expect(target.legendFormat).toContain("{{short_id}}");
    }
  });

  it("scopes host disk/network panels to real devices, excluding pseudo-filesystems and loopback", () => {
    const targets = allTargets();
    const diskTarget = targets.find((t) => t.expr?.includes("node_filesystem_avail_bytes"));
    expect(diskTarget?.expr).toContain('fstype!~"tmpfs|overlay|squashfs"');

    const netTargets = targets.filter((t) => t.expr?.includes("node_network_"));
    expect(netTargets.length).toBeGreaterThan(0);
    for (const target of netTargets) {
      expect(target.expr).toContain('device!="lo"');
    }
  });

  it("guards the Redis hit-ratio panel against a divide-by-zero on a cold cache", () => {
    const target = allTargets().find((t) => t.expr?.includes("keyspace_hits_total") && t.expr?.includes("/"));
    expect(target?.expr).toContain("clamp_min(");
  });

  it("uses the real Qdrant metric names confirmed on the live server (collections_total, collections_vector_total, collection_points, rest_responses_total/duration)", () => {
    const targets = allTargets();
    expect(targets.some((t) => t.expr === "collections_total")).toBe(true);
    expect(targets.some((t) => t.expr === "collections_vector_total")).toBe(true);
    expect(targets.some((t) => t.expr === "collection_points")).toBe(true);
    expect(targets.some((t) => t.expr?.includes("rest_responses_total"))).toBe(true);
    expect(targets.some((t) => t.expr?.includes("rest_responses_duration_seconds_bucket"))).toBe(true);
  });
});
