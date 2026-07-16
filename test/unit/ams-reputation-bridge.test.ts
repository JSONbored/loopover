import { describe, expect, it, vi } from "vitest";
import {
  AMS_BRIDGE_TRUSTED_MIN_MERGED,
  AMS_TRACK_RECORD_TIMEOUT_MS,
  amsRecordQualifiesAsTrusted,
  bridgeAmsReputation,
  fetchAmsTrackRecord,
  outcomesForLogin,
  upgradeReputationSignal,
  type AmsTrackRecordFetch,
} from "../../src/review/ams-reputation-bridge";
import { isAmsReputationBridgeEnabled, resolveAmsTrackRecordEndpoint } from "../../src/review/ams-reputation-bridge-wire";

const ENDPOINT = "https://ams.internal";

function outcome(overrides: Record<string, unknown> = {}) {
  return { repoFullName: "acme/widgets", authorLogin: "dev", state: "merged", ...overrides };
}

/** A fetchImpl returning `body` as JSON with `ok` derived from status. */
function jsonFetch(body: unknown, status = 200): AmsTrackRecordFetch {
  return async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as unknown as Response;
}

describe("isAmsReputationBridgeEnabled (#6485 kill-switch)", () => {
  it("is OFF by default and for falsy/garbage values, ON only for the codebase's truthy convention", () => {
    expect(isAmsReputationBridgeEnabled({})).toBe(false);
    expect(isAmsReputationBridgeEnabled({ LOOPOVER_REVIEW_AMS_REPUTATION_BRIDGE: undefined })).toBe(false);
    expect(isAmsReputationBridgeEnabled({ LOOPOVER_REVIEW_AMS_REPUTATION_BRIDGE: "" })).toBe(false);
    expect(isAmsReputationBridgeEnabled({ LOOPOVER_REVIEW_AMS_REPUTATION_BRIDGE: "false" })).toBe(false);
    expect(isAmsReputationBridgeEnabled({ LOOPOVER_REVIEW_AMS_REPUTATION_BRIDGE: "maybe" })).toBe(false);
    for (const truthy of ["1", "true", "TRUE", "yes", "on", " on "]) {
      expect(isAmsReputationBridgeEnabled({ LOOPOVER_REVIEW_AMS_REPUTATION_BRIDGE: truthy })).toBe(true);
    }
  });
});

describe("resolveAmsTrackRecordEndpoint (#6485 operator config)", () => {
  it("returns the configured URL, and undefined when unset or blank (⇒ no bonus signal)", () => {
    expect(resolveAmsTrackRecordEndpoint({ LOOPOVER_AMS_TRACK_RECORD_URL: ENDPOINT })).toBe(ENDPOINT);
    expect(resolveAmsTrackRecordEndpoint({ LOOPOVER_AMS_TRACK_RECORD_URL: `  ${ENDPOINT}  ` })).toBe(ENDPOINT);
    expect(resolveAmsTrackRecordEndpoint({})).toBeUndefined();
    expect(resolveAmsTrackRecordEndpoint({ LOOPOVER_AMS_TRACK_RECORD_URL: undefined })).toBeUndefined();
    expect(resolveAmsTrackRecordEndpoint({ LOOPOVER_AMS_TRACK_RECORD_URL: "   " })).toBeUndefined();
  });
});

describe("outcomesForLogin", () => {
  it("keeps only the target login's rows, case-insensitively, and drops malformed ones", () => {
    const rows = [
      outcome({ authorLogin: "dev" }),
      outcome({ authorLogin: "DEV" }), // same login, different case
      outcome({ authorLogin: "someone-else" }),
      outcome({ authorLogin: "  " }), // blank login → malformed
      outcome({ authorLogin: 42 }), // non-string login → malformed
      outcome({ state: 7 }), // non-string state → malformed
      { authorLogin: "dev" }, // missing state → malformed
      null,
      "not-an-object",
    ];
    expect(outcomesForLogin(rows, "dev")).toHaveLength(2);
  });

  it("returns nothing for a blank requested login", () => {
    expect(outcomesForLogin([outcome()], "   ")).toEqual([]);
  });
});

describe("amsRecordQualifiesAsTrusted", () => {
  it("qualifies a genuinely strong record (enough merges, high merge rate)", () => {
    const rows = [outcome(), outcome(), outcome(), outcome({ state: "closed" })]; // 3 merged / 4 terminal = 0.75
    expect(amsRecordQualifiesAsTrusted(rows)).toBe(true);
  });

  it("does not qualify a sparse record (below the merged floor) — sparse is no bonus, never a penalty", () => {
    const rows = Array.from({ length: AMS_BRIDGE_TRUSTED_MIN_MERGED - 1 }, () => outcome());
    expect(amsRecordQualifiesAsTrusted(rows)).toBe(false);
  });

  it("does not qualify a high-volume but low-merge-rate record", () => {
    // 3 merged / 10 terminal = 0.3, under the rate floor despite clearing the merged floor.
    const rows = [...Array.from({ length: 3 }, () => outcome()), ...Array.from({ length: 7 }, () => outcome({ state: "closed" }))];
    expect(amsRecordQualifiesAsTrusted(rows)).toBe(false);
  });

  it("ignores non-terminal (open) PRs in the denominator — an open PR is not yet evidence either way", () => {
    // 3 merged / 3 terminal = 1.0; the 5 open rows must not dilute the rate.
    const rows = [...Array.from({ length: 3 }, () => outcome()), ...Array.from({ length: 5 }, () => outcome({ state: "open" }))];
    expect(amsRecordQualifiesAsTrusted(rows)).toBe(true);
  });

  it("does not qualify an empty record", () => {
    expect(amsRecordQualifiesAsTrusted([])).toBe(false);
  });
});

describe("upgradeReputationSignal — upgrade-only (#6208)", () => {
  it("upgrades neutral and low toward trusted when AMS vouches", () => {
    expect(upgradeReputationSignal("neutral", true)).toBe("trusted");
    expect(upgradeReputationSignal("low", true)).toBe("trusted");
  });

  it("NEVER downgrades: a non-vouching AMS record leaves every local signal exactly as-is", () => {
    expect(upgradeReputationSignal("trusted", false)).toBe("trusted");
    expect(upgradeReputationSignal("neutral", false)).toBe("neutral");
    expect(upgradeReputationSignal("low", false)).toBe("low");
  });
});

describe("fetchAmsTrackRecord — fail-safe pull", () => {
  it("returns the login's outcomes from a bare-array payload", async () => {
    const rows = await fetchAmsTrackRecord("dev", { endpoint: ENDPOINT, fetchImpl: jsonFetch([outcome(), outcome({ authorLogin: "other" })]) });
    expect(rows).toHaveLength(1);
  });

  it("accepts the { pullRequests: [...] } envelope too", async () => {
    const rows = await fetchAmsTrackRecord("dev", { endpoint: ENDPOINT, fetchImpl: jsonFetch({ pullRequests: [outcome()] }) });
    expect(rows).toHaveLength(1);
  });

  it("builds the URL from the endpoint (trailing slashes trimmed) and encodes the login", async () => {
    let seen = "";
    const fetchImpl: AmsTrackRecordFetch = async (url) => {
      seen = url;
      return { ok: true, status: 200, json: async () => [] } as unknown as Response;
    };
    await fetchAmsTrackRecord("weird/login", { endpoint: `${ENDPOINT}///`, fetchImpl });
    expect(seen).toBe(`${ENDPOINT}/track-record/weird%2Flogin`);
  });

  it("returns null (no bonus) when no endpoint is configured or the login is blank", async () => {
    expect(await fetchAmsTrackRecord("dev", { endpoint: undefined, fetchImpl: jsonFetch([outcome()]) })).toBeNull();
    expect(await fetchAmsTrackRecord("dev", { endpoint: "   ", fetchImpl: jsonFetch([outcome()]) })).toBeNull();
    expect(await fetchAmsTrackRecord("   ", { endpoint: ENDPOINT, fetchImpl: jsonFetch([outcome()]) })).toBeNull();
  });

  it("returns null for a non-string login (defensive: a JS caller can pass anything)", async () => {
    expect(await fetchAmsTrackRecord(undefined as unknown as string, { endpoint: ENDPOINT, fetchImpl: jsonFetch([outcome()]) })).toBeNull();
    expect(await fetchAmsTrackRecord(42 as unknown as string, { endpoint: ENDPOINT, fetchImpl: jsonFetch([outcome()]) })).toBeNull();
  });

  it("falls back to the global fetch when no fetchImpl is injected", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => [outcome()] } as unknown as Response;
    });
    try {
      const rows = await fetchAmsTrackRecord("dev", { endpoint: ENDPOINT });
      expect(rows).toHaveLength(1);
      expect(calls).toEqual([`${ENDPOINT}/track-record/dev`]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns null on a non-OK status", async () => {
    expect(await fetchAmsTrackRecord("dev", { endpoint: ENDPOINT, fetchImpl: jsonFetch([outcome()], 503) })).toBeNull();
  });

  it("returns null on a malformed (non-array, non-envelope) body", async () => {
    expect(await fetchAmsTrackRecord("dev", { endpoint: ENDPOINT, fetchImpl: jsonFetch({ nope: true }) })).toBeNull();
    expect(await fetchAmsTrackRecord("dev", { endpoint: ENDPOINT, fetchImpl: jsonFetch(null) })).toBeNull();
  });

  it("returns null — never throws — when the endpoint is unreachable or times out", async () => {
    const boom: AmsTrackRecordFetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(fetchAmsTrackRecord("dev", { endpoint: ENDPOINT, fetchImpl: boom })).resolves.toBeNull();

    const timeout: AmsTrackRecordFetch = async () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    };
    await expect(fetchAmsTrackRecord("dev", { endpoint: ENDPOINT, fetchImpl: timeout, timeoutMs: 1 })).resolves.toBeNull();
  });

  it("returns null when the body itself fails to parse as JSON", async () => {
    const badJson: AmsTrackRecordFetch = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token");
        },
      }) as unknown as Response;
    await expect(fetchAmsTrackRecord("dev", { endpoint: ENDPOINT, fetchImpl: badJson })).resolves.toBeNull();
  });

  it("bounds the request with a short timeout signal so a slow AMS never stalls the gate", async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl: AmsTrackRecordFetch = async (_url, init) => {
      signal = init.signal as AbortSignal;
      return { ok: true, status: 200, json: async () => [] } as unknown as Response;
    };
    await fetchAmsTrackRecord("dev", { endpoint: ENDPOINT, fetchImpl });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(AMS_TRACK_RECORD_TIMEOUT_MS).toBeLessThanOrEqual(1000);
  });
});

describe("bridgeAmsReputation — the entry point", () => {
  const strong = [outcome(), outcome(), outcome()];

  it("upgrades a neutral submitter whose AMS record vouches for them", async () => {
    expect(await bridgeAmsReputation("neutral", "dev", { endpoint: ENDPOINT, fetchImpl: jsonFetch(strong) })).toBe("trusted");
  });

  it("upgrades a low submitter too — AMS evidence can only help", async () => {
    expect(await bridgeAmsReputation("low", "dev", { endpoint: ENDPOINT, fetchImpl: jsonFetch(strong) })).toBe("trusted");
  });

  it("leaves the signal unchanged when the submitter has no AMS data", async () => {
    expect(await bridgeAmsReputation("neutral", "dev", { endpoint: ENDPOINT, fetchImpl: jsonFetch([]) })).toBe("neutral");
    expect(await bridgeAmsReputation("low", "dev", { endpoint: ENDPOINT, fetchImpl: jsonFetch([]) })).toBe("low");
  });

  it("leaves the signal unchanged — and never throws — when AMS is unreachable", async () => {
    const boom: AmsTrackRecordFetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(bridgeAmsReputation("low", "dev", { endpoint: ENDPOINT, fetchImpl: boom })).resolves.toBe("low");
  });

  it("skips the network entirely for an already-trusted submitter (nothing to upgrade)", async () => {
    let called = false;
    const spy: AmsTrackRecordFetch = async () => {
      called = true;
      return { ok: true, status: 200, json: async () => [] } as unknown as Response;
    };
    expect(await bridgeAmsReputation("trusted", "dev", { endpoint: ENDPOINT, fetchImpl: spy })).toBe("trusted");
    expect(called).toBe(false);
  });

  it("leaves the signal unchanged when there is no submitter login", async () => {
    expect(await bridgeAmsReputation("neutral", undefined, { endpoint: ENDPOINT, fetchImpl: jsonFetch(strong) })).toBe("neutral");
  });

  it("never downgrades even when the AMS record looks bad — the upgrade-only guarantee", async () => {
    // A deliberately terrible AMS record (0 merged / 9 closed) must still leave the local signal untouched.
    const terrible = Array.from({ length: 9 }, () => outcome({ state: "closed" }));
    expect(await bridgeAmsReputation("neutral", "dev", { endpoint: ENDPOINT, fetchImpl: jsonFetch(terrible) })).toBe("neutral");
    expect(await bridgeAmsReputation("trusted", "dev", { endpoint: ENDPOINT, fetchImpl: jsonFetch(terrible) })).toBe("trusted");
  });

  it("carries no score/wallet/hotkey fields through the bridge (privacy-safe by construction)", async () => {
    // Even if an AMS instance sends extra keys, the bridge's output is a bare signal — nothing can cross.
    const withJunk = [outcome({ score: 99, wallet: "w", hotkey: "h" }), outcome(), outcome()];
    const result = await bridgeAmsReputation("neutral", "dev", { endpoint: ENDPOINT, fetchImpl: jsonFetch(withJunk) });
    expect(result).toBe("trusted");
    expect(JSON.stringify(result)).not.toMatch(/wallet|hotkey|score/i);
  });
});
