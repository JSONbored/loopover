import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import { describe, expect, it } from "vitest";

// Live-fetch replacement for the manual copy/paste workflow (#4859): background.js pulls ranked candidates
// from the local miner-ui's /api/ranked-candidates (built by #5619) and writes them into the SAME
// chrome.storage.local keys the manual-paste flow (options.js) already writes, so content.js/opportunity-
// badge.js/toolbar-badge.js need zero changes. This file covers the NEW sync machinery specifically; the
// pre-existing badge/paste/purge behavior stays covered by miner-extension-content.test.ts.

const backgroundScript = readFileSync("apps/gittensory-miner-extension/background.js", "utf8");
const optionsScript = readFileSync("apps/gittensory-miner-extension/options.js", "utf8");
const manifest = JSON.parse(readFileSync("apps/gittensory-miner-extension/manifest.json", "utf8"));

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function backgroundScriptForVm() {
  // Strip the top-of-file `import "./x.js"` lines, same as miner-extension-content.test.ts's harness: the
  // node:vm sandbox has no module resolution, and this file only needs the raw statements that follow.
  return backgroundScript.replace(/^import\s+["'][^"']+["'];\s*/gm, "");
}

type FakeChromeOptions = {
  minerUiUrl?: string;
  fetchImpl?: typeof fetch;
  withAlarms?: boolean;
  withLifecycle?: boolean;
};

function loadBackgroundWithFakeChrome({
  minerUiUrl = "http://localhost:5174",
  fetchImpl,
  withAlarms = false,
  withLifecycle = false,
}: FakeChromeOptions = {}) {
  const localSetCalls: Array<Record<string, unknown>> = [];
  const alarmCreateCalls: Array<[string, unknown]> = [];
  let alarmListener: ((alarm: { name: string }) => void) | undefined;
  let startupListener: (() => void) | undefined;
  let installedListener: (() => void) | undefined;
  let messageListener:
    | ((message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean)
    | undefined;

  const chrome: Record<string, unknown> = {
    runtime: {
      onMessage: { addListener: (fn: typeof messageListener) => (messageListener = fn) },
      ...(withLifecycle
        ? {
            onStartup: { addListener: (fn: typeof startupListener) => (startupListener = fn) },
            onInstalled: { addListener: (fn: typeof installedListener) => (installedListener = fn) },
          }
        : {}),
    },
    storage: {
      sync: { get: async () => ({ minerUiUrl }) },
      local: {
        get: async () => ({ rankedCandidates: [] }),
        set: async (value: Record<string, unknown>) => {
          localSetCalls.push(value);
        },
      },
    },
  };
  if (withAlarms) {
    chrome.alarms = {
      create: (name: string, info: unknown) => alarmCreateCalls.push([name, info]),
      onAlarm: { addListener: (fn: typeof alarmListener) => (alarmListener = fn) },
    };
  }

  const context: Record<string, unknown> = {
    __GITTENSORY_MINER_EXTENSION_TEST__: true,
    chrome,
    fetch: fetchImpl,
  };
  context.globalThis = context;
  const vmContext = createContext(context);
  new Script(backgroundScriptForVm()).runInContext(vmContext);

  const internals = vmContext.__gittensoryMinerBackgroundInternals as {
    SYNC_RANKED_CANDIDATES_MESSAGE: string;
    DEFAULT_MINER_UI_URL: string;
    loadMinerUiUrl: () => Promise<string>;
    syncRankedCandidatesFromMinerUi: () => Promise<Record<string, unknown>>;
  };

  return {
    internals,
    localSetCalls,
    alarmCreateCalls,
    dispatchAlarm: (name: string) => alarmListener?.({ name }),
    dispatchStartup: () => startupListener?.(),
    dispatchInstalled: () => installedListener?.(),
    dispatchMessage: (message: unknown) =>
      new Promise((resolve) => {
        const keepChannelOpen = messageListener?.(message, {}, resolve);
        if (!keepChannelOpen) resolve(undefined);
      }),
  };
}

function jsonFetch(status: number, payload: unknown): typeof fetch {
  return (async () =>
    ({ ok: status >= 200 && status < 300, status, json: async () => payload }) as unknown as Response) as typeof fetch;
}

describe("manifest.json grants the alarms permission for ambient sync (#4859)", () => {
  it("includes alarms alongside the existing storage permission", () => {
    expect(manifest.permissions).toContain("alarms");
    expect(manifest.permissions).toContain("storage");
  });
});

describe("syncRankedCandidatesFromMinerUi (#4859)", () => {
  it("fetches from the configured miner UI URL and writes candidates + a savedAt timestamp into local storage", async () => {
    const candidates = [{ repoFullName: "acme/widgets", issueNumber: 1, rankScore: 0.8 }];
    const { internals, localSetCalls } = loadBackgroundWithFakeChrome({
      minerUiUrl: "http://localhost:5174",
      fetchImpl: jsonFetch(200, { candidates }),
    });

    const result = await internals.syncRankedCandidatesFromMinerUi();

    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(result.minerUiUrl).toBe("http://localhost:5174");
    expect(typeof result.savedAt).toBe("number");
    expect(localSetCalls).toHaveLength(1);
    expect(localSetCalls[0]).toEqual({ rankedCandidates: candidates, rankedCandidatesSavedAt: result.savedAt });
  });

  it("falls back to DEFAULT_MINER_UI_URL when no URL is stored", async () => {
    const { internals } = loadBackgroundWithFakeChrome({
      minerUiUrl: "",
      fetchImpl: jsonFetch(200, { candidates: [] }),
    });
    expect(await internals.loadMinerUiUrl()).toBe(internals.DEFAULT_MINER_UI_URL);
  });

  it("surfaces a non-2xx response as a typed failure without touching storage", async () => {
    const { internals, localSetCalls } = loadBackgroundWithFakeChrome({ fetchImpl: jsonFetch(401, {}) });
    const result = await internals.syncRankedCandidatesFromMinerUi();
    expect(result).toEqual({ ok: false, error: "miner UI responded 401", minerUiUrl: "http://localhost:5174" });
    expect(localSetCalls).toHaveLength(0);
  });

  it("surfaces a malformed payload (candidates not an array) as a typed failure without touching storage", async () => {
    const { internals, localSetCalls } = loadBackgroundWithFakeChrome({ fetchImpl: jsonFetch(200, { candidates: "nope" }) });
    const result = await internals.syncRankedCandidatesFromMinerUi();
    expect(result).toEqual({
      ok: false,
      error: "miner UI returned an unexpected payload shape",
      minerUiUrl: "http://localhost:5174",
    });
    expect(localSetCalls).toHaveLength(0);
  });

  it("surfaces a thrown fetch (miner UI not running) as a typed failure without touching storage, never throwing", async () => {
    // Throws a plain string, not `new Error(...)`: a node:vm sandbox has its own realm-local Error
    // constructor, so an Error built in THIS (outer) realm would fail the production code's own
    // `error instanceof Error` check once thrown inside the sandbox -- a test-harness artifact, not something
    // that can happen in the real single-realm extension runtime. A string throw sidesteps the cross-realm
    // instanceof gotcha while still exercising the "non-Error thrown value" fallback (`String(error)`).
    const { internals, localSetCalls } = loadBackgroundWithFakeChrome({
      fetchImpl: (async () => {
        throw "connect ECONNREFUSED";
      }) as unknown as typeof fetch,
    });
    const result = await internals.syncRankedCandidatesFromMinerUi();
    expect(result).toEqual({ ok: false, error: "connect ECONNREFUSED", minerUiUrl: "http://localhost:5174" });
    expect(localSetCalls).toHaveLength(0);
  });

  it("responds to the SYNC_RANKED_CANDIDATES_MESSAGE runtime message with the sync result", async () => {
    const candidates = [{ repoFullName: "acme/widgets", issueNumber: 1, rankScore: 0.8 }];
    const { internals, dispatchMessage } = loadBackgroundWithFakeChrome({ fetchImpl: jsonFetch(200, { candidates }) });

    const response = (await dispatchMessage({ type: internals.SYNC_RANKED_CANDIDATES_MESSAGE })) as {
      ok: boolean;
      payload: { ok: boolean; count: number };
    };
    expect(response.ok).toBe(true);
    expect(response.payload.ok).toBe(true);
    expect(response.payload.count).toBe(1);
  });

  it("wires an alarms-based ambient refresh when chrome.alarms is present, and only syncs for its own alarm name", async () => {
    const { alarmCreateCalls, dispatchAlarm, localSetCalls } = loadBackgroundWithFakeChrome({
      withAlarms: true,
      fetchImpl: jsonFetch(200, { candidates: [] }),
    });
    expect(alarmCreateCalls).toHaveLength(1);
    const [name, info] = alarmCreateCalls[0]!;
    expect(name).toBe("gittensory-miner:sync-ranked-candidates");
    expect(info).toEqual({ periodInMinutes: 10 });

    dispatchAlarm("some-other-extensions-alarm");
    await flushPromises();
    expect(localSetCalls).toHaveLength(0);

    dispatchAlarm(name);
    await flushPromises();
    expect(localSetCalls).toHaveLength(1);
  });

  it("is a clean no-op to load (no throw) when chrome.alarms is absent, matching the toolbar-badge guard's discipline", () => {
    expect(() => loadBackgroundWithFakeChrome({ withAlarms: false })).not.toThrow();
  });

  it("syncs once on startup and once on install when those lifecycle events are available", async () => {
    const { dispatchStartup, dispatchInstalled, localSetCalls } = loadBackgroundWithFakeChrome({
      withLifecycle: true,
      fetchImpl: jsonFetch(200, { candidates: [] }),
    });
    dispatchStartup();
    await flushPromises();
    expect(localSetCalls).toHaveLength(1);

    dispatchInstalled();
    await flushPromises();
    expect(localSetCalls).toHaveLength(2);
  });
});

describe("options.js miner-UI URL field + Sync now button (#4859)", () => {
  function loadOptionsWithFakeChrome({
    minerUiUrl = "",
    syncResponse = { ok: true, payload: { ok: true, count: 2, minerUiUrl: "http://localhost:5174" } } as unknown,
  } = {}) {
    const syncSetCalls: Array<Record<string, unknown>> = [];
    const sentMessages: unknown[] = [];
    const elements = {
      "#settings": createFormMock(),
      "#status": { textContent: "" },
      "#watchedRepos": { value: "" },
      "#rankedCandidatesJson": { value: "" },
      "#minerUiUrl": { value: minerUiUrl },
      "#syncNow": createClickMock(),
    };
    const context: Record<string, unknown> = {
      __GITTENSORY_MINER_EXTENSION_TEST__: true,
      TextEncoder,
      document: { querySelector: (selector: string) => elements[selector as keyof typeof elements] ?? null },
      chrome: {
        storage: {
          sync: {
            get: async () => ({ watchedRepos: [], minerUiUrl }),
            set: async (value: Record<string, unknown>) => {
              syncSetCalls.push(value);
            },
            remove: async () => {},
          },
          local: { get: async () => ({ rankedCandidates: [] }), set: async () => {} },
        },
        runtime: {
          sendMessage: async (message: unknown) => {
            sentMessages.push(message);
            return syncResponse;
          },
        },
      },
      window: { setTimeout: () => 0 },
    };
    context.globalThis = context;
    const vmContext = createContext(context);
    new Script(optionsScript).runInContext(vmContext);
    return { elements, syncSetCalls, sentMessages, vmContext };
  }

  it("saves the URL alongside watchedRepos on form submit", async () => {
    const { elements, syncSetCalls } = loadOptionsWithFakeChrome();
    (elements["#minerUiUrl"] as { value: string }).value = "http://localhost:9999";
    await elements["#settings"].dispatchSubmit();
    expect(syncSetCalls).toHaveLength(1);
    expect(syncSetCalls[0]).toMatchObject({ minerUiUrl: "http://localhost:9999" });
  });

  it("normalizes an empty/whitespace URL to the default on save", async () => {
    const { elements, syncSetCalls } = loadOptionsWithFakeChrome();
    (elements["#minerUiUrl"] as { value: string }).value = "   ";
    await elements["#settings"].dispatchSubmit();
    expect(syncSetCalls[0]).toMatchObject({ minerUiUrl: "http://localhost:5174" });
  });

  it("populates the URL field from storage on load, falling back to the default when unset", async () => {
    const { vmContext } = loadOptionsWithFakeChrome({ minerUiUrl: "http://localhost:7777" });
    await flushPromises();
    expect((vmContext.document as { querySelector: (s: string) => { value: string } }).querySelector("#minerUiUrl").value).toBe(
      "http://localhost:7777",
    );
  });

  it("Sync now sends the sync message and shows a success status with the candidate count", async () => {
    const { elements, sentMessages } = loadOptionsWithFakeChrome({
      syncResponse: { ok: true, payload: { ok: true, count: 3, minerUiUrl: "http://localhost:5174" } },
    });
    await (elements["#syncNow"] as ReturnType<typeof createClickMock>).dispatchClick();
    expect(sentMessages).toEqual([{ type: "gittensory-miner:sync-ranked-candidates" }]);
    expect((elements["#status"] as { textContent: string }).textContent).toMatch(/Synced 3 ranked candidate/);
  });

  it("Sync now shows a fallback-to-paste message when the miner UI can't be reached", async () => {
    const { elements } = loadOptionsWithFakeChrome({
      syncResponse: {
        ok: true,
        payload: { ok: false, error: "failed to reach the local miner UI", minerUiUrl: "http://localhost:5174" },
      },
    });
    await (elements["#syncNow"] as ReturnType<typeof createClickMock>).dispatchClick();
    expect((elements["#status"] as { textContent: string }).textContent).toMatch(/Falling back to the pasted JSON/);
  });
});

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

function createClickMock() {
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
