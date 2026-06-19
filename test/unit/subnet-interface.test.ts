import { describe, expect, it } from "vitest";
import { buildSubnetInterfaceDescriptor, GITTENSOR_NETUID } from "../../src/services/subnet-interface";

describe("buildSubnetInterfaceDescriptor", () => {
  it("declares Gittensory as gittensor SN74's contribution interface", () => {
    const descriptor = buildSubnetInterfaceDescriptor({
      origin: "https://gittensory-api.aethereal.dev/",
      generatedAt: "2026-06-14T00:00:00.000Z",
      appSlug: "gittensory",
      upstreamRepo: "entrius/gittensor",
    });

    expect(GITTENSOR_NETUID).toBe(74);
    expect(descriptor.subnet).toMatchObject({ netuid: 74, name: "gittensor", upstreamRepo: "entrius/gittensor" });
    expect(descriptor.provider).toMatchObject({ name: "Gittensory", role: "contribution_interface" });
    // Trailing slash on origin is normalized before appending /mcp.
    expect(descriptor.interfaces.mcp.endpoint).toBe("https://gittensory-api.aethereal.dev/mcp");
    expect(descriptor.interfaces.mcp.transport).toBe("http");
    expect(descriptor.interfaces.githubApp.installUrl).toBe("https://github.com/apps/gittensory");

    const toolNames = descriptor.interfaces.mcp.tools.map((tool) => tool.name);
    expect(toolNames).toContain("gittensory_get_decision_pack");
    expect(toolNames).toContain("gittensory_list_notifications");
    expect(descriptor.interfaces.mcp.tools.every((tool) => tool.summary.length > 0)).toBe(true);
    expect(descriptor.onboarding.steps.length).toBeGreaterThan(0);
  });

  it("defaults the upstream repo when not provided and contains no private/reward wording", () => {
    const descriptor = buildSubnetInterfaceDescriptor({ origin: "https://x.dev", generatedAt: "2026-06-14T00:00:00.000Z", appSlug: "gittensory" });
    expect(descriptor.subnet.upstreamRepo).toBe("entrius/gittensor");
    expect(JSON.stringify(descriptor)).not.toMatch(/wallet|hotkey|reward|payout|earn|scoring|multiplier|trust score|scoreability|rank(?:ing)?/i);
  });
});
