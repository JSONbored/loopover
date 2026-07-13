import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rankCandidateIssues } from "../../packages/gittensory-miner/lib/opportunity-ranker.js";

const contentScript = readFileSync("apps/gittensory-miner-extension/content.js", "utf8");
const backgroundScript = readFileSync("apps/gittensory-miner-extension/background.js", "utf8");
const badgeScript = readFileSync("apps/gittensory-miner-extension/opportunity-badge.js", "utf8");
const optionsScript = readFileSync("apps/gittensory-miner-extension/options.js", "utf8");
const optionsHtml = readFileSync("apps/gittensory-miner-extension/options.html", "utf8");
const manifest = JSON.parse(readFileSync("apps/gittensory-miner-extension/manifest.json", "utf8"));

const NOW = Date.parse("2026-07-03T12:00:00.000Z");

function rawIssue(overrides: Record<string, unknown> = {}) {
  return {
    owner: "JSONbored",
    repo: "gittensory",
    repoFullName: "JSONbored/gittensory",
    issueNumber: 145,
    title: "Add miner extension badge",
    labels: ["help wanted", "gittensor:feature"],
    commentsCount: 1,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
    htmlUrl: "https://github.com/JSONbored/gittensory/issues/145",
    aiPolicyAllowed: true as const,
    aiPolicySource: "CONTRIBUTING.md" as const,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("miner extension opportunity badge", () => {
  it("ships browser-loadable content scripts without ESM export syntax", () => {
    expect(badgeScript).not.toMatch(/\bexport\s+/);
  });

  it("ships a Manifest V3 issue-page content script with badge assets", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.content_scripts[0].matches).toEqual(["https://github.com/*/*/issues/*"]);
    expect(manifest.content_scripts[0].js).toEqual(["opportunity-badge.js", "content.js"]);
    expect(manifest.content_scripts[0].css).toEqual(["styles.css"]);
  });

  it("grants loopback host permissions so the options page can live-fetch the local miner-ui (#4859)", () => {
    expect(manifest.host_permissions).toContain("https://github.com/*");
    expect(manifest.host_permissions).toContain("http://localhost/*");
    expect(manifest.host_permissions).toContain("http://127.0.0.1/*");
  });

  it("exposes a miner-ui base URL field and a live-fetch button, keeping the paste box as a fallback (#4859)", () => {
    expect(optionsHtml).toMatch(/id="minerUiBaseUrl"/);
    expect(optionsHtml).toMatch(/id="fetchLive"/);
    expect(optionsHtml).toMatch(/paste fallback/i);
  });

  it("detects GitHub issue routes without matching pull requests", () => {
    const internals = loadContentInternals();
    expect(internals.matchGitHubIssueTarget("/JSONbored/gittensory/issues/145")).toEqual({
      kind: "issue",
      owner: "JSONbored",
      repo: "gittensory",
      issueNumber: 145,
    });
    expect(internals.matchGitHubIssueTarget("/JSONbored/gittensory/pull/146")).toBeNull();
  });

  it("looks up ranked opportunities using the same repo#issue key as the miner ranker", () => {
    const ranked = rankCandidateIssues([rawIssue(), rawIssue({ issueNumber: 99, labels: ["question"] })], {
      nowMs: NOW,
    });
    const badge = loadBadgeInternals();

    const match = badge.lookupRankedOpportunity(ranked, "JSONbored/gittensory", 145);
    expect(match?.issueNumber).toBe(145);
    expect(match?.rankScore).toBeGreaterThan(0);
    expect(badge.lookupRankedOpportunity(ranked, "JSONbored/gittensory", 404)).toBeNull();
  });

  it("formats tier, score, and a short why without duplicating ranking math", () => {
    const ranked = rankCandidateIssues([rawIssue()], { nowMs: NOW })[0]!;
    const badge = loadBadgeInternals();
    const formatted = badge.formatOpportunityBadge(ranked);

    expect(formatted.tier).toMatch(/High|Medium|Low/);
    expect(formatted.score).toMatch(/^\d+\.\d{2}$/);
    expect(formatted.why.length).toBeGreaterThan(0);
    expect(badge.renderOpportunityBadgeMarkup(formatted)).toContain("Read-only");
    expect(badge.renderOpportunityBadgeMarkup(formatted)).not.toContain("<script>");
  });

  it("renders the badge when a ranked signal is available and removes it otherwise", () => {
    const internals = loadContentInternals();
    const container = createMockContainer();
    const ranked = rankCandidateIssues([rawIssue()], { nowMs: NOW })[0]!;
    const badge = loadBadgeInternals();
    const formatted = badge.formatOpportunityBadge(ranked);

    internals.renderOpportunityBadge(container, {
      watched: true,
      badge: formatted,
      status: "ready",
    });
    expect(container.hidden).toBe(false);
    expect(container.innerHTML).toContain("LoopOver opportunity");
    expect(container.innerHTML).toContain(formatted.tier);

    const missing = createMockContainer();
    internals.renderOpportunityBadge(missing, { watched: true, badge: null, status: "no-signal" });
    expect(missing.removed).toBe(true);
  });

  it("returns ready context when watched repo has a cached ranked candidate", async () => {
    const ranked = rankCandidateIssues([rawIssue()], { nowMs: NOW });
    const internals = loadBackgroundInternals({
      watchedRepos: ["JSONbored/gittensory"],
      rankedCandidates: ranked,
    });

    const payload = await internals.loadIssueOpportunityContext({
      owner: "JSONbored",
      repo: "gittensory",
      issueNumber: 145,
    });

    expect(payload.status).toBe("ready");
    expect(payload.badge?.tier).toMatch(/High|Medium|Low/);
    expect(payload.badge?.why).toBeTruthy();
  });

  it("omits badge context when repo is watched but no ranked signal exists", async () => {
    const internals = loadBackgroundInternals({
      watchedRepos: ["JSONbored/gittensory"],
      rankedCandidates: [],
    });

    const payload = await internals.loadIssueOpportunityContext({
      owner: "JSONbored",
      repo: "gittensory",
      issueNumber: 145,
    });

    expect(payload.status).toBe("no-signal");
    expect(payload.badge).toBeNull();
  });

  it("parses watched repos and ranked candidate JSON for options storage", () => {
    const internals = loadOptionsInternals();
    expect(internals.parseWatchedRepos("JSONbored/gittensory\nowner/repo")).toEqual([
      "JSONbored/gittensory",
      "owner/repo",
    ]);
    expect(internals.parseRankedCandidatesJson("[]")).toEqual([]);
    expect(internals.parseRankedCandidatesJson('[{"repoFullName":"a/b","issueNumber":1}]')).toHaveLength(1);
    expect(() => internals.parseRankedCandidatesJson("{")).toThrow();
    expect(() => internals.parseRankedCandidatesJson('{"not":"array"}')).toThrow();
  });

  it("normalizes the miner-ui base URL: empty -> default, loopback origins accepted, others rejected (#4859)", () => {
    const internals = loadOptionsInternals();
    expect(internals.DEFAULT_MINER_UI_BASE_URL).toBe("http://localhost:5174");
    expect(internals.normalizeMinerUiBaseUrl("")).toBe("http://localhost:5174");
    expect(internals.normalizeMinerUiBaseUrl("   ")).toBe("http://localhost:5174");
    expect(internals.normalizeMinerUiBaseUrl(null)).toBe("http://localhost:5174");
    expect(internals.normalizeMinerUiBaseUrl("http://localhost:5174")).toBe("http://localhost:5174");
    expect(internals.normalizeMinerUiBaseUrl("http://localhost:5174/")).toBe("http://localhost:5174");
    expect(internals.normalizeMinerUiBaseUrl("http://127.0.0.1:4174")).toBe("http://127.0.0.1:4174");
    expect(internals.normalizeMinerUiBaseUrl("https://localhost")).toBe("https://localhost");
    expect(() => internals.normalizeMinerUiBaseUrl("http://evil.example.com")).toThrow(/localhost/);
    expect(() => internals.normalizeMinerUiBaseUrl("ftp://localhost:5174")).toThrow(/localhost/);
    expect(() => internals.normalizeMinerUiBaseUrl("not a url")).toThrow(/localhost/);
  });

  it("live-fetches ranked candidates from the miner-ui discovery endpoint (#4859)", async () => {
    const internals = loadOptionsInternals();
    const requested: string[] = [];
    const candidates = [{ repoFullName: "acme/widgets", issueNumber: 1, rankScore: 0.7 }];
    const fetchImpl = (async (url: string) => {
      requested.push(url);
      return { ok: true, json: async () => ({ rankedCandidates: candidates }) };
    }) as unknown as typeof fetch;

    const result = await internals.fetchLiveRankedCandidates("http://localhost:5174/", fetchImpl);
    expect(result).toEqual(candidates);
    expect(requested).toEqual(["http://localhost:5174/api/discovery"]);
  });

  it("surfaces a friendly error for a non-OK discovery response (#4859)", async () => {
    const internals = loadOptionsInternals();
    const fetchImpl = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    await expect(internals.fetchLiveRankedCandidates("http://localhost:5174", fetchImpl)).rejects.toThrow(
      /responded 503/,
    );
  });

  it("rejects a discovery response that is not a ranked-candidates list (#4859)", async () => {
    const internals = loadOptionsInternals();
    const missing = (async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;
    await expect(internals.fetchLiveRankedCandidates("http://localhost:5174", missing)).rejects.toThrow(
      /ranked-candidates list/,
    );
    const nullBody = (async () => ({ ok: true, json: async () => null })) as unknown as typeof fetch;
    await expect(internals.fetchLiveRankedCandidates("http://localhost:5174", nullBody)).rejects.toThrow(
      /ranked-candidates list/,
    );
  });

  it("reports an unreachable miner-ui instead of leaking the raw network error (#4859)", async () => {
    const internals = loadOptionsInternals();
    const fetchImpl = (async () => {
      throw new Error("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(internals.fetchLiveRankedCandidates("http://localhost:5174", fetchImpl)).rejects.toThrow(
      /Could not reach the miner UI/,
    );
  });

  it("the live-fetch button caches candidates + savedAt and persists the base URL (#4859)", async () => {
    const localSetCalls: Array<Record<string, unknown>> = [];
    const syncSetCalls: Array<Record<string, unknown>> = [];
    const candidates = [{ repoFullName: "acme/widgets", issueNumber: 3, rankScore: 0.66 }];
    const fakeNowMs = Date.parse("2026-07-11T09:00:00.000Z");
    const elements = {
      "#settings": createFormMock(),
      "#status": { textContent: "" },
      "#watchedRepos": { value: "acme/widgets" },
      "#rankedCandidatesJson": { value: "" },
      "#minerUiBaseUrl": { value: "http://127.0.0.1:5174" },
      "#fetchLive": createButtonMock(),
    };
    const context: Record<string, unknown> = {
      __GITTENSORY_MINER_EXTENSION_TEST__: true,
      Date: { now: () => fakeNowMs },
      document: { querySelector: (selector: string) => elements[selector as keyof typeof elements] ?? null },
      fetch: async (url: string) => {
        expect(url).toBe("http://127.0.0.1:5174/api/discovery");
        return { ok: true, json: async () => ({ rankedCandidates: candidates }) };
      },
      chrome: {
        storage: {
          sync: {
            get: async () => ({ watchedRepos: [], minerUiBaseUrl: "http://127.0.0.1:5174" }),
            set: async (value: Record<string, unknown>) => {
              syncSetCalls.push(value);
            },
            remove: async () => {},
          },
          local: {
            get: async () => ({ rankedCandidates: [] }),
            set: async (value: Record<string, unknown>) => {
              localSetCalls.push(value);
            },
          },
        },
      },
      window: { setTimeout: () => 0 },
    };
    context.globalThis = context;
    const vmContext = createContext(context);
    new Script(optionsScript).runInContext(vmContext);
    await flushPromises();

    await elements["#fetchLive"].dispatchClick();
    await flushPromises();

    expect(localSetCalls).toEqual([
      { rankedCandidates: candidates, rankedCandidatesSavedAt: fakeNowMs },
    ]);
    expect(syncSetCalls).toContainEqual({ minerUiBaseUrl: "http://127.0.0.1:5174" });
    expect(elements["#status"].textContent).toMatch(/Fetched 1 ranked candidate/);
  });

  it("the live-fetch button shows the error and writes nothing when the miner-ui is unreachable (#4859)", async () => {
    const localSetCalls: Array<Record<string, unknown>> = [];
    const elements = {
      "#settings": createFormMock(),
      "#status": { textContent: "" },
      "#watchedRepos": { value: "" },
      "#rankedCandidatesJson": { value: "" },
      "#minerUiBaseUrl": { value: "" },
      "#fetchLive": createButtonMock(),
    };
    const context: Record<string, unknown> = {
      __GITTENSORY_MINER_EXTENSION_TEST__: true,
      Date: { now: () => 0 },
      document: { querySelector: (selector: string) => elements[selector as keyof typeof elements] ?? null },
      fetch: async () => {
        throw new Error("Failed to fetch");
      },
      chrome: {
        storage: {
          sync: { get: async () => ({ watchedRepos: [], minerUiBaseUrl: "" }), set: async () => {}, remove: async () => {} },
          local: {
            get: async () => ({ rankedCandidates: [] }),
            set: async (value: Record<string, unknown>) => {
              localSetCalls.push(value);
            },
          },
        },
      },
      window: { setTimeout: () => 0 },
    };
    context.globalThis = context;
    const vmContext = createContext(context);
    new Script(optionsScript).runInContext(vmContext);
    await flushPromises();

    await elements["#fetchLive"].dispatchClick();
    await flushPromises();

    expect(localSetCalls).toEqual([]);
    expect(elements["#status"].textContent).toMatch(/Could not reach the miner UI/);
  });

  it("rejects a pasted ranked-candidates JSON payload over the storage-size bound with a clear error, before ever attempting to parse it (#4863)", () => {
    const internals = loadOptionsInternals();
    const oversized = "not valid json but that must not matter".padEnd(
      internals.MAX_RANKED_CANDIDATES_JSON_BYTES + 1,
      "x",
    );

    expect(() => internals.parseRankedCandidatesJson(oversized)).toThrow(/too large/i);
    // Invariant: the size check runs before JSON.parse, so an oversized-but-invalid payload fails on size,
    // not on a JSON syntax error -- proven by using text that isn't valid JSON at all.
    try {
      internals.parseRankedCandidatesJson(oversized);
    } catch (error) {
      expect(String(error)).not.toMatch(/Unexpected token/i);
    }
  });

  it("accepts a pasted ranked-candidates JSON payload exactly at the storage-size bound (#4863)", () => {
    const internals = loadOptionsInternals();
    const padding = "x".repeat(internals.MAX_RANKED_CANDIDATES_JSON_BYTES - 4);
    const atLimit = `["${padding}"]`;
    expect(atLimit).toHaveLength(internals.MAX_RANKED_CANDIDATES_JSON_BYTES);

    expect(internals.parseRankedCandidatesJson(atLimit)).toEqual([padding]);
  });

  it("REGRESSION (gate-caught): measures real UTF-8 byte size, not UTF-16 character count, so multibyte content can't sneak past the bound (#4863)", () => {
    const internals = loadOptionsInternals();
    // "é" is 1 UTF-16 code unit but 2 UTF-8 bytes -- a char-length check would see roughly half the real byte
    // size and wrongly accept a payload that actually exceeds the quota once chrome.storage.local serializes it.
    const halfLimitCharCount = Math.floor(internals.MAX_RANKED_CANDIDATES_JSON_BYTES / 2) + 10;
    const padding = "é".repeat(halfLimitCharCount);
    const payload = `["${padding}"]`;

    expect(payload.length).toBeLessThan(internals.MAX_RANKED_CANDIDATES_JSON_BYTES);
    expect(() => internals.parseRankedCandidatesJson(payload)).toThrow(/too large/i);
  });

  it("regression: an oversized paste surfaces its error through the save flow and never reaches chrome.storage.local.set (#4863)", async () => {
    const localSetCalls: Array<Record<string, unknown>> = [];
    const elements = {
      "#settings": createFormMock(),
      "#status": { textContent: "" },
      "#watchedRepos": { value: "JSONbored/gittensory" },
      "#rankedCandidatesJson": { value: "" },
    };
    const context: Record<string, unknown> = {
      __GITTENSORY_MINER_EXTENSION_TEST__: true,
      TextEncoder,
      document: { querySelector: (selector: string) => elements[selector as keyof typeof elements] ?? null },
      chrome: {
        storage: {
          sync: { get: async () => ({ watchedRepos: [] }), set: async () => {}, remove: async () => {} },
          local: {
            get: async () => ({ rankedCandidates: [] }),
            set: async (value: Record<string, unknown>) => {
              localSetCalls.push(value);
            },
          },
        },
      },
      window: { setTimeout: () => 0 },
    };
    context.globalThis = context;
    const vmContext = createContext(context);
    new Script(optionsScript).runInContext(vmContext);
    await flushPromises();

    const internals = vmContext.__gittensoryMinerOptionsInternals as { MAX_RANKED_CANDIDATES_JSON_BYTES: number };
    elements["#rankedCandidatesJson"].value = "x".repeat(internals.MAX_RANKED_CANDIDATES_JSON_BYTES + 1);
    await elements["#settings"].dispatchSubmit();

    expect(elements["#status"].textContent).toMatch(/too large/i);
    expect(localSetCalls).toHaveLength(0);
  });

  it("REGRESSION (dead-field removal): no discoveryIndexUrl config field remains in the UI or background reads", () => {
    expect(optionsHtml).not.toMatch(/discoveryIndexUrl/);
    expect(backgroundScript).not.toMatch(/discoveryIndexUrl/);
  });

  it("formats a relative 'last synced' label across the same buckets as ORB's RefreshMeta, clamping missing/invalid input to null (#5192)", () => {
    const badge = loadBadgeInternals();
    const NOW_MS = Date.parse("2026-07-10T12:00:00.000Z");

    expect(badge.formatLastSyncedLabel(NOW_MS, NOW_MS)).toBe("last synced just now");
    expect(badge.formatLastSyncedLabel(NOW_MS - 59_000, NOW_MS)).toBe("last synced just now");
    expect(badge.formatLastSyncedLabel(NOW_MS - 60_000, NOW_MS)).toBe("last synced 1m ago");
    expect(badge.formatLastSyncedLabel(NOW_MS - 59 * 60_000, NOW_MS)).toBe("last synced 59m ago");
    expect(badge.formatLastSyncedLabel(NOW_MS - 60 * 60_000, NOW_MS)).toBe("last synced 1h ago");
    expect(badge.formatLastSyncedLabel(NOW_MS - 23 * 60 * 60_000, NOW_MS)).toBe("last synced 23h ago");
    expect(badge.formatLastSyncedLabel(NOW_MS - 24 * 60 * 60_000, NOW_MS)).toBe("last synced 1d ago");
    expect(badge.formatLastSyncedLabel(NOW_MS + 5_000, NOW_MS)).toBe("last synced just now");

    expect(badge.formatLastSyncedLabel(null, NOW_MS)).toBeNull();
    expect(badge.formatLastSyncedLabel(undefined, NOW_MS)).toBeNull();
    expect(badge.formatLastSyncedLabel(Number.NaN, NOW_MS)).toBeNull();
    expect(badge.formatLastSyncedLabel("not-a-timestamp", NOW_MS)).toBeNull();
    // Invariant: a falsy-but-coercible-to-0 value must never be read as "the epoch", i.e. a real timestamp.
    expect(badge.formatLastSyncedLabel("", NOW_MS)).toBeNull();
  });

  it("renders the last-synced label inside the badge markup when present, and omits it (no NaN, no crash) when absent (#5192)", () => {
    const ranked = rankCandidateIssues([rawIssue()], { nowMs: NOW })[0]!;
    const badge = loadBadgeInternals();
    const formatted = badge.formatOpportunityBadge(ranked);

    const withLabel = badge.renderOpportunityBadgeMarkup(formatted, "last synced 3m ago");
    expect(withLabel).toContain("last synced 3m ago");
    expect(withLabel).toContain(formatted.tier);

    const withoutLabel = badge.renderOpportunityBadgeMarkup(formatted, null);
    expect(withoutLabel).not.toContain("last synced");
    expect(withoutLabel).not.toContain("NaN");
    // Invariant: adding/omitting the sync label never touches the ranking-derived fields.
    expect(withoutLabel).toContain(formatted.tier);
    expect(withoutLabel).toContain(formatted.score);
  });

  it("plumbs savedAt from background context through content.js into a rendered 'last synced' label (#5192)", () => {
    const internals = loadContentInternals();
    const container = createMockContainer();
    const ranked = rankCandidateIssues([rawIssue()], { nowMs: NOW })[0]!;
    const badge = loadBadgeInternals();
    const formatted = badge.formatOpportunityBadge(ranked);
    const savedAt = NOW - 5 * 60_000;

    internals.renderOpportunityBadge(container, { watched: true, badge: formatted, savedAt, status: "ready" }, NOW);
    expect(container.innerHTML).toContain("last synced 5m ago");
  });

  it("regression: a cache saved before savedAt existed renders the badge without a sync label instead of crashing or showing NaN (#5192)", () => {
    const internals = loadContentInternals();
    const container = createMockContainer();
    const ranked = rankCandidateIssues([rawIssue()], { nowMs: NOW })[0]!;
    const badge = loadBadgeInternals();
    const formatted = badge.formatOpportunityBadge(ranked);

    internals.renderOpportunityBadge(container, { watched: true, badge: formatted, status: "ready" }, NOW);
    expect(container.hidden).toBe(false);
    expect(container.innerHTML).not.toContain("last synced");
    expect(container.innerHTML).not.toContain("NaN");
  });

  it("includes savedAt in the ready background payload and omits it when there's no ranked signal (#5192)", async () => {
    const ranked = rankCandidateIssues([rawIssue()], { nowMs: NOW });
    const savedAt = NOW - 60_000;
    const ready = loadBackgroundInternals({
      watchedRepos: ["JSONbored/gittensory"],
      rankedCandidates: ranked,
      rankedCandidatesSavedAt: savedAt,
    });
    const readyPayload = await ready.loadIssueOpportunityContext({
      owner: "JSONbored",
      repo: "gittensory",
      issueNumber: 145,
    });
    expect(readyPayload.status).toBe("ready");
    expect(readyPayload.savedAt).toBe(savedAt);

    const noSignal = loadBackgroundInternals({
      watchedRepos: ["JSONbored/gittensory"],
      rankedCandidates: [],
      rankedCandidatesSavedAt: savedAt,
    });
    const noSignalPayload = await noSignal.loadIssueOpportunityContext({
      owner: "JSONbored",
      repo: "gittensory",
      issueNumber: 145,
    });
    expect(noSignalPayload.status).toBe("no-signal");
    expect(noSignalPayload.badge).toBeNull();
  });

  it("writes a rankedCandidatesSavedAt timestamp alongside rankedCandidates on every save, including re-paste/overwrite (#5192)", async () => {
    const localSetCalls: Array<Record<string, unknown>> = [];
    let fakeNowMs = Date.parse("2026-07-10T12:00:00.000Z");
    const elements = {
      "#settings": createFormMock(),
      "#status": { textContent: "" },
      "#watchedRepos": { value: "JSONbored/gittensory" },
      "#rankedCandidatesJson": { value: "[]" },
    };
    const context: Record<string, unknown> = {
      __GITTENSORY_MINER_EXTENSION_TEST__: true,
      Date: { now: () => fakeNowMs },
      TextEncoder,
      document: { querySelector: (selector: string) => elements[selector as keyof typeof elements] ?? null },
      chrome: {
        storage: {
          sync: { get: async () => ({ watchedRepos: [] }), set: async () => {}, remove: async () => {} },
          local: {
            get: async () => ({ rankedCandidates: [] }),
            set: async (value: Record<string, unknown>) => {
              localSetCalls.push(value);
            },
          },
        },
      },
      window: { setTimeout: () => 0 },
    };
    context.globalThis = context;
    const vmContext = createContext(context);
    new Script(optionsScript).runInContext(vmContext);
    await flushPromises();

    await elements["#settings"].dispatchSubmit();
    fakeNowMs = Date.parse("2026-07-10T12:05:00.000Z");
    await elements["#settings"].dispatchSubmit();

    expect(localSetCalls).toHaveLength(2);
    expect(localSetCalls[0]).toEqual({
      rankedCandidates: [],
      rankedCandidatesSavedAt: Date.parse("2026-07-10T12:00:00.000Z"),
    });
    expect(localSetCalls[1]).toEqual({
      rankedCandidates: [],
      rankedCandidatesSavedAt: Date.parse("2026-07-10T12:05:00.000Z"),
    });
  });

  it("purges a discoveryIndexUrl value already synced by an older extension version, on load and on save", async () => {
    const synced: Record<string, unknown> = {
      watchedRepos: [],
      discoveryIndexUrl: "https://legacy.example.test/index.json",
    };
    const setCalls: Array<Record<string, unknown>> = [];
    const removeCalls: string[] = [];
    const elements = {
      "#settings": createFormMock(),
      "#status": { textContent: "" },
      "#watchedRepos": { value: "" },
      "#rankedCandidatesJson": { value: "" },
    };
    const context: Record<string, unknown> = {
      __GITTENSORY_MINER_EXTENSION_TEST__: true,
      TextEncoder,
      document: { querySelector: (selector: string) => elements[selector as keyof typeof elements] ?? null },
      chrome: {
        storage: {
          sync: {
            get: async (defaults: Record<string, unknown>) => ({ ...defaults, ...synced }),
            set: async (value: Record<string, unknown>) => {
              setCalls.push(value);
              Object.assign(synced, value);
            },
            remove: async (key: string) => {
              removeCalls.push(key);
              delete synced[key];
            },
          },
          local: { get: async () => ({ rankedCandidates: [] }), set: async () => {} },
        },
      },
      window: { setTimeout: () => 0 },
    };
    context.globalThis = context;
    const vmContext = createContext(context);
    new Script(optionsScript).runInContext(vmContext);

    // The load-time refreshSettings() the script triggers on evaluation already removed it.
    await flushPromises();
    expect(removeCalls).toEqual(["discoveryIndexUrl"]);
    expect("discoveryIndexUrl" in synced).toBe(false);

    // Re-seed as if another synced device still has the legacy key, then confirm save also purges it.
    synced.discoveryIndexUrl = "https://legacy.example.test/index.json";
    elements["#watchedRepos"].value = "JSONbored/gittensory";
    await elements["#settings"].dispatchSubmit();

    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]).toEqual({ watchedRepos: ["JSONbored/gittensory"] });
    expect(removeCalls).toEqual(["discoveryIndexUrl", "discoveryIndexUrl"]);
    expect("discoveryIndexUrl" in synced).toBe(false);
  });

  it("directly exposes removeLegacyDiscoveryIndexUrl for the internal purge, not a UI-facing setting", () => {
    const internals = loadOptionsInternals();
    expect(typeof internals.removeLegacyDiscoveryIndexUrl).toBe("function");
  });
});

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createFormMock() {
  let submitHandler: ((event: { preventDefault: () => void }) => unknown) | null = null;
  return {
    addEventListener: (type: string, handler: typeof submitHandler) => {
      if (type === "submit") submitHandler = handler;
    },
    dispatchSubmit: async () => {
      await submitHandler?.({ preventDefault: () => {} });
    },
  };
}

function createButtonMock() {
  let clickHandler: (() => unknown) | null = null;
  return {
    addEventListener: (type: string, handler: typeof clickHandler) => {
      if (type === "click") clickHandler = handler;
    },
    dispatchClick: async () => {
      await clickHandler?.();
    },
  };
}

function createMockContainer() {
  const container = {
    hidden: false,
    innerHTML: "",
    removed: false,
    remove() {
      container.removed = true;
    },
  };
  return container;
}

function loadBadgeInternals() {
  const context: Record<string, unknown> = {
    __GITTENSORY_MINER_EXTENSION_TEST__: true,
  };
  context.globalThis = context;
  const vmContext = createContext(context);
  new Script(badgeScript).runInContext(vmContext);
  return vmContext.__gittensoryMinerOpportunityBadgeTestExports as {
    lookupRankedOpportunity: (ranked: unknown[], repoFullName: string, issueNumber: number) => Record<string, unknown> | null;
    formatOpportunityBadge: (entry: Record<string, unknown>) => { tier: string; score: string; why: string };
    formatLastSyncedLabel: (savedAt: unknown, nowMs: number) => string | null;
    renderOpportunityBadgeMarkup: (
      badge: { tier: string; score: string; why: string },
      lastSyncedLabel?: string | null,
    ) => string;
  };
}

function loadContentInternals() {
  const badge = loadBadgeInternals();
  const context: Record<string, unknown> = {
    __GITTENSORY_MINER_EXTENSION_TEST__: true,
    __gittensoryMinerOpportunityBadge: badge,
    location: { pathname: "/JSONbored/gittensory/pull/146" },
    document: {
      querySelector: () => null,
      createElement: () => createMockContainer(),
      body: { appendChild: () => {} },
    },
    chrome: { runtime: { sendMessage: async () => ({ ok: true, payload: { watched: true } }) } },
  };
  context.globalThis = context;
  const vmContext = createContext(context);
  new Script(contentScript).runInContext(vmContext);
  return vmContext.__gittensoryMinerContentInternals as {
    matchGitHubIssueTarget: (
      pathname: string,
    ) => { kind: "issue"; owner: string; repo: string; issueNumber: number } | null;
    renderOpportunityBadge: (
      container: ReturnType<typeof createMockContainer>,
      payload: unknown,
      nowMs?: number,
    ) => void;
  };
}

function loadBackgroundInternals({
  watchedRepos = [] as string[],
  rankedCandidates = [] as unknown[],
  rankedCandidatesSavedAt = null as number | null,
} = {}) {
  const context: Record<string, unknown> = {
    __GITTENSORY_MINER_EXTENSION_TEST__: true,
    chrome: {
      storage: {
        sync: {
          get: async () => ({ watchedRepos }),
        },
        local: {
          get: async () => ({ rankedCandidates, rankedCandidatesSavedAt }),
        },
      },
      runtime: { onMessage: { addListener: () => {} } },
    },
  };
  context.globalThis = context;
  const vmContext = createContext(context);
  new Script(badgeScript).runInContext(vmContext);
  const backgroundForTest = backgroundScript.replace(/^import\s+["'][^"']+["'];\s*/gm, "");
  new Script(backgroundForTest).runInContext(vmContext);
  return vmContext.__gittensoryMinerBackgroundInternals as {
    loadIssueOpportunityContext: (message: {
      owner: string;
      repo: string;
      issueNumber: number;
    }) => Promise<{
      status: string;
      badge: { tier: string; why: string } | null;
      savedAt?: number | null;
    }>;
  };
}

function loadOptionsInternals() {
  const context: Record<string, unknown> = {
    __GITTENSORY_MINER_EXTENSION_TEST__: true,
    TextEncoder,
    document: { querySelector: () => null },
    chrome: {
      storage: {
        sync: { get: async () => ({ watchedRepos: [] }), set: async () => {} },
        local: { get: async () => ({ rankedCandidates: [] }), set: async () => {} },
      },
    },
    setTimeout: () => 0,
  };
  context.globalThis = context;
  const vmContext = createContext(context);
  new Script(optionsScript).runInContext(vmContext);
  return vmContext.__gittensoryMinerOptionsInternals as {
    parseWatchedRepos: (text: string) => string[];
    parseRankedCandidatesJson: (text: string) => unknown[];
    removeLegacyDiscoveryIndexUrl: () => Promise<void>;
    normalizeMinerUiBaseUrl: (value: unknown) => string;
    fetchLiveRankedCandidates: (baseUrl: string, fetchImpl: typeof fetch) => Promise<unknown[]>;
    DEFAULT_MINER_UI_BASE_URL: string;
    DISCOVERY_API_PATH: string;
    MAX_RANKED_CANDIDATES_JSON_BYTES: number;
  };
}
