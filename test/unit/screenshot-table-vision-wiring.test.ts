import { afterEach, describe, expect, it, vi } from "vitest";
import { runScreenshotTableVisionForAdvisory } from "../../src/queue/processors";
import * as repositories from "../../src/db/repositories";
import { upsertRepositoryAiKey } from "../../src/db/repositories";
import * as submitterReputation from "../../src/review/submitter-reputation";
import type { AdvisoryFinding, RepositorySettings } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const pr = { number: 3 };
const repoFullName = "acme/widgets";

function byokEnv() {
  return createTestEnv({ TOKEN_ENCRYPTION_SECRET: "screenshot-vision-test-fake-encryption-secret" });
}

function gateEnabledSettings(over: Partial<RepositorySettings> = {}): RepositorySettings {
  return {
    screenshotTableGate: { enabled: true, whenLabels: [], whenPaths: [], action: "close", requireViewports: [], requireThemes: [] },
    aiReviewByok: true,
    ...over,
  } as RepositorySettings;
}

function findingsHolder(): { findings: AdvisoryFinding[] } {
  return { findings: [] };
}

function tableBody(beforeUrl: string, afterUrl: string): string {
  return `## Screenshots\n\n| Before | After |\n| --- | --- |\n| ![before](${beforeUrl}) | ![after](${afterUrl}) |\n`;
}

const BEFORE_URL = "https://user-images.githubusercontent.com/before.png";
const AFTER_URL = "https://user-images.githubusercontent.com/after.png";

function findingsResponse(findings: Array<{ pairIndex: number; body: string }>) {
  return JSON.stringify({ findings });
}

function anthropicOk(text: string) {
  return new Response(JSON.stringify({ content: [{ type: "text", text }] }), { status: 200 });
}

function stubShotsAndProvider(providerResponseText: string | null, bytes: { before: number[]; after: number[] } = { before: [1, 2, 3], after: [4, 5, 6] }) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url === "https://api.anthropic.com/v1/messages") {
      return providerResponseText === null ? new Response("upstream error", { status: 500 }) : anthropicOk(providerResponseText);
    }
    if (url === BEFORE_URL) return new Response(new Uint8Array(bytes.before), { status: 200 });
    if (url === AFTER_URL) return new Response(new Uint8Array(bytes.after), { status: 200 });
    return new Response("not found", { status: 404 });
  }));
}

describe("runScreenshotTableVisionForAdvisory (#4366)", () => {
  it("no-ops when the deterministic screenshot-table gate is disabled -- never touches the network", async () => {
    const env = byokEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const adv = findingsHolder();
    await runScreenshotTableVisionForAdvisory(env, {
      mode: "live",
      repoFullName,
      pr,
      prBody: tableBody(BEFORE_URL, AFTER_URL),
      prTitle: "Redesign the nav bar",
      author: "alice",
      confirmedContributor: true,
      settings: gateEnabledSettings({ screenshotTableGate: { enabled: false, whenLabels: [], whenPaths: [], action: "close", requireViewports: [], requireThemes: [] } }),
      advisory: adv,
    });
    expect(adv.findings).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no-ops on a paused mode, even with a qualifying table and the gate enabled", async () => {
    const env = byokEnv();
    stubShotsAndProvider(findingsResponse([{ pairIndex: 1, body: "identical" }]));
    const adv = findingsHolder();
    await runScreenshotTableVisionForAdvisory(env, {
      mode: "paused",
      repoFullName,
      pr,
      prBody: tableBody(BEFORE_URL, AFTER_URL),
      prTitle: "Redesign the nav bar",
      author: "alice",
      confirmedContributor: true,
      settings: gateEnabledSettings(),
      advisory: adv,
    });
    expect(adv.findings).toEqual([]);
  });

  it("no-ops when the PR body has no image-bearing table row at all", async () => {
    const env = byokEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const adv = findingsHolder();
    await runScreenshotTableVisionForAdvisory(env, {
      mode: "live",
      repoFullName,
      pr,
      prBody: "Just a plain description, no table.",
      prTitle: "Fix a typo",
      author: "alice",
      confirmedContributor: true,
      settings: gateEnabledSettings(),
      advisory: adv,
    });
    expect(adv.findings).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops a pair with an unsafe (non-HTTPS) URL instead of fetching it (#SSRF)", async () => {
    const env = byokEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const adv = findingsHolder();
    await runScreenshotTableVisionForAdvisory(env, {
      mode: "live",
      repoFullName,
      pr,
      prBody: tableBody("http://user-images.githubusercontent.com/before.png", AFTER_URL),
      prTitle: "Redesign the nav bar",
      author: "alice",
      confirmedContributor: true,
      settings: gateEnabledSettings(),
      advisory: adv,
    });
    expect(adv.findings).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops a pair whose URL resolves to a private/local host instead of fetching it (#SSRF)", async () => {
    const env = byokEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const adv = findingsHolder();
    await runScreenshotTableVisionForAdvisory(env, {
      mode: "live",
      repoFullName,
      pr,
      prBody: tableBody("https://169.254.169.254/before.png", AFTER_URL),
      prTitle: "Redesign the nav bar",
      author: "alice",
      confirmedContributor: true,
      settings: gateEnabledSettings(),
      advisory: adv,
    });
    expect(adv.findings).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("flags byte-identical before/after images WITHOUT calling any AI provider (free deterministic check)", async () => {
    const env = byokEnv();
    await upsertRepositoryAiKey(env, { repoFullName, provider: "anthropic", key: "sk-ant-key", model: null });
    stubShotsAndProvider(null, { before: [9, 9, 9], after: [9, 9, 9] });
    const adv = findingsHolder();
    await runScreenshotTableVisionForAdvisory(env, {
      mode: "live",
      repoFullName,
      pr,
      prBody: tableBody(BEFORE_URL, AFTER_URL),
      prTitle: "Redesign the nav bar",
      author: "alice",
      confirmedContributor: true,
      settings: gateEnabledSettings(),
      advisory: adv,
    });
    expect(adv.findings).toEqual([
      {
        code: "screenshot_table_vision_finding",
        severity: "warning",
        title: "Possible screenshot-table issue: identical images (row 1)",
        detail: "The before and after images for this row are byte-identical — this doesn't look like real before/after evidence.",
        action: "Advisory only — verify the screenshot-table images against the stated change before deciding.",
      },
    ]);
    const fetchCalls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => String(c[0]));
    expect(fetchCalls).not.toContain("https://api.anthropic.com/v1/messages");
  });

  it("calls the BYOK provider for a genuinely different pair and adds its parsed finding", async () => {
    const env = byokEnv();
    await upsertRepositoryAiKey(env, { repoFullName, provider: "anthropic", key: "sk-ant-key", model: null });
    stubShotsAndProvider(findingsResponse([{ pairIndex: 1, body: "The after screenshot shows an unrelated login page." }]));
    const adv = findingsHolder();
    await runScreenshotTableVisionForAdvisory(env, {
      mode: "live",
      repoFullName,
      pr,
      prBody: tableBody(BEFORE_URL, AFTER_URL),
      prTitle: "Redesign the nav bar",
      author: "alice",
      confirmedContributor: true,
      settings: gateEnabledSettings(),
      advisory: adv,
    });
    expect(adv.findings).toEqual([
      {
        code: "screenshot_table_vision_finding",
        severity: "warning",
        title: "Possible screenshot-table issue: pair 1",
        detail: "The after screenshot shows an unrelated login page.",
        action: "Advisory only — verify the screenshot-table images against the stated change before deciding.",
      },
    ]);
  });

  it("adds no finding when the provider returns an empty findings array (genuine evidence)", async () => {
    const env = byokEnv();
    await upsertRepositoryAiKey(env, { repoFullName, provider: "anthropic", key: "sk-ant-key", model: null });
    stubShotsAndProvider(findingsResponse([]));
    const adv = findingsHolder();
    await runScreenshotTableVisionForAdvisory(env, {
      mode: "live",
      repoFullName,
      pr,
      prBody: tableBody(BEFORE_URL, AFTER_URL),
      prTitle: "Redesign the nav bar",
      author: "alice",
      confirmedContributor: true,
      settings: gateEnabledSettings(),
      advisory: adv,
    });
    expect(adv.findings).toEqual([]);
  });

  it("degrades to no finding (never throws) when the provider call itself fails", async () => {
    const env = byokEnv();
    await upsertRepositoryAiKey(env, { repoFullName, provider: "anthropic", key: "sk-ant-key", model: null });
    stubShotsAndProvider(null);
    const adv = findingsHolder();
    await expect(
      runScreenshotTableVisionForAdvisory(env, {
        mode: "live",
        repoFullName,
        pr,
        prBody: tableBody(BEFORE_URL, AFTER_URL),
        prTitle: "Redesign the nav bar",
        author: "alice",
        confirmedContributor: true,
        settings: gateEnabledSettings(),
        advisory: adv,
      }),
    ).resolves.toBeUndefined();
    expect(adv.findings).toEqual([]);
  });

  it("declines the AI call for a low-reputation submitter, but a byte-identical pair still gets flagged for free", async () => {
    const env = byokEnv();
    await upsertRepositoryAiKey(env, { repoFullName, provider: "anthropic", key: "sk-ant-key", model: null });
    vi.spyOn(submitterReputation, "getSubmitterReputation").mockResolvedValueOnce({
      submissions: 6,
      merged: 0,
      closed: 6,
      manual: 0,
      closeRate: 1,
      signal: "low",
    });
    stubShotsAndProvider(null, { before: [7, 7, 7], after: [7, 7, 7] });
    const adv = findingsHolder();
    await runScreenshotTableVisionForAdvisory(env, {
      mode: "live",
      repoFullName,
      pr,
      prBody: tableBody(BEFORE_URL, AFTER_URL),
      prTitle: "Redesign the nav bar",
      author: "bob",
      confirmedContributor: true,
      settings: gateEnabledSettings(),
      advisory: adv,
    });
    expect(adv.findings).toEqual([
      {
        code: "screenshot_table_vision_finding",
        severity: "warning",
        title: "Possible screenshot-table issue: identical images (row 1)",
        detail: "The before and after images for this row are byte-identical — this doesn't look like real before/after evidence.",
        action: "Advisory only — verify the screenshot-table images against the stated change before deciding.",
      },
    ]);
    const fetchCalls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => String(c[0]));
    expect(fetchCalls).not.toContain("https://api.anthropic.com/v1/messages");
  });

  it("runs via env.AI_VISION when no BYOK key is configured at all", async () => {
    const runMock = vi.fn(async () => ({ response: findingsResponse([{ pairIndex: 1, body: "Looks like a different app entirely." }]) }));
    const env = byokEnv();
    (env as unknown as { AI_VISION: unknown }).AI_VISION = { run: runMock };
    stubShotsAndProvider(null);
    const adv = findingsHolder();
    await runScreenshotTableVisionForAdvisory(env, {
      mode: "live",
      repoFullName,
      pr,
      prBody: tableBody(BEFORE_URL, AFTER_URL),
      prTitle: "Redesign the nav bar",
      author: "alice",
      confirmedContributor: true,
      settings: gateEnabledSettings({ aiReviewByok: false }),
      advisory: adv,
    });
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(adv.findings).toEqual([
      {
        code: "screenshot_table_vision_finding",
        severity: "warning",
        title: "Possible screenshot-table issue: pair 1",
        detail: "Looks like a different app entirely.",
        action: "Advisory only — verify the screenshot-table images against the stated change before deciding.",
      },
    ]);
  });

  it("does not let an unconfirmed contributor spend self-host vision resources unless all-authors is enabled", async () => {
    const runMock = vi.fn(async () => ({ response: findingsResponse([{ pairIndex: 1, body: "should not run" }]) }));
    const env = byokEnv();
    (env as unknown as { AI_VISION: unknown }).AI_VISION = { run: runMock };
    stubShotsAndProvider(null);
    const adv = findingsHolder();
    await runScreenshotTableVisionForAdvisory(env, {
      mode: "live",
      repoFullName,
      pr,
      prBody: tableBody(BEFORE_URL, AFTER_URL),
      prTitle: "Redesign the nav bar",
      author: "alice",
      confirmedContributor: false,
      settings: gateEnabledSettings({ aiReviewByok: false, aiReviewAllAuthors: false }),
      advisory: adv,
    });
    expect(runMock).not.toHaveBeenCalled();
    expect(adv.findings).toEqual([]);
  });

  it("still declines entirely when neither BYOK nor env.AI_VISION is configured, but byte-identical detection still works", async () => {
    const env = byokEnv();
    stubShotsAndProvider(null, { before: [5, 5, 5], after: [5, 5, 5] });
    const adv = findingsHolder();
    await runScreenshotTableVisionForAdvisory(env, {
      mode: "live",
      repoFullName,
      pr,
      prBody: tableBody(BEFORE_URL, AFTER_URL),
      prTitle: "Redesign the nav bar",
      author: "alice",
      confirmedContributor: true,
      settings: gateEnabledSettings({ aiReviewByok: false }),
      advisory: adv,
    });
    expect(adv.findings).toEqual([
      {
        code: "screenshot_table_vision_finding",
        severity: "warning",
        title: "Possible screenshot-table issue: identical images (row 1)",
        detail: "The before and after images for this row are byte-identical — this doesn't look like real before/after evidence.",
        action: "Advisory only — verify the screenshot-table images against the stated change before deciding.",
      },
    ]);
  });

  it("only sends the first two qualifying rows to fetch/vision, bounding cost on a long table", async () => {
    const env = byokEnv();
    await upsertRepositoryAiKey(env, { repoFullName, provider: "anthropic", key: "sk-ant-key", model: null });
    const thirdBefore = "https://user-images.githubusercontent.com/third-before.png";
    const thirdAfter = "https://user-images.githubusercontent.com/third-after.png";
    const body = [
      "| Before | After |",
      "| --- | --- |",
      `| ![before](${BEFORE_URL}) | ![after](${AFTER_URL}) |`,
      `| ![before](${BEFORE_URL}) | ![after](${AFTER_URL}) |`,
      `| ![before](${thirdBefore}) | ![after](${thirdAfter}) |`,
    ].join("\n");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.anthropic.com/v1/messages") return anthropicOk(findingsResponse([]));
      if (url === BEFORE_URL) return new Response(new Uint8Array([1]), { status: 200 });
      if (url === AFTER_URL) return new Response(new Uint8Array([2]), { status: 200 });
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const adv = findingsHolder();
    await runScreenshotTableVisionForAdvisory(env, {
      mode: "live",
      repoFullName,
      pr,
      prBody: body,
      prTitle: "Redesign the nav bar",
      author: "alice",
      confirmedContributor: true,
      settings: gateEnabledSettings(),
      advisory: adv,
    });
    const fetchedUrls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(fetchedUrls).not.toContain(thirdBefore);
    expect(fetchedUrls).not.toContain(thirdAfter);
  });

  it("silently skips a pair when only ONE of its two images fetches successfully", async () => {
    const env = byokEnv();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === BEFORE_URL) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const adv = findingsHolder();
    await runScreenshotTableVisionForAdvisory(env, {
      mode: "live",
      repoFullName,
      pr,
      prBody: tableBody(BEFORE_URL, AFTER_URL),
      prTitle: "Redesign the nav bar",
      author: "alice",
      confirmedContributor: true,
      settings: gateEnabledSettings(),
      advisory: adv,
    });
    expect(adv.findings).toEqual([]);
  });

  it("adds no finding when the BYOK provider returns 200 with no usable text (distinct from a failure) -- also exercises a null author", async () => {
    const env = byokEnv();
    await upsertRepositoryAiKey(env, { repoFullName, provider: "anthropic", key: "sk-ant-key", model: null });
    // An empty string is a genuine 2xx response, unlike stubShotsAndProvider(null)'s 500 -- callAiProvider
    // returns { text: "", failure: undefined } here (no "http_error"), exercising the "no usable output"
    // fallback in recordScreenshotTableVisionUsage's detail message rather than the provider-failure one.
    stubShotsAndProvider("");
    const adv = findingsHolder();
    await runScreenshotTableVisionForAdvisory(env, {
      mode: "live",
      repoFullName,
      pr,
      prBody: tableBody(BEFORE_URL, AFTER_URL),
      prTitle: "Redesign the nav bar",
      author: null,
      confirmedContributor: true,
      settings: gateEnabledSettings(),
      advisory: adv,
    });
    expect(adv.findings).toEqual([]);
  });

  it("still resolves BYOK when the declared provider explicitly matches the stored key's provider", async () => {
    const env = byokEnv();
    await upsertRepositoryAiKey(env, { repoFullName, provider: "anthropic", key: "sk-ant-key", model: null });
    stubShotsAndProvider(findingsResponse([]));
    const adv = findingsHolder();
    await runScreenshotTableVisionForAdvisory(env, {
      mode: "live",
      repoFullName,
      pr,
      prBody: tableBody(BEFORE_URL, AFTER_URL),
      prTitle: "Redesign the nav bar",
      author: "alice",
      confirmedContributor: true,
      settings: gateEnabledSettings({ aiReviewProvider: "anthropic" }),
      advisory: adv,
    });
    const fetchCalls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => String(c[0]));
    expect(fetchCalls).toContain("https://api.anthropic.com/v1/messages");
  });

  it("skips BYOK (falls back to nothing, since self-host vision isn't configured either) when the declared provider doesn't match the stored key", async () => {
    const env = byokEnv();
    await upsertRepositoryAiKey(env, { repoFullName, provider: "anthropic", key: "sk-ant-key", model: null });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === BEFORE_URL) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      if (url === AFTER_URL) return new Response(new Uint8Array([4, 5, 6]), { status: 200 });
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const adv = findingsHolder();
    await runScreenshotTableVisionForAdvisory(env, {
      mode: "live",
      repoFullName,
      pr,
      prBody: tableBody(BEFORE_URL, AFTER_URL),
      prTitle: "Redesign the nav bar",
      author: "alice",
      confirmedContributor: true,
      settings: gateEnabledSettings({ aiReviewProvider: "openai" }),
      advisory: adv,
    });
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).not.toContain("https://api.anthropic.com/v1/messages");
    expect(adv.findings).toEqual([]);
  });

  it("swallows a thrown error from the BYOK key lookup and never lets it escape (screenshot_table_vision_error)", async () => {
    const env = byokEnv();
    await upsertRepositoryAiKey(env, { repoFullName, provider: "anthropic", key: "sk-ant-key", model: null });
    vi.spyOn(repositories, "getDecryptedRepositoryAiKey").mockRejectedValueOnce(new Error("D1 unavailable"));
    stubShotsAndProvider(findingsResponse([]));
    const adv = findingsHolder();
    await expect(
      runScreenshotTableVisionForAdvisory(env, {
        mode: "live",
        repoFullName,
        pr,
        prBody: tableBody(BEFORE_URL, AFTER_URL),
        prTitle: "Redesign the nav bar",
        author: "alice",
        confirmedContributor: true,
        settings: gateEnabledSettings(),
        advisory: adv,
      }),
    ).resolves.toBeUndefined();
    expect(adv.findings).toEqual([]);
  });

  it("distinguishes two identical-image rows by row number instead of producing indistinguishable findings", async () => {
    const env = byokEnv();
    const secondBefore = "https://user-images.githubusercontent.com/second-before.png";
    const secondAfter = "https://user-images.githubusercontent.com/second-after.png";
    const body = [
      "| Before | After |",
      "| --- | --- |",
      `| ![before](${BEFORE_URL}) | ![after](${AFTER_URL}) |`,
      `| ![before](${secondBefore}) | ![after](${secondAfter}) |`,
    ].join("\n");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === BEFORE_URL || url === AFTER_URL) return new Response(new Uint8Array([1, 1, 1]), { status: 200 });
      if (url === secondBefore || url === secondAfter) return new Response(new Uint8Array([2, 2, 2]), { status: 200 });
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const adv = findingsHolder();
    await runScreenshotTableVisionForAdvisory(env, {
      mode: "live",
      repoFullName,
      pr,
      prBody: body,
      prTitle: "Redesign the nav bar",
      author: "alice",
      confirmedContributor: true,
      settings: gateEnabledSettings({ aiReviewByok: false }),
      advisory: adv,
    });
    expect(adv.findings).toEqual([
      expect.objectContaining({ title: "Possible screenshot-table issue: identical images (row 1)" }),
      expect.objectContaining({ title: "Possible screenshot-table issue: identical images (row 2)" }),
    ]);
  });
});
