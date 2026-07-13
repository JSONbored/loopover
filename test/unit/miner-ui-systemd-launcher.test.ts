import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(process.cwd());
const SERVICE_PATH = join(REPO_ROOT, "systemd/gittensory-miner-ui.service.example");
const MINER_UI_README_PATH = join(REPO_ROOT, "apps/gittensory-miner-ui/README.md");
const DEPLOYMENT_PATH = join(REPO_ROOT, "packages/gittensory-miner/DEPLOYMENT.md");
const MINER_UI_PACKAGE_JSON_PATH = join(REPO_ROOT, "apps/gittensory-miner-ui/package.json");

describe("miner-ui persistent-service launcher (#4852)", () => {
  it("ships a systemd unit with every directive the main miner's unit requires", () => {
    const unit = readFileSync(SERVICE_PATH, "utf8");
    expect(unit).toContain("[Unit]");
    expect(unit).toContain("[Service]");
    expect(unit).toContain("[Install]");
    expect(unit).toContain("Type=simple");
    expect(unit).toContain("ExecStart=");
    expect(unit).toContain("WorkingDirectory=");
    expect(unit).toContain("User=");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("WantedBy=multi-user.target");
  });

  it("ExecStart targets the real @loopover/ui-miner workspace, not a stale/renamed package name", () => {
    const unit = readFileSync(SERVICE_PATH, "utf8");
    const packageName = JSON.parse(readFileSync(MINER_UI_PACKAGE_JSON_PATH, "utf8")).name;
    expect(unit).toContain(`--workspace ${packageName} run preview`);
  });

  it("does not force --host (the dashboard has no auth of its own)", () => {
    const unit = readFileSync(SERVICE_PATH, "utf8");
    expect(unit).not.toMatch(/ExecStart=.*--host/);
  });

  it("documents the persistent-service launcher in the miner-ui README", () => {
    const readme = readFileSync(MINER_UI_README_PATH, "utf8");
    expect(readme).toContain("## Running as a persistent service");
    expect(readme).toContain("systemd/gittensory-miner-ui.service.example");
    expect(readme).toContain("npm run build");
    expect(readme).toContain("npm run preview");
  });

  it("cross-references the miner-ui service from the main miner's Bare-host deployment doc", () => {
    const deployment = readFileSync(DEPLOYMENT_PATH, "utf8");
    expect(deployment).toContain("gittensory-miner-ui.service.example");
    expect(deployment).toContain("apps/gittensory-miner-ui/README.md#running-as-a-persistent-service");
  });
});
