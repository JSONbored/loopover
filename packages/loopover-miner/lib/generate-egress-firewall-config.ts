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

/** Injectable IO for {@link main} -- lets tests exercise the real CLI-entry logic in-process (asserting on
 *  what gets logged/exited) without a subprocess, the same pattern `scripts/check-miner-deployment-docs.ts`'s
 *  own `main(env, io)` already uses in this codebase. */
export type GenerateEgressFirewallConfigIo = {
  argv: string[];
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: (code: number) => void;
};

export async function main(
  io: GenerateEgressFirewallConfigIo = { argv: process.argv, log: console.log.bind(console), error: console.error.bind(console), exit: (code) => process.exit(code) },
): Promise<void> {
  const [, , dnsmasqConfigPath, rulesetScriptPath] = io.argv;
  if (!dnsmasqConfigPath || !rulesetScriptPath) {
    io.error(JSON.stringify({ event: "egress_firewall_config_missing_args", message: "usage: generate-egress-firewall-config.js <dnsmasq-conf-path> <ruleset-script-path>" }));
    io.exit(1);
    return;
  }
  try {
    const { allowedHostCount, disabled } = await generateEgressFirewallConfig(dnsmasqConfigPath, rulesetScriptPath);
    io.log(JSON.stringify({ event: "egress_firewall_config_generated", allowedHostCount, disabled, dnsmasqConfigPath, rulesetScriptPath }));
  } catch (error) {
    /* v8 ignore next -- this call site's only real error sources (fs writes, the tolerant-by-contract
     * resolveAmsPolicy) always throw real Error instances; the non-Error side of this ternary is defensive
     * against a future dependency change, not reachable through any input this function's own tests can drive. */
    io.error(JSON.stringify({ event: "egress_firewall_config_generation_failed", message: error instanceof Error ? error.message : String(error) }));
    io.exit(1);
  }
}

/* v8 ignore next -- subprocess-only executed (same convention as bin/loopover-miner.ts's own dispatcher tail,
 * see the packages/loopover-miner/bin note in vitest.config.ts's coverage.include): main()'s own body is fully
 * unit-covered in-process above via injectable IO; only this self-invocation guard's true branch requires
 * actually running the file as `node generate-egress-firewall-config.js`, which egress-firewall-entrypoint.sh
 * does in production and packages/loopover-miner/scripts/verify-egress-firewall.sh proves end to end. */
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) void main();
