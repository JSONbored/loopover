// Tests for #7857's generate-egress-firewall-config.ts -- the CLI entry that ties the operator's own
// .loopover-ams.yml, egress-allowlist.ts, and egress-firewall-config.ts together and writes the two real
// config files egress-firewall-entrypoint.sh applies. Real filesystem I/O against a scratch temp dir, matching
// miner-ams-policy.test.ts's own convention -- no fs mocking.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { generateEgressFirewallConfig } from "../../packages/loopover-miner/lib/generate-egress-firewall-config";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-egress-firewall-config-"));
  roots.push(root);
  return root;
}

describe("generateEgressFirewallConfig (#7857)", () => {
  it("writes both config files using the engine's safe defaults when no local .loopover-ams.yml exists", async () => {
    const configDir = tempRoot();
    const outDir = tempRoot();
    const dnsmasqPath = join(outDir, "dnsmasq.conf");
    const rulesetPath = join(outDir, "ruleset.sh");

    const result = await generateEgressFirewallConfig(dnsmasqPath, rulesetPath, { LOOPOVER_MINER_CONFIG_DIR: configDir });

    expect(result.allowedHostCount).toBe(7); // 2 OS-registry + 5 GitHub-family defaults, no operator additions
    expect(result.disabled).toBe(false);
    const dnsmasqConfig = readFileSync(dnsmasqPath, "utf8");
    expect(dnsmasqConfig).toContain("ipset=/github.com/loopover_egress_allow");
    const ruleset = readFileSync(rulesetPath, "utf8");
    expect(ruleset).toContain("iptables -P OUTPUT DROP");
  });

  it("writes a no-op ruleset (but still a real dnsmasq config) when LOOPOVER_MINER_DISABLE_EGRESS_FIREWALL is set", async () => {
    const configDir = tempRoot();
    const outDir = tempRoot();
    const dnsmasqPath = join(outDir, "dnsmasq.conf");
    const rulesetPath = join(outDir, "ruleset.sh");

    const result = await generateEgressFirewallConfig(dnsmasqPath, rulesetPath, { LOOPOVER_MINER_CONFIG_DIR: configDir, LOOPOVER_MINER_DISABLE_EGRESS_FIREWALL: "1" });

    expect(result.disabled).toBe(true);
    const dnsmasqConfig = readFileSync(dnsmasqPath, "utf8");
    expect(dnsmasqConfig).toContain("ipset=/github.com/loopover_egress_allow"); // still generated normally
    const ruleset = readFileSync(rulesetPath, "utf8");
    expect(ruleset).not.toContain("iptables");
    expect(ruleset).toContain("exit 0");
  });

  it("reflects the operator's real .loopover-ams.yml networkAllowlist", async () => {
    const configDir = tempRoot();
    const outDir = tempRoot();
    writeFileSync(join(configDir, ".loopover-ams.yml"), "networkAllowlist:\n  ecosystems: [npm]\n  extraHosts: [api.example.com]\n");
    const dnsmasqPath = join(outDir, "dnsmasq.conf");
    const rulesetPath = join(outDir, "ruleset.sh");

    const result = await generateEgressFirewallConfig(dnsmasqPath, rulesetPath, { LOOPOVER_MINER_CONFIG_DIR: configDir });

    expect(result.allowedHostCount).toBe(9); // 7 defaults + registry.npmjs.org + api.example.com
    const dnsmasqConfig = readFileSync(dnsmasqPath, "utf8");
    expect(dnsmasqConfig).toContain("ipset=/registry.npmjs.org/loopover_egress_allow");
    expect(dnsmasqConfig).toContain("ipset=/api.example.com/loopover_egress_allow");
  });

  it("also reflects the miner's own platform hosts when the corresponding env vars are set", async () => {
    const configDir = tempRoot();
    const outDir = tempRoot();
    const dnsmasqPath = join(outDir, "dnsmasq.conf");
    const rulesetPath = join(outDir, "ruleset.sh");

    await generateEgressFirewallConfig(dnsmasqPath, rulesetPath, { LOOPOVER_MINER_CONFIG_DIR: configDir, ORB_ENROLLMENT_SECRET: "s" });

    const dnsmasqConfig = readFileSync(dnsmasqPath, "utf8");
    expect(dnsmasqConfig).toContain("ipset=/api.loopover.ai/loopover_egress_allow");
  });

  it("makes the written ruleset script executable (mode 0o755)", async () => {
    const configDir = tempRoot();
    const outDir = tempRoot();
    const rulesetPath = join(outDir, "ruleset.sh");

    await generateEgressFirewallConfig(join(outDir, "dnsmasq.conf"), rulesetPath, { LOOPOVER_MINER_CONFIG_DIR: configDir });

    const { statSync } = await import("node:fs");
    const mode = statSync(rulesetPath).mode & 0o777;
    expect(mode).toBe(0o755);
  });

  it("defaults env to process.env when not passed", async () => {
    const configDir = tempRoot();
    const outDir = tempRoot();
    await expect(
      generateEgressFirewallConfig(join(outDir, "dnsmasq.conf"), join(outDir, "ruleset.sh"), { ...process.env, LOOPOVER_MINER_CONFIG_DIR: configDir }),
    ).resolves.toBeDefined();
  });
});
