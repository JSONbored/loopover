import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  computeToolbarBadge,
  TOOLBAR_BADGE_EMPTY_COLOR,
  TOOLBAR_BADGE_HAS_DATA_COLOR,
  TOOLBAR_BADGE_NO_DATA_TEXT,
} from "../../apps/gittensory-miner-extension/toolbar-badge.js";

// ─── The pure state map (the substance of #5193) ──────────────────────────────────────────────────────────

describe("computeToolbarBadge (miner extension toolbar badge, #5193)", () => {
  it("shows the count with the has-data color when candidates are populated", () => {
    expect(computeToolbarBadge([{}, {}, {}])).toEqual({
      text: "3",
      backgroundColor: TOOLBAR_BADGE_HAS_DATA_COLOR,
    });
    // a single opportunity still renders as a count, not a dash
    expect(computeToolbarBadge([{}])).toEqual({
      text: "1",
      backgroundColor: TOOLBAR_BADGE_HAS_DATA_COLOR,
    });
  });

  it("clears the text (populated-but-empty state) for an empty array", () => {
    expect(computeToolbarBadge([])).toEqual({
      text: "",
      backgroundColor: TOOLBAR_BADGE_EMPTY_COLOR,
    });
  });

  it("shows a dash for the never-populated cache (key never written ⇒ undefined)", () => {
    expect(computeToolbarBadge(undefined)).toEqual({
      text: TOOLBAR_BADGE_NO_DATA_TEXT,
      backgroundColor: TOOLBAR_BADGE_EMPTY_COLOR,
    });
  });

  it("treats any malformed non-array value as no-data (dash), never a numeric count", () => {
    for (const malformed of [null, "12", 7, { length: 5 }, true]) {
      expect(computeToolbarBadge(malformed)).toEqual({
        text: TOOLBAR_BADGE_NO_DATA_TEXT,
        backgroundColor: TOOLBAR_BADGE_EMPTY_COLOR,
      });
    }
  });

  it("INVARIANT: no-data (never-written or malformed) never renders a numeric count — never shown as zero", () => {
    for (const noData of [undefined, null, 0, "", { foo: "bar" }]) {
      const text = computeToolbarBadge(noData).text;
      expect(text).not.toMatch(/[0-9]/);
      expect(text).toBe(TOOLBAR_BADGE_NO_DATA_TEXT);
    }
  });
});

// ─── The background service-worker wiring (startup paint + live onChanged repaint) ────────────────────────
// Loaded exactly the way the extension's own VM harness loads it (readFileSync + node:vm), so no module loader
// and no engine import is needed — this keeps the wiring test runnable without native/optional deps.

const EXT_DIR = "apps/gittensory-miner-extension";
const opportunityBadgeScript = readFileSync(
  `${EXT_DIR}/opportunity-badge.js`,
  "utf8",
);
const toolbarBadgeScript = readFileSync(
  `${EXT_DIR}/toolbar-badge.js`,
  "utf8",
).replace(/^export\s+/gm, "");
const backgroundScript = readFileSync(
  `${EXT_DIR}/background.js`,
  "utf8",
).replace(/^import\s+["'][^"']+["'];\s*/gm, "");

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function loadBackground(
  rawRankedCandidates: unknown,
  { withAction = true, failAction = false } = {},
) {
  const setBadgeText = failAction
    ? vi.fn(async () => {
        throw new Error("chrome.action unavailable");
      })
    : vi.fn(async () => {});
  const setBadgeBackgroundColor = vi.fn(async () => {});
  let changeListener: ((changes: unknown, areaName: string) => void) | null =
    null;
  const chrome: Record<string, unknown> = {
    storage: {
      sync: { get: async () => ({ watchedRepos: [] }) },
      local: {
        // the toolbar badge reads WITHOUT a default (string arg) → `undefined` survives as never-populated;
        // the per-page path reads WITH a default object → always an array.
        get: async (arg: unknown) =>
          typeof arg === "string"
            ? { rankedCandidates: rawRankedCandidates }
            : {
                rankedCandidates: Array.isArray(rawRankedCandidates)
                  ? rawRankedCandidates
                  : [],
              },
      },
      onChanged: withAction
        ? { addListener: (fn: typeof changeListener) => (changeListener = fn) }
        : undefined,
    },
    runtime: { onMessage: { addListener: () => {} } },
  };
  if (withAction) chrome.action = { setBadgeText, setBadgeBackgroundColor };
  const warn = vi.fn();
  const context: Record<string, unknown> = {
    __GITTENSORY_MINER_EXTENSION_TEST__: true,
    chrome,
    console: { warn },
  };
  context.globalThis = context;
  const vmContext = createContext(context);
  new Script(opportunityBadgeScript).runInContext(vmContext);
  new Script(toolbarBadgeScript).runInContext(vmContext);
  new Script(backgroundScript).runInContext(vmContext);
  const internals = vmContext.__gittensoryMinerBackgroundInternals as {
    refreshToolbarBadge: () => Promise<void>;
  };
  return {
    setBadgeText,
    setBadgeBackgroundColor,
    warn,
    internals,
    fireChange: (changes: unknown, areaName: string) =>
      changeListener?.(changes, areaName),
  };
}

describe("background toolbar-badge wiring (#5193)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("paints the badge on service-worker startup from the current cache", async () => {
    const bg = loadBackground([1, 2]);
    await flush();
    expect(bg.setBadgeText).toHaveBeenCalledWith({ text: "2" });
    expect(bg.setBadgeBackgroundColor).toHaveBeenCalledWith({
      color: TOOLBAR_BADGE_HAS_DATA_COLOR,
    });
  });

  it("refreshToolbarBadge applies the never-populated / empty / populated states via chrome.action", async () => {
    const never = loadBackground(undefined);
    await flush();
    never.setBadgeText.mockClear();
    never.setBadgeBackgroundColor.mockClear();
    await never.internals.refreshToolbarBadge();
    expect(never.setBadgeText).toHaveBeenLastCalledWith({ text: "–" });
    expect(never.setBadgeBackgroundColor).toHaveBeenLastCalledWith({
      color: TOOLBAR_BADGE_EMPTY_COLOR,
    });

    const empty = loadBackground([]);
    await flush();
    empty.setBadgeText.mockClear();
    await empty.internals.refreshToolbarBadge();
    expect(empty.setBadgeText).toHaveBeenLastCalledWith({ text: "" });

    const populated = loadBackground([{}, {}, {}, {}]);
    await flush();
    populated.setBadgeText.mockClear();
    await populated.internals.refreshToolbarBadge();
    expect(populated.setBadgeText).toHaveBeenLastCalledWith({ text: "4" });
  });

  it("repaints on a local rankedCandidates change; ignores other keys and other storage areas", async () => {
    const bg = loadBackground([9]);
    await flush();
    bg.setBadgeText.mockClear();

    bg.fireChange({ rankedCandidates: { newValue: [9] } }, "local");
    await flush();
    expect(bg.setBadgeText).toHaveBeenCalledTimes(1);

    bg.setBadgeText.mockClear();
    bg.fireChange({ rankedCandidates: { newValue: [9] } }, "sync"); // right key, wrong area
    bg.fireChange({ watchedRepos: { newValue: [] } }, "local"); // right area, wrong key
    await flush();
    expect(bg.setBadgeText).not.toHaveBeenCalled();
  });

  it("swallows a rejected chrome.action call so the void-called refresh never leaks an unhandled rejection", async () => {
    const bg = loadBackground([1, 2], { failAction: true });
    await flush();
    // refreshToolbarBadge must resolve (not reject) even though setBadgeText throws
    await expect(bg.internals.refreshToolbarBadge()).resolves.toBeUndefined();
    expect(bg.warn).toHaveBeenCalled();
  });

  it("no-ops cleanly (no throw, no listener) when the chrome.action surface is unavailable", async () => {
    const bg = loadBackground([1, 2, 3], { withAction: false });
    await flush();
    // module still loads and exports internals; the guarded startup/onChanged wiring simply never ran
    expect(typeof bg.internals.refreshToolbarBadge).toBe("function");
    expect(bg.setBadgeText).not.toHaveBeenCalled();
  });
});
