import { afterEach, describe, expect, it, vi } from "vitest";

type OptionsInternals = {
  parseWatchedRepos: (text: unknown) => string[];
  parseRankedCandidatesJson: (text: unknown) => unknown[];
  removeLegacyDiscoveryIndexUrl: () => Promise<void>;
  normalizeMinerUiUrl: (text: unknown) => string;
  MAX_RANKED_CANDIDATES_JSON_BYTES: number;
  SYNC_RANKED_CANDIDATES_MESSAGE: string;
  DEFAULT_MINER_UI_URL: string;
};

// options.js reads `document.querySelector` for its form fields at import time; stubbing it to return null makes
// the module take its "options.html is not mounted" branch, so it never attaches an event listener or touches
// chrome. Importing it that way exposes the pure helpers through the __LOOPOVER_MINER_EXTENSION_TEST__ hook with
// no DOM side effects -- the same no-jsdom-harness technique content.test.ts (#6189) already established.
async function loadOptionsInternals(chromeStub: unknown = {}): Promise<OptionsInternals> {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.stubGlobal("document", { querySelector: () => null });
  vi.stubGlobal("chrome", chromeStub);
  vi.stubGlobal("__LOOPOVER_MINER_EXTENSION_TEST__", true);
  await import("../options.js");
  return globalThis.__loopoverMinerOptionsInternals as OptionsInternals;
}

describe("options.js pure helpers (#7008)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("parseWatchedRepos splits on newlines and commas, trims, and drops blanks", async () => {
    const { parseWatchedRepos } = await loadOptionsInternals();
    expect(parseWatchedRepos("JSONbored/loopover,  owner/repo \n\n  other/repo ")).toEqual([
      "JSONbored/loopover",
      "owner/repo",
      "other/repo",
    ]);
    // Nullish/empty input degrades to an empty list rather than [""] -- exercises both sides of the `?? ""`.
    expect(parseWatchedRepos("")).toEqual([]);
    expect(parseWatchedRepos(undefined)).toEqual([]);
    expect(parseWatchedRepos(null)).toEqual([]);
  });

  it("parseRankedCandidatesJson returns [] for empty/whitespace input without parsing", async () => {
    const { parseRankedCandidatesJson } = await loadOptionsInternals();
    expect(parseRankedCandidatesJson("")).toEqual([]);
    expect(parseRankedCandidatesJson("   \n  ")).toEqual([]);
    expect(parseRankedCandidatesJson(undefined)).toEqual([]);
  });

  it("parseRankedCandidatesJson parses a JSON array of candidates", async () => {
    const { parseRankedCandidatesJson } = await loadOptionsInternals();
    expect(parseRankedCandidatesJson('[{"repo":"a/b"},{"repo":"c/d"}]')).toEqual([{ repo: "a/b" }, { repo: "c/d" }]);
  });

  it("parseRankedCandidatesJson rejects JSON that isn't an array", async () => {
    const { parseRankedCandidatesJson } = await loadOptionsInternals();
    expect(() => parseRankedCandidatesJson('{"repo":"a/b"}')).toThrow(/must be an array/);
  });

  it("parseRankedCandidatesJson rejects a payload past the quota, measured as UTF-8 bytes not char length", async () => {
    const { parseRankedCandidatesJson, MAX_RANKED_CANDIDATES_JSON_BYTES } = await loadOptionsInternals();
    // One byte over the limit -- the guard throws on TextEncoder byte length before it ever reaches JSON.parse,
    // so the payload doesn't need to be valid JSON to trip it.
    const oversized = "a".repeat(MAX_RANKED_CANDIDATES_JSON_BYTES + 1);
    expect(() => parseRankedCandidatesJson(oversized)).toThrow(/too large/);
  });

  it("normalizeMinerUiUrl trims a real URL and falls back to the default when blank/nullish", async () => {
    const { normalizeMinerUiUrl, DEFAULT_MINER_UI_URL } = await loadOptionsInternals();
    expect(normalizeMinerUiUrl("  http://localhost:9999  ")).toBe("http://localhost:9999");
    expect(normalizeMinerUiUrl("")).toBe(DEFAULT_MINER_UI_URL);
    expect(normalizeMinerUiUrl("   ")).toBe(DEFAULT_MINER_UI_URL);
    expect(normalizeMinerUiUrl(undefined)).toBe(DEFAULT_MINER_UI_URL);
  });

  it("removeLegacyDiscoveryIndexUrl purges the pre-#5343 discoveryIndexUrl key from chrome.storage.sync", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const { removeLegacyDiscoveryIndexUrl } = await loadOptionsInternals({ storage: { sync: { remove } } });
    await removeLegacyDiscoveryIndexUrl();
    expect(remove).toHaveBeenCalledWith("discoveryIndexUrl");
  });
});
