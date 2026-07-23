// CLI entry for #7857's egress-firewall setup: resolve the operator's own `.loopover-ams.yml`
// (`networkAllowlist`), turn it into the concrete allowlist (egress-allowlist.ts), render dnsmasq config +
// an iptables/ipset ruleset (egress-firewall-config.ts), and write both to disk. Invoked by
// egress-firewall-entrypoint.sh as root, before dropping privileges to the `node` user -- this script only
// ever WRITES config files, it never itself calls `iptables`/`dnsmasq`/`ipset` (the shell entrypoint does that,
// keeping every actual privileged syscall in one small, auditable place).
//
// Runs once at container start: `.loopover-ams.yml` is an operator-local file (not per-attempt/per-repo), and
// `LOOPOVER_MINER_CONFIG_DIR` (where it lives) is already a real env var at container boot -- no attempt-
// specific context is needed to resolve it.
//
// LOOPOVER_MINER_DISABLE_EGRESS_FIREWALL (#7857's documented escape hatch) is checked HERE, not in the shell
// entrypoint -- keeps the disable decision in one testable place, and the entrypoint script unconditional
// (always: generate, start dnsmasq, apply whatever ruleset was written -- real or no-op).
import { writeFileSync } from "node:fs";
import { resolveAmsPolicy } from "./ams-policy.js";
import { resolveEgressAllowlist } from "./egress-allowlist.js";
import { renderDisabledRuleset, renderDnsmasqConfig, renderIptablesRuleset } from "./egress-firewall-config.js";

export async function generateEgressFirewallConfig(
  dnsmasqConfigPath: string,
  rulesetScriptPath: string,
  env: Record<string, string | undefined> = process.env,
): Promise<{ allowedHostCount: number; disabled: boolean }> {
  // #7857's own policy resolver deliberately ignores repoFullName (this is the OPERATOR's own local policy,
  // never a target-repo concern) -- passing an empty string is the documented no-op for that unused parameter.
  const { spec } = await resolveAmsPolicy("", { env });
  const entries = resolveEgressAllowlist(spec.networkAllowlist, env);
  writeFileSync(dnsmasqConfigPath, renderDnsmasqConfig(entries), "utf8");

  const disabled = Boolean(env.LOOPOVER_MINER_DISABLE_EGRESS_FIREWALL);
  if (disabled) {
    console.warn(JSON.stringify({ event: "egress_firewall_disabled", message: "LOOPOVER_MINER_DISABLE_EGRESS_FIREWALL is set -- running with NO network-egress restriction" }));
  }
  writeFileSync(rulesetScriptPath, disabled ? renderDisabledRuleset() : renderIptablesRuleset(entries), { encoding: "utf8", mode: 0o755 });
  return { allowedHostCount: entries.length, disabled };
}

function main(): void {
  const [, , dnsmasqConfigPath, rulesetScriptPath] = process.argv;
  if (!dnsmasqConfigPath || !rulesetScriptPath) {
    console.error(JSON.stringify({ event: "egress_firewall_config_missing_args", message: "usage: generate-egress-firewall-config.js <dnsmasq-conf-path> <ruleset-script-path>" }));
    process.exit(1);
  }
  generateEgressFirewallConfig(dnsmasqConfigPath, rulesetScriptPath)
    .then(({ allowedHostCount, disabled }) => {
      console.log(JSON.stringify({ event: "egress_firewall_config_generated", allowedHostCount, disabled, dnsmasqConfigPath, rulesetScriptPath }));
    })
    .catch((error: unknown) => {
      console.error(JSON.stringify({ event: "egress_firewall_config_generation_failed", message: error instanceof Error ? error.message : String(error) }));
      process.exit(1);
    });
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
