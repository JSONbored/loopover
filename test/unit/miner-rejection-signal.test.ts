import { describe, expect, it, vi } from "vitest";

vi.mock("@jsonbored/gittensory-engine", async () => {
  return import("../../packages/gittensory-engine/src/index");
});

import { resolveRejectionSignaled } from "../../packages/gittensory-miner/lib/rejection-signal.js";

function textResponse(text: string | null, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  };
}

/** Routes by URL substring; a null respond() throws to simulate a network failure. */
function routedFetch(routes: Record<string, () => unknown>) {
  return async (url: string) => {
    for (const [substring, respond] of Object.entries(routes)) {
      if (url.includes(substring)) return respond();
    }
    return textResponse(null, 404);
  };
}

describe("resolveRejectionSignaled (#5132)", () => {
  it("returns true when AI-USAGE.md contains an explicit ban phrase", async () => {
    const fetchImpl = routedFetch({
      "AI-USAGE.md": () => textResponse("No AI-generated pull requests, please."),
      "CONTRIBUTING.md": () => textResponse("Welcome, contributors!"),
    });
    const result = await resolveRejectionSignaled("acme/widgets", { fetchImpl });
    expect(result).toBe(true);
  });

  it("returns false when neither policy doc bans AI contributions", async () => {
    const fetchImpl = routedFetch({
      "AI-USAGE.md": () => textResponse("AI contributions are welcome here."),
      "CONTRIBUTING.md": () => textResponse("Welcome, contributors!"),
    });
    const result = await resolveRejectionSignaled("acme/widgets", { fetchImpl });
    expect(result).toBe(false);
  });

  it("falls through to CONTRIBUTING.md's ban when AI-USAGE.md is empty", async () => {
    const fetchImpl = routedFetch({
      "AI-USAGE.md": () => textResponse(""),
      "CONTRIBUTING.md": () => textResponse("Do not submit AI-generated code."),
    });
    const result = await resolveRejectionSignaled("acme/widgets", { fetchImpl });
    expect(result).toBe(true);
  });

  it("fails open to false when both docs 404", async () => {
    const fetchImpl = routedFetch({});
    const result = await resolveRejectionSignaled("acme/widgets", { fetchImpl });
    expect(result).toBe(false);
  });

  it("fails open to false when a fetch throws (network error)", async () => {
    const fetchImpl = async () => {
      throw new Error("network unreachable");
    };
    const result = await resolveRejectionSignaled("acme/widgets", { fetchImpl });
    expect(result).toBe(false);
  });

  it("returns false for a malformed repoFullName, without calling fetch", async () => {
    const fetchImpl = vi.fn();
    const result = await resolveRejectionSignaled("not-a-repo", { fetchImpl });
    expect(result).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses a custom rawContentBaseUrl when provided", async () => {
    const calledUrls: string[] = [];
    const fetchImpl = async (url: string) => {
      calledUrls.push(url);
      return textResponse(null, 404);
    };
    await resolveRejectionSignaled("acme/widgets", { fetchImpl, rawContentBaseUrl: "https://raw.example.internal" });
    expect(calledUrls.every((url) => url.startsWith("https://raw.example.internal/acme/widgets/HEAD/"))).toBe(true);
  });

  it("defaults to the real global fetch when fetchImpl is omitted", async () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn(async () => textResponse(null, 404));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const result = await resolveRejectionSignaled("acme/widgets");
      expect(result).toBe(false);
      expect(fetchSpy).toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
