import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOOPOVER_API_URL,
  DEFAULT_PROFILE_NAME,
  canonicalProfileName,
  loopoverConfigPath,
  parseLoopoverConfig,
  profileSessionToken,
  resolveLoopoverApiUrl,
} from "@loopover/contract/cli-config";

// #9521: @loopover/mcp writes this config and @loopover/miner reads it, and the miner used to
// hand-copy the resolution ("kept in sync by hand -- there is no shared module to import"). These
// pin the shared policy directly, so a drift in either bin's behavior shows up here first.

// node:path's join, which is what both real callers pass. Declared once so every path case uses the
// same separator handling the bins get.
const deps = { join: (...segments: string[]) => segments.join("/"), homeDir: () => "/home/dev" };

describe("loopoverConfigPath", () => {
  it("honors LOOPOVER_CONFIG_PATH outright, ignoring every other location input", () => {
    const path = loopoverConfigPath(
      { LOOPOVER_CONFIG_PATH: "/etc/loopover.json", LOOPOVER_CONFIG_DIR: "/ignored", XDG_CONFIG_HOME: "/also-ignored" },
      deps,
    );
    expect(path).toBe("/etc/loopover.json");
  });

  it("falls to LOOPOVER_CONFIG_DIR/config.json when no explicit path is set", () => {
    expect(loopoverConfigPath({ LOOPOVER_CONFIG_DIR: "/var/loopover", XDG_CONFIG_HOME: "/ignored" }, deps)).toBe("/var/loopover/config.json");
  });

  it("uses XDG_CONFIG_HOME when neither path nor dir is set", () => {
    expect(loopoverConfigPath({ XDG_CONFIG_HOME: "/xdg" }, deps)).toBe("/xdg/loopover/config.json");
  });

  it("falls all the way back to ~/.config when the environment says nothing", () => {
    expect(loopoverConfigPath({}, deps)).toBe("/home/dev/.config/loopover/config.json");
  });

  it("treats an EMPTY XDG_CONFIG_HOME as unset rather than rooting the path at ''", () => {
    // The `||` is deliberate (not `??`): an empty string here would otherwise produce "/loopover/config.json".
    expect(loopoverConfigPath({ XDG_CONFIG_HOME: "" }, deps)).toBe("/home/dev/.config/loopover/config.json");
  });
});

describe("parseLoopoverConfig", () => {
  it("returns the parsed object for a well-formed config", () => {
    expect(parseLoopoverConfig('{"activeProfile":"work"}')).toEqual({ activeProfile: "work" });
  });

  it.each([
    ["a null body (file absent)", null],
    ["an undefined body", undefined],
    ["an empty body", ""],
    ["malformed JSON", "{not json"],
    ["a JSON array", "[1,2,3]"],
    ["a JSON scalar", "42"],
    ["a JSON null", "null"],
  ])("degrades to {} for %s rather than throwing", (_label, body) => {
    expect(parseLoopoverConfig(body)).toEqual({});
  });
});

describe("canonicalProfileName", () => {
  it.each([
    ["work", "work"],
    ["  WORK  ", "work"],
    ["a.b-c_d", "a.b-c_d"],
    ["0", "0"],
  ])("canonicalizes %s to %s", (input, expected) => {
    expect(canonicalProfileName(input)).toBe(expected);
  });

  it.each([
    ["an empty name", ""],
    ["a name starting with punctuation", "-nope"],
    ["a name with illegal characters", "no spaces"],
    ["a name over 64 characters", "a".repeat(65)],
    ["null", null],
    ["undefined", undefined],
  ])("rejects %s with null", (_label, input) => {
    expect(canonicalProfileName(input)).toBeNull();
  });

  it("accepts exactly 64 characters, the documented ceiling", () => {
    expect(canonicalProfileName("a".repeat(64))).toBe("a".repeat(64));
  });
});

describe("profileSessionToken", () => {
  it("returns the recorded token", () => {
    expect(profileSessionToken({ session: { token: "tok_1" } })).toBe("tok_1");
  });

  it.each([
    ["an undefined profile", undefined],
    ["a profile with no session", {}],
    ["a null session", { session: null }],
    ["a non-string token", { session: { token: 7 } }],
    ["an empty token", { session: { token: "" } }],
  ])("returns null for %s", (_label, profile) => {
    expect(profileSessionToken(profile)).toBeNull();
  });
});

describe("resolveLoopoverApiUrl", () => {
  it("lets LOOPOVER_API_URL win over everything, trailing slashes stripped", () => {
    expect(resolveLoopoverApiUrl({ LOOPOVER_API_URL: "https://env.example//" }, { apiUrl: "https://config.example" }, { apiUrl: "https://profile.example" })).toBe("https://env.example");
  });

  it("prefers the active profile's apiUrl over the config's", () => {
    expect(resolveLoopoverApiUrl({}, { apiUrl: "https://config.example" }, { apiUrl: "https://profile.example/" })).toBe("https://profile.example");
  });

  it("falls to the config's top-level apiUrl when the profile has none", () => {
    expect(resolveLoopoverApiUrl({}, { apiUrl: "https://config.example" }, {})).toBe("https://config.example");
  });

  it("REGRESSION: keeps looking past a LEGACY profile apiUrl instead of dropping to the default", () => {
    // The divergence the two hand-copies had (#8854/#9521): @loopover/mcp stopped at the legacy value
    // and returned the default, masking a perfectly good top-level override.
    expect(resolveLoopoverApiUrl({}, { apiUrl: "https://config.example" }, { apiUrl: "https://gittensory-api.aethereal.dev" })).toBe("https://config.example");
  });

  it("returns the default when every candidate is legacy", () => {
    expect(
      resolveLoopoverApiUrl({}, { apiUrl: "https://gittensory-api.zeronode.workers.dev" }, { apiUrl: "https://gittensory-api.aethereal.dev" }),
    ).toBe(DEFAULT_LOOPOVER_API_URL);
  });

  it.each([
    ["a non-string apiUrl", { apiUrl: 42 }],
    ["a whitespace-only apiUrl", { apiUrl: "   " }],
    ["an undefined profile", undefined],
  ])("skips %s and returns the default when nothing else is configured", (_label, profile) => {
    expect(resolveLoopoverApiUrl({}, {}, profile)).toBe(DEFAULT_LOOPOVER_API_URL);
  });

  it("exposes 'default' as the default profile name both bins fall back to", () => {
    expect(DEFAULT_PROFILE_NAME).toBe("default");
  });
});
