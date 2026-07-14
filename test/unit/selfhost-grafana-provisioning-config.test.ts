import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

type DashboardProvider = { name: string; folder: string; type: string; disableDeletion: boolean; editable: boolean; options: { path: string } };
type ProviderConfig = { apiVersion: number; providers: DashboardProvider[] };

const providerPath = join(process.cwd(), "grafana/provisioning/dashboards/provider.yml");

function readProviderConfig(): ProviderConfig {
  return parse(readFileSync(providerPath, "utf8")) as ProviderConfig;
}

describe("LoopOver — Grafana dashboard file-provisioner config (#orb-grafana-dashboard-uid-collision)", () => {
  it("REGRESSION: disableDeletion stays false so a renamed/removed dashboard's stale uid is cleaned up", () => {
    // disableDeletion: true silently orphans the OLD uid in Grafana's own database forever whenever a
    // dashboard file's uid changes (e.g. a future rebrand or dashboard rename) -- the provisioner then
    // hard-fails re-provisioning the NEW uid with an internal-id collision against that orphan, on every
    // subsequent deploy/restart, until someone manually reconciles Grafana's DB by hand. false lets the
    // provisioner delete an orphaned dashboard the moment its file/uid disappears, so this stack's
    // Grafana dashboards stay reconciled to the git-tracked file set the way every other config-as-code
    // source of truth here already works.
    const config = readProviderConfig();
    const provider = config.providers.find((p) => p.name === "loopover");
    expect(provider?.disableDeletion).toBe(false);
  });

  it("still points at the bind-mounted dashboards directory and the LoopOver folder", () => {
    const config = readProviderConfig();
    const provider = config.providers.find((p) => p.name === "loopover");
    expect(provider?.type).toBe("file");
    expect(provider?.folder).toBe("LoopOver");
    expect(provider?.options.path).toBe("/var/lib/grafana/dashboards");
  });
});
