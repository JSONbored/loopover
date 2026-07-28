import { afterEach, describe, expect, it } from "vitest";
import { getRedeployTrigger, setRedeployTrigger, getSecretRotator, setSecretRotator } from "../../src/mcp/redeploy-companion-registry";

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

describe("secret rotator slot (#9543)", () => {
  afterEach(() => {
    setSecretRotator(null);
  });

  it("returns null before anything is set", () => {
    expect(getSecretRotator()).toBeNull();
  });

  it("returns the injected rotator and passes both arguments through", async () => {
    const calls: Array<[string, string]> = [];
    setSecretRotator(async (secret, value) => {
      calls.push([secret, value]);
      return { ok: true };
    });
    const rotator = getSecretRotator();
    expect(rotator).not.toBeNull();
    await expect(rotator!("claude_code_oauth_token", "sk-ant-x")).resolves.toEqual({ ok: true });
    expect(calls).toEqual([["claude_code_oauth_token", "sk-ant-x"]]);
  });

  it("clears back to null", () => {
    setSecretRotator(async () => ({ ok: true }));
    setSecretRotator(null);
    expect(getSecretRotator()).toBeNull();
  });

  it("is independent of the redeploy trigger slot", () => {
    setSecretRotator(async () => ({ ok: true }));
    expect(getRedeployTrigger()).toBeNull();
    expect(getSecretRotator()).not.toBeNull();
  });
});
