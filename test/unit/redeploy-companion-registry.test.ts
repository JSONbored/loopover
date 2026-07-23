import { afterEach, describe, expect, it } from "vitest";
import { getRedeployTrigger, setRedeployTrigger } from "../../src/mcp/redeploy-companion-registry";

afterEach(() => {
  setRedeployTrigger(null);
});

describe("redeploy-companion-registry (#7723)", () => {
  it("returns null before anything is set", () => {
    expect(getRedeployTrigger()).toBeNull();
  });

  it("returns the exact function passed to setRedeployTrigger", async () => {
    const trigger = async () => ({ ok: true, exitCode: 0, log: [] });
    setRedeployTrigger(trigger);
    expect(getRedeployTrigger()).toBe(trigger);
  });

  it("resets back to null when set with null", () => {
    setRedeployTrigger(async () => ({ ok: true, exitCode: 0, log: [] }));
    setRedeployTrigger(null);
    expect(getRedeployTrigger()).toBeNull();
  });
});
