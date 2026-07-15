import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// #5805: the fleet-mode miner (docker-compose.miner.yml, named `miner-data` volume) and ORB's
// `ams-reporting-exporter` (root docker-compose.yml, `ams-observability` profile, host bind mount) were authored in
// the same wave but never cross-checked, so their ledger locations silently didn't line up. The opt-in override
// (docker-compose.miner.override.yml.example) bridges them by relocating the miner's `/data/miner` state onto the
// SAME host path the exporter reads. This static parity check (no docker required) makes sure the override's bind
// source, the exporter's bind source, and the DEPLOYMENT.md instructions can't silently drift apart again.

const ROOT = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const rootComposeText = read("docker-compose.yml");
const minerComposeText = read("packages/loopover-miner/docker-compose.miner.yml");
const overrideText = read("packages/loopover-miner/docker-compose.miner.override.yml.example");
// The fleet-mode/ams-observability bridging walkthrough moved to the docs website (#6022);
// DEPLOYMENT.md is now a short pointer stub.
const deploymentDoc = read("apps/loopover-ui/src/routes/docs.ams-deployment.tsx");

const rootCompose = parse(rootComposeText) as {
  services: Record<string, { profiles?: string[]; volumes?: string[] }>;
};
const minerCompose = parse(minerComposeText) as {
  services: Record<string, { volumes?: string[] }>;
  volumes?: Record<string, unknown>;
};
const override = parse(overrideText) as {
  services: Record<string, { volumes?: string[] }>;
  volumes?: Record<string, unknown>;
  networks?: Record<string, unknown>;
};

/** Strip a known `:TARGET[:MODE]` suffix off a compose short-syntax volume to recover its source expression
 *  (the source itself contains `${VAR:-default}` colons, so a naive split would break). */
function sourceForTarget(volumes: string[] | undefined, target: string): string {
  const match = (volumes ?? []).find((v) => v.includes(`:${target}`));
  if (!match) throw new Error(`no volume targeting ${target}`);
  return match.slice(0, match.indexOf(`:${target}`));
}

describe("AMS fleet-mode ↔ ams-observability compose bridge (#5805)", () => {
  const EXPECTED_SOURCE = "${LOOPOVER_MINER_CONFIG_DIR:-~/.config/loopover-miner}";

  it("the override bind source matches the exporter's bind source (single shared location)", () => {
    const exporter = rootCompose.services["ams-reporting-exporter"];
    expect(exporter?.profiles).toContain("ams-observability");
    const exporterSource = sourceForTarget(exporter?.volumes, "/ams-ledgers");
    const overrideSource = sourceForTarget(override.services["miner"]?.volumes, "/data/miner");
    // Same variable AND same default ⇒ both profiles read one host directory with zero extra config.
    expect(exporterSource).toBe(EXPECTED_SOURCE);
    expect(overrideSource).toBe(EXPECTED_SOURCE);
    expect(overrideSource).toBe(exporterSource);
  });

  it("the override REPLACES the base /data/miner mount by target (no duplicate-target collision)", () => {
    const baseTarget = "/data/miner";
    // The base fleet miner mounts the named volume at /data/miner...
    expect(sourceForTarget(minerCompose.services["miner"]?.volumes, baseTarget)).toBe("miner-data");
    // ...and the override mounts a host dir at the SAME target, so compose merges them to one mount (the override's),
    // rather than two mounts fighting over /data/miner.
    const overrideMiner = override.services["miner"]?.volumes ?? [];
    expect(overrideMiner.filter((v) => v.includes(`:${baseTarget}`))).toHaveLength(1);
    expect(sourceForTarget(overrideMiner, baseTarget)).toBe(EXPECTED_SOURCE);
  });

  it("the override introduces no top-level volume/network/service name that could collide across the three files", () => {
    // Purely additive to the miner service's volumes — no new top-level declarations to clash with either file.
    expect(override.volumes).toBeUndefined();
    expect(override.networks).toBeUndefined();
    expect(Object.keys(override.services)).toEqual(["miner"]);
  });

  it("the docs.ams-deployment page documents the override, the combined three-file command, and the shared variable", () => {
    expect(deploymentDoc).toContain("Running fleet mode alongside ORB's ams-observability profile");
    expect(deploymentDoc).toContain("docker-compose.miner.override.yml");
    // the exact combined invocation, all three -f files present
    expect(deploymentDoc).toContain("-f docker-compose.yml");
    expect(deploymentDoc).toContain("-f packages/loopover-miner/docker-compose.miner.yml");
    expect(deploymentDoc).toContain("-f packages/loopover-miner/docker-compose.miner.override.yml");
    expect(deploymentDoc).toContain("--profile ams-observability up -d");
    expect(deploymentDoc).toContain(EXPECTED_SOURCE);
  });

  it("the root exporter comment cross-links the DEPLOYMENT.md walkthrough", () => {
    expect(rootComposeText).toContain("packages/loopover-miner/DEPLOYMENT.md");
    expect(rootComposeText).toMatch(/fleet mode[\s\S]{0,200}ams-observability/i);
  });
});
