import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const contentScript = readFileSync("apps/gittensory-extension/content.js", "utf8");

describe("extension content script", () => {
  it("matches only GitHub pull request routes", () => {
    const internals = loadContentInternals();

    expect(internals.matchPullRequestTarget("/JSONbored/gittensory/pull/146")).toEqual({
      owner: "JSONbored",
      repo: "gittensory",
      pullNumber: 146,
    });
    expect(internals.matchPullRequestTarget("/JSONbored/gittensory/pull/146/files")).toEqual({
      owner: "JSONbored",
      repo: "gittensory",
      pullNumber: 146,
    });
    expect(internals.matchPullRequestTarget("/JSONbored/gittensory/issues/146")).toBeNull();
    expect(internals.matchPullRequestTarget("/JSONbored/gittensory")).toBeNull();
  });

  it("renders private pull-context sections and escapes API text", () => {
    const internals = loadContentInternals();

    const html = internals.renderPullContext({
      sections: [
        {
          label: "Miner <Context>",
          badge: "confirmed",
          tone: "good",
          rows: [{ label: "author", value: "alice<script>" }],
          items: ["Official miner context is available."],
          actions: ["Compare linked issues before review."],
        },
      ],
    });

    expect(html).toContain("Miner &lt;Context&gt;");
    expect(html).toContain("alice&lt;script&gt;");
    expect(html).toContain("Official miner context is available.");
    expect(html).toContain("Compare linked issues before review.");
    expect(html).not.toContain("alice<script>");
  });

  it("falls back to legacy panels when sections are absent", () => {
    const internals = loadContentInternals();

    const html = internals.renderPullContext({
      panels: [{ label: "Boundary", badge: "private", rows: [{ k: "public", v: "no" }] }],
    });

    expect(html).toContain("Boundary");
    expect(html).toContain("private");
    expect(html).toContain("public");
    expect(html).toContain("no");
  });
});

function loadContentInternals() {
  const context: Record<string, unknown> = {
    __GITTENSORY_EXTENSION_TEST__: true,
    location: { pathname: "/JSONbored/gittensory/issues/146" },
    document: {
      querySelector: vi.fn(() => null),
      createElement: vi.fn(() => {
        throw new Error("content script should not mount on non-PR routes in this test");
      }),
      body: { appendChild: vi.fn() },
    },
    chrome: { runtime: { sendMessage: vi.fn() } },
  };
  context.globalThis = context;
  const vmContext = createContext(context);
  new Script(contentScript).runInContext(vmContext);
  return vmContext.__gittensoryContentInternals as {
    matchPullRequestTarget: (pathname: string) => { owner: string; repo: string; pullNumber: number } | null;
    renderPullContext: (payload: unknown) => string;
  };
}
