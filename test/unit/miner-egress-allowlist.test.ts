// Tests for #7857's egress-allowlist resolution: given an operator's networkAllowlist + env, what hosts are
// actually allowed. Pure function, no IO -- egress-firewall-config.test.ts covers the text-rendering half,
// and packages/loopover-miner/scripts/verify-egress-firewall.sh is the real, empirically-run proof that the
// generated config actually enforces anything against a live container.
import { describe, expect, it } from "vitest";
import { resolveEgressAllowlist } from "../../packages/loopover-miner/lib/egress-allowlist";
import type { AmsNetworkAllowlist } from "@loopover/engine";

const EMPTY_ALLOWLIST: AmsNetworkAllowlist = { ecosystems: [], extraHosts: [] };

describe("resolveEgressAllowlist (#7857)", () => {
  it("always includes the OS-registry and target-repo-git-remote defaults, with no operator additions", () => {
    const entries = resolveEgressAllowlist(EMPTY_ALLOWLIST);
    const hosts = entries.map((e) => e.host);
    expect(hosts).toContain("deb.debian.org");
    expect(hosts).toContain("security.debian.org");
    expect(hosts).toContain("github.com");
    expect(hosts).toContain("api.github.com");
    expect(hosts).toContain("codeload.github.com");
    expect(hosts).toContain("objects.githubusercontent.com");
    expect(hosts).toContain("raw.githubusercontent.com");
    expect(hosts).toHaveLength(7);
    for (const entry of entries.filter((e) => e.host.includes("debian"))) expect(entry.reason).toBe("os-package-registry");
    for (const entry of entries.filter((e) => e.host.includes("github"))) expect(entry.reason).toBe("target-repo-git-remote");
  });

  it("adds every host for a declared ecosystem, tagged with that ecosystem's reason", () => {
    const entries = resolveEgressAllowlist({ ecosystems: ["pypi"], extraHosts: [] });
    const pypiEntries = entries.filter((e) => e.reason === "ecosystem:pypi");
    expect(pypiEntries.map((e) => e.host).sort()).toEqual(["files.pythonhosted.org", "pypi.org"]);
  });

  it("resolves every recognized ecosystem to at least one real registry host", () => {
    const allEcosystems = ["npm", "pypi", "crates", "go", "rubygems", "packagist", "maven", "nuget"] as const;
    const entries = resolveEgressAllowlist({ ecosystems: [...allEcosystems], extraHosts: [] });
    for (const ecosystem of allEcosystems) {
      const forEcosystem = entries.filter((e) => e.reason === `ecosystem:${ecosystem}`);
      expect(forEcosystem.length).toBeGreaterThan(0);
    }
  });

  it("adds operator-declared extraHosts verbatim, tagged operator-declared", () => {
    const entries = resolveEgressAllowlist({ ecosystems: [], extraHosts: ["api.example.com", "cdn.example.net"] });
    const extra = entries.filter((e) => e.reason === "operator-declared");
    expect(extra.map((e) => e.host).sort()).toEqual(["api.example.com", "cdn.example.net"]);
  });

  it("deduplicates a host that appears in both an ecosystem's registry set and extraHosts, keeping the first reason", () => {
    const entries = resolveEgressAllowlist({ ecosystems: ["npm"], extraHosts: ["registry.npmjs.org"] });
    const matches = entries.filter((e) => e.host === "registry.npmjs.org");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.reason).toBe("ecosystem:npm");
  });

  it("is case-insensitive when deduplicating and normalizes to lowercase", () => {
    const entries = resolveEgressAllowlist({ ecosystems: [], extraHosts: ["API.Example.COM"] });
    const matches = entries.filter((e) => e.host === "api.example.com");
    expect(matches).toHaveLength(1);
  });

  describe("loopover platform hosts -- only added when the corresponding feature is actually configured", () => {
    it("adds nothing platform-specific with an empty env", () => {
      const entries = resolveEgressAllowlist(EMPTY_ALLOWLIST, {});
      expect(entries.some((e) => e.reason === "loopover-platform")).toBe(false);
    });

    it("adds the default broker host (api.loopover.ai) when ORB_ENROLLMENT_SECRET is set", () => {
      const entries = resolveEgressAllowlist(EMPTY_ALLOWLIST, { ORB_ENROLLMENT_SECRET: "orbsec_x" });
      expect(entries).toContainEqual({ host: "api.loopover.ai", reason: "loopover-platform" });
    });

    it("adds the default broker host when #8202/#8246's LOOPOVER_TENANT_SECRET_TOKEN is set instead", () => {
      const entries = resolveEgressAllowlist(EMPTY_ALLOWLIST, { LOOPOVER_TENANT_SECRET_TOKEN: "orbsec_x" });
      expect(entries).toContainEqual({ host: "api.loopover.ai", reason: "loopover-platform" });
    });

    it("uses a custom ORB_BROKER_URL's own hostname instead of the default when broker mode is active", () => {
      const entries = resolveEgressAllowlist(EMPTY_ALLOWLIST, { ORB_ENROLLMENT_SECRET: "s", ORB_BROKER_URL: "https://broker.example.internal" });
      expect(entries).toContainEqual({ host: "broker.example.internal", reason: "loopover-platform" });
      expect(entries.some((e) => e.host === "api.loopover.ai")).toBe(false);
    });

    it("adds the discovery-index host only when LOOPOVER_MINER_DISCOVERY_INDEX_URL is set (opt-in, no default)", () => {
      expect(resolveEgressAllowlist(EMPTY_ALLOWLIST, {}).some((e) => e.reason === "loopover-platform")).toBe(false);
      const entries = resolveEgressAllowlist(EMPTY_ALLOWLIST, { LOOPOVER_MINER_DISCOVERY_INDEX_URL: "https://discovery.loopover.ai" });
      expect(entries).toContainEqual({ host: "discovery.loopover.ai", reason: "loopover-platform" });
    });

    it("adds the Sentry DSN host only when LOOPOVER_MINER_SENTRY_DSN is set", () => {
      const entries = resolveEgressAllowlist(EMPTY_ALLOWLIST, { LOOPOVER_MINER_SENTRY_DSN: "https://abc123@o1.ingest.sentry.io/42" });
      expect(entries).toContainEqual({ host: "o1.ingest.sentry.io", reason: "loopover-platform" });
    });

    it("adds Neon's API host only when ALL THREE LOOPOVER_MINER_NEON_* vars are set (all-or-nothing, matching resolveAttemptDbForkConfig's own gate)", () => {
      expect(
        resolveEgressAllowlist(EMPTY_ALLOWLIST, { LOOPOVER_MINER_NEON_API_KEY: "k", LOOPOVER_MINER_NEON_PROJECT_ID: "p" }).some((e) => e.reason === "loopover-platform"),
      ).toBe(false);
      const entries = resolveEgressAllowlist(EMPTY_ALLOWLIST, {
        LOOPOVER_MINER_NEON_API_KEY: "k",
        LOOPOVER_MINER_NEON_PROJECT_ID: "p",
        LOOPOVER_MINER_NEON_PARENT_BRANCH_ID: "b",
      });
      expect(entries).toContainEqual({ host: "console.neon.tech", reason: "loopover-platform" });
    });

    it("falls back to the default broker host when ORB_BROKER_URL itself is malformed but broker mode is active (harmless: broker-client.ts's own orbBrokerBaseUrl throws before ever using it)", () => {
      const entries = resolveEgressAllowlist(EMPTY_ALLOWLIST, { ORB_ENROLLMENT_SECRET: "s", ORB_BROKER_URL: "not a url" });
      expect(entries).toContainEqual({ host: "api.loopover.ai", reason: "loopover-platform" });
    });

    it("tolerates a malformed URL in a platform env var without throwing, falling back to no host added (except the broker's own hardcoded default)", () => {
      expect(() => resolveEgressAllowlist(EMPTY_ALLOWLIST, { LOOPOVER_MINER_SENTRY_DSN: "not a url" })).not.toThrow();
      const entries = resolveEgressAllowlist(EMPTY_ALLOWLIST, { LOOPOVER_MINER_SENTRY_DSN: "not a url" });
      expect(entries.some((e) => e.reason === "loopover-platform")).toBe(false);
    });

    it("defaults env to an empty object when not passed at all", () => {
      expect(() => resolveEgressAllowlist(EMPTY_ALLOWLIST)).not.toThrow();
    });
  });
});
