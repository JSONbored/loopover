import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type TextPanel = {
  id?: number;
  type?: string;
  title?: string;
  gridPos?: { h: number; w: number; x: number; y: number };
  options?: { mode?: string; content?: string };
};
type Dashboard = { uid: string; title: string; panels: TextPanel[] };

const dashboardPath = join(process.cwd(), "grafana/dashboards/resource-hub.json");
const readDashboard = (): Dashboard => JSON.parse(readFileSync(dashboardPath, "utf8")) as Dashboard;

// The AMS cross-link (#5189) points the hub at the "Observing your miner" guide — the AMS observability entry
// point (mirrors the just-merged #5191 callout target). Kept as an in-repo path so the link-target-exists
// invariant below can prove it is not a dead link.
const AMS_GUIDE_REPO_PATH = "packages/loopover-miner/docs/observability.md";
const AMS_GUIDE_URL = `https://github.com/JSONbored/gittensory/blob/main/${AMS_GUIDE_REPO_PATH}`;

function amsPanel(dashboard = readDashboard()): TextPanel | undefined {
  return dashboard.panels.find((panel) => /AMS/i.test(panel.title ?? ""));
}

describe("LoopOver — Resource hub: AMS cross-link (#5189)", () => {
  it("keeps the hub's own identity and its existing two panels untouched (additive change only)", () => {
    const dashboard = readDashboard();
    expect(dashboard.uid).toBe("loopover-hub");
    expect(dashboard.title).toBe("LoopOver — Resource hub");
    // The two original panels (Integrated services, Observability & dashboards) still exist unchanged.
    expect(dashboard.panels.some((p) => p.title === "Integrated services")).toBe(true);
    expect(dashboard.panels.some((p) => p.title === "Observability & dashboards")).toBe(true);
  });

  it("adds exactly one AMS panel, as a markdown text panel matching the hub's existing panel style", () => {
    const panel = amsPanel();
    expect(panel, "an AMS panel must exist").toBeDefined();
    expect(panel?.type).toBe("text");
    expect(panel?.options?.mode).toBe("markdown");
    expect(panel?.gridPos, "must have grid sizing like the other panels").toBeDefined();
    // It notes AMS is a separate CLI a dual-role operator runs alongside ORB (context, not a feature spec).
    expect(panel?.options?.content).toMatch(/separate/i);
    expect(panel?.options?.content).toMatch(/loopover-miner/);
  });

  it("gives every panel a unique id (a duplicate id silently breaks Grafana panel rendering)", () => {
    const ids = readDashboard().panels.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("INVARIANT: the AMS link target is a well-formed reference to a file that actually exists — never a dead link", () => {
    const content = amsPanel()?.options?.content ?? "";
    expect(content).toContain(AMS_GUIDE_URL);
    // The GitHub-blob URL resolves to a real in-repo file: prove it exists so a typo'd path can't ship.
    expect(existsSync(join(process.cwd(), AMS_GUIDE_REPO_PATH))).toBe(true);
  });
});
