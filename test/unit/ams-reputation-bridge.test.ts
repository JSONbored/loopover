import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AMS_BRIDGE_TIMEOUT_MS,
  DEFAULT_AMS_BRIDGE_CONFIG,
  amsEndpointUrl,
  amsSignalFromSummary,
  applyAmsUpgrade,
  bridgeAmsReputation,
  fetchAmsTrackRecord,
  isAmsBridgeEnabled,
  parseTrackRecordReadResult,
} from "../../src/review/ams-reputation-bridge";
import { TRACK_RECORD_SUMMARY_READ_VERSION, type TrackRecordSummary } from "../../packages/loopover-engine/src/track-record-summary";
import type { ReputationSignal } from "../../src/review/submitter-reputation";

// A minimal, valid TrackRecordSummary with just the fields the bridge reads (mergeRate + incidents) tunable.
function summary(over: { hasPublicIncident?: boolean; ratio?: number | null; denominator?: number } = {}): TrackRecordSummary {
  const denominator = over.denominator ?? 0;
  const ratio = over.ratio ?? null;
  return {
    enabled: true,
    login: "octocat",
    mergeRate: { numerator: 0, denominator, ratio, percent: null, label: "" },
    tenure: { firstObservedAt: null, days: null, label: "" },
    incidents: { hasPublicIncident: over.hasPublicIncident ?? false, checkedPublicRecords: 0, activePublicRecords: 0, label: "", evidenceUrls: [] },
    outcomes: { merged: 0, closedWithoutMerge: 0, resolved: 0, openIgnored: 0, ignored: 0 },
    audit: { normalizedLogin: "octocat", consideredOutcomeIds: [], ignoredOutcomeIds: [], firstObservedCandidates: [] },
  };
}

function envelope(over?: Parameters<typeof summary>[0]) {
  return { version: TRACK_RECORD_SUMMARY_READ_VERSION, summary: summary(over) };
}

function amsEnv(over: { LOOPOVER_REVIEW_AMS_BRIDGE?: string; LOOPOVER_AMS_ENDPOINT?: string } = {}): Env {
  return { LOOPOVER_REVIEW_AMS_BRIDGE: "true", LOOPOVER_AMS_ENDPOINT: "https://ams.local/track-record", ...over } as unknown as Env;
}

describe("ams-reputation-bridge", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("isAmsBridgeEnabled", () => {
    it("is true only for the truthy on-tokens", () => {
      for (const value of ["1", "true", "TRUE", "yes", "on", " on "]) {
        expect(isAmsBridgeEnabled({ LOOPOVER_REVIEW_AMS_BRIDGE: value })).toBe(true);
      }
    });

    it("is false when off or unset", () => {
      expect(isAmsBridgeEnabled({ LOOPOVER_REVIEW_AMS_BRIDGE: "false" })).toBe(false);
      expect(isAmsBridgeEnabled({ LOOPOVER_REVIEW_AMS_BRIDGE: "" })).toBe(false);
      expect(isAmsBridgeEnabled({})).toBe(false);
    });
  });

  describe("amsEndpointUrl", () => {
    it("returns the trimmed endpoint when set", () => {
      expect(amsEndpointUrl({ LOOPOVER_AMS_ENDPOINT: "  https://ams.local/x  " })).toBe("https://ams.local/x");
    });

    it("returns undefined when blank or unset", () => {
      expect(amsEndpointUrl({ LOOPOVER_AMS_ENDPOINT: "   " })).toBeUndefined();
      expect(amsEndpointUrl({})).toBeUndefined();
    });
  });

  describe("applyAmsUpgrade", () => {
    it("lifts a lower signal toward trusted", () => {
      expect(applyAmsUpgrade("low", "trusted")).toBe("trusted");
      expect(applyAmsUpgrade("neutral", "trusted")).toBe("trusted");
      expect(applyAmsUpgrade("low", "neutral")).toBe("neutral");
    });

    it("never downgrades — an equal or lower ams signal is a no-op", () => {
      expect(applyAmsUpgrade("neutral", "low")).toBe("neutral");
      expect(applyAmsUpgrade("trusted", "neutral")).toBe("trusted");
      expect(applyAmsUpgrade("trusted", "low")).toBe("trusted");
      expect(applyAmsUpgrade("neutral", "neutral")).toBe("neutral");
    });
  });

  describe("amsSignalFromSummary", () => {
    it("returns trusted for a strong, incident-free record", () => {
      expect(amsSignalFromSummary(summary({ ratio: 0.8, denominator: 10 }))).toBe("trusted");
    });

    it("returns neutral when a public conduct incident is present, even with a strong ratio", () => {
      expect(amsSignalFromSummary(summary({ hasPublicIncident: true, ratio: 0.9, denominator: 20 }))).toBe("neutral");
    });

    it("returns neutral when there is not enough resolved history", () => {
      expect(amsSignalFromSummary(summary({ ratio: 1, denominator: 2 }))).toBe("neutral");
    });

    it("returns neutral when the merge ratio is weak", () => {
      expect(amsSignalFromSummary(summary({ ratio: 0.4, denominator: 10 }))).toBe("neutral");
    });

    it("returns neutral when there is no resolved history at all (null ratio)", () => {
      expect(amsSignalFromSummary(summary({ ratio: null, denominator: 0 }))).toBe("neutral");
    });

    it("honors a custom config", () => {
      expect(amsSignalFromSummary(summary({ ratio: 0.5, denominator: 3 }), { minResolved: 3, trustedMergeRatio: 0.5 })).toBe("trusted");
    });

    it("exposes conservative committed defaults", () => {
      expect(DEFAULT_AMS_BRIDGE_CONFIG).toEqual({ minResolved: 5, trustedMergeRatio: 0.6 });
    });
  });

  describe("parseTrackRecordReadResult", () => {
    it("returns the envelope for a well-formed response", () => {
      const value = envelope({ ratio: 0.7, denominator: 8 });
      expect(parseTrackRecordReadResult(value)).toBe(value);
    });

    it("returns null for a non-object", () => {
      expect(parseTrackRecordReadResult("nope")).toBeNull();
      expect(parseTrackRecordReadResult(null)).toBeNull();
      expect(parseTrackRecordReadResult([envelope()])).toBeNull();
    });

    it("returns null for a wrong/absent envelope version", () => {
      expect(parseTrackRecordReadResult({ version: 999, summary: summary() })).toBeNull();
      expect(parseTrackRecordReadResult({ summary: summary() })).toBeNull();
    });

    it("returns null when the summary block is missing or malformed", () => {
      expect(parseTrackRecordReadResult({ version: TRACK_RECORD_SUMMARY_READ_VERSION, summary: "x" })).toBeNull();
    });

    it("returns null when mergeRate is not an object", () => {
      const bad = { version: TRACK_RECORD_SUMMARY_READ_VERSION, summary: { ...summary(), mergeRate: null } };
      expect(parseTrackRecordReadResult(bad)).toBeNull();
    });

    it("returns null when incidents is not an object", () => {
      const bad = { version: TRACK_RECORD_SUMMARY_READ_VERSION, summary: { ...summary(), incidents: 5 } };
      expect(parseTrackRecordReadResult(bad)).toBeNull();
    });
  });

  describe("fetchAmsTrackRecord", () => {
    it("returns the parsed envelope on a 200 with a valid body", async () => {
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        expect(String(input)).toContain("login=octocat");
        return Response.json(envelope({ ratio: 0.8, denominator: 10 }));
      });
      const read = await fetchAmsTrackRecord("octocat", "https://ams.local/track-record");
      expect(read?.summary.mergeRate.ratio).toBe(0.8);
    });

    it("returns null on a non-OK status", async () => {
      vi.stubGlobal("fetch", async () => new Response("nope", { status: 503 }));
      expect(await fetchAmsTrackRecord("octocat", "https://ams.local/track-record")).toBeNull();
    });

    it("returns null on a malformed (non-JSON) body — no throw", async () => {
      vi.stubGlobal("fetch", async () => new Response("<html>not json</html>", { status: 200 }));
      expect(await fetchAmsTrackRecord("octocat", "https://ams.local/track-record")).toBeNull();
    });

    it("returns null when the fetch rejects (unreachable/timeout) — no throw", async () => {
      vi.stubGlobal("fetch", async () => {
        throw new Error("network down");
      });
      expect(await fetchAmsTrackRecord("octocat", "https://ams.local/track-record")).toBeNull();
    });

    it("returns null for a malformed endpoint URL — no throw", async () => {
      expect(await fetchAmsTrackRecord("octocat", "not-a-valid-url")).toBeNull();
    });
  });

  describe("bridgeAmsReputation", () => {
    const noFetch = () => vi.stubGlobal("fetch", async () => { throw new Error("must not be called"); });

    it("is a no-op when the bridge is disabled (no external read)", async () => {
      noFetch();
      const out = await bridgeAmsReputation(amsEnv({ LOOPOVER_REVIEW_AMS_BRIDGE: "false" }), { submitter: "octocat", current: "low" });
      expect(out).toBe("low");
    });

    it("skips the read when the signal is already trusted", async () => {
      noFetch();
      expect(await bridgeAmsReputation(amsEnv(), { submitter: "octocat", current: "trusted" })).toBe("trusted");
    });

    it("is a no-op when no endpoint is configured", async () => {
      noFetch();
      const env = { LOOPOVER_REVIEW_AMS_BRIDGE: "true" } as unknown as Env;
      expect(await bridgeAmsReputation(env, { submitter: "octocat", current: "low" })).toBe("low");
    });

    it("is a no-op when the submitter is absent", async () => {
      noFetch();
      expect(await bridgeAmsReputation(amsEnv(), { submitter: "   ", current: "low" })).toBe("low");
      expect(await bridgeAmsReputation(amsEnv(), { submitter: null, current: "low" })).toBe("low");
    });

    it("leaves the signal unchanged when the AMS read yields nothing", async () => {
      vi.stubGlobal("fetch", async () => new Response("", { status: 500 }));
      expect(await bridgeAmsReputation(amsEnv(), { submitter: "octocat", current: "low" })).toBe("low");
    });

    it("upgrades a low signal to trusted on a strong AMS record", async () => {
      vi.stubGlobal("fetch", async () => Response.json(envelope({ ratio: 0.9, denominator: 12 })));
      expect(await bridgeAmsReputation(amsEnv(), { submitter: "octocat", current: "low" })).toBe("trusted");
    });

    it("never downgrades — a weak AMS record leaves a neutral signal neutral", async () => {
      vi.stubGlobal("fetch", async () => Response.json(envelope({ ratio: 0.1, denominator: 12 })));
      expect(await bridgeAmsReputation(amsEnv(), { submitter: "octocat", current: "neutral" })).toBe("neutral");
    });
  });

  it("bounds the AMS read with a short timeout", () => {
    expect(AMS_BRIDGE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(AMS_BRIDGE_TIMEOUT_MS).toBeLessThanOrEqual(1000);
  });
});

// Type-only guard: the exported signal type stays a superset of what the bridge can emit.
const _signals: ReputationSignal[] = ["low", "neutral", "trusted"];
void _signals;
