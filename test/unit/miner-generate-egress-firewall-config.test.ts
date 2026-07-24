// Tests for #7857's generate-egress-firewall-config.ts -- the CLI entry that ties the operator's own
// .loopover-ams.yml, egress-allowlist.ts, and egress-firewall-config.ts together and writes the two real
// config files egress-firewall-entrypoint.sh applies. Real filesystem I/O against a scratch temp dir, matching
// miner-ams-policy.test.ts's own convention -- no fs mocking.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateEgressFirewallConfig, main } from "../../packages/loopover-miner/lib/generate-egress-firewall-config";

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

// #7857: main() is the actual CLI entry egress-firewall-entrypoint.sh invokes -- exercised directly here via
// injectable IO (mirroring scripts/check-miner-deployment-docs.ts's own main(env, io) pattern in this
// codebase), not through a subprocess, so it's real, in-process v8 coverage rather than untestable CLI glue.
function fakeIo(argv: string[]) {
  return {
    io: {
      argv,
      log: vi.fn((..._args: unknown[]) => undefined),
      error: vi.fn((..._args: unknown[]) => undefined),
      exit: vi.fn((_code: number) => undefined),
    },
  };
}

describe("main (#7857)", () => {
  it("errors and exits 1 without attempting generation when either path arg is missing", async () => {
    const { io } = fakeIo(["node", "generate-egress-firewall-config.js"]);

    await main(io);

    expect(io.error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("egress_firewall_config_missing_args"));
    expect(io.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(io.log).not.toHaveBeenCalled();
  });

  it("errors and exits 1 when only one of the two path args is given", async () => {
    const { io } = fakeIo(["node", "generate-egress-firewall-config.js", "/tmp/dnsmasq.conf"]);

    await main(io);

    expect(io.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("logs the real generated-config event and never exits on success", async () => {
    const configDir = tempRoot();
    const outDir = tempRoot();
    const dnsmasqPath = join(outDir, "dnsmasq.conf");
    const rulesetPath = join(outDir, "ruleset.sh");
    const originalConfigDir = process.env.LOOPOVER_MINER_CONFIG_DIR;
    process.env.LOOPOVER_MINER_CONFIG_DIR = configDir;
    const { io } = fakeIo(["node", "generate-egress-firewall-config.js", dnsmasqPath, rulesetPath]);

    try {
      await main(io);
    } finally {
      if (originalConfigDir === undefined) delete process.env.LOOPOVER_MINER_CONFIG_DIR;
      else process.env.LOOPOVER_MINER_CONFIG_DIR = originalConfigDir;
    }

    expect(io.exit).not.toHaveBeenCalled();
    expect(io.error).not.toHaveBeenCalled();
    expect(io.log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("egress_firewall_config_generated"));
    expect(readFileSync(dnsmasqPath, "utf8")).toContain("ipset=/github.com/loopover_egress_allow");
  });

  it("errors and exits 1 (without throwing) when the underlying generation call itself fails", async () => {
    // An output path under a directory that doesn't exist -- writeFileSync inside generateEgressFirewallConfig
    // throws ENOENT, exercising main()'s own catch branch.
    const { io } = fakeIo(["node", "generate-egress-firewall-config.js", "/nonexistent-dir-7857/dnsmasq.conf", "/nonexistent-dir-7857/ruleset.sh"]);

    await main(io);

    expect(io.error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("egress_firewall_config_generation_failed"));
    expect(io.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("constructs its default IO from real process.argv/console/process.exit when no override is passed", async () => {
    const originalArgv = process.argv;
    const originalExit = process.exit;
    const originalError = console.error;
    const calls: { exit: number[]; error: string[] } = { exit: [], error: [] };
    process.exit = ((code?: number) => {
      calls.exit.push(code ?? 0);
      return undefined as never;
    }) as typeof process.exit;
    console.error = (message?: unknown) => {
      calls.error.push(String(message));
    };
    process.argv = ["node", "generate-egress-firewall-config.js"]; // missing both path args -- the cheapest real path to exercise

    try {
      await main();
    } finally {
      process.argv = originalArgv;
      process.exit = originalExit;
      console.error = originalError;
    }

    expect(calls.error).toHaveLength(1);
    expect(calls.error[0]).toContain("egress_firewall_config_missing_args");
    expect(calls.exit).toEqual([1]);
  });
});
