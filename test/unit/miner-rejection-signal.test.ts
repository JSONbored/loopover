import { describe, expect, it, vi } from "vitest";

vi.mock("@jsonbored/gittensory-engine", async () => {
  return import("../../packages/gittensory-engine/src/index");
});

import { resolveRejectionSignaled } from "../../packages/gittensory-miner/lib/rejection-signal.js";

// resolveRejectionSignaled fetches plain markdown text (AI-USAGE.md/CONTRIBUTING.md), never JSON, so
// json() is never actually called -- it's here only to satisfy SelfReviewContextFetch's response shape.
function textResponse(text: string | null, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async (): Promise<unknown> => {
      throw new Error("textResponse: json() is unused by resolveRejectionSignaled");
    },
    text: async () => text ?? "",
  };
}

/** Routes by URL substring; a null respond() throws to simulate a network failure. */
function routedFetch(routes: Record<string, () => ReturnType<typeof textResponse>>) {
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

  it("does not fetch CONTRIBUTING.md when a non-empty AI-USAGE.md decides the policy", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("AI-USAGE.md")) return textResponse("No AI-generated pull requests, please.");
      return textResponse("Do not download me");
    });

    const result = await resolveRejectionSignaled("acme/widgets", { fetchImpl });

    expect(result).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toContain("AI-USAGE.md");
  });

  it("treats an oversized policy document as absent without reading its body", async () => {
    const text = vi.fn(async () => "No AI-generated pull requests, please.");
    const fetchImpl = routedFetch({
      "AI-USAGE.md": () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": String(129 * 1024) }),
        json: async (): Promise<unknown> => {
          throw new Error("json() is unused by resolveRejectionSignaled");
        },
        text,
      }),
      "CONTRIBUTING.md": () => textResponse("Welcome, contributors!"),
    });

    const result = await resolveRejectionSignaled("acme/widgets", { fetchImpl });

    expect(result).toBe(false);
    expect(text).not.toHaveBeenCalled();
  });

  it("ignores a non-numeric content-length header and falls through to reading the body", async () => {
    const fetchImpl = routedFetch({
      "AI-USAGE.md": () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": "not-a-number" }),
        json: async (): Promise<unknown> => {
          throw new Error("json() is unused by resolveRejectionSignaled");
        },
        text: async () => "No AI-generated pull requests, please.",
      }),
      "CONTRIBUTING.md": () => textResponse("Welcome, contributors!"),
    });

    const result = await resolveRejectionSignaled("acme/widgets", { fetchImpl });

    expect(result).toBe(true);
  });

  it("treats an oversized non-streamed policy document as absent", async () => {
    const oversizedText = "a".repeat(129 * 1024);
    const fetchImpl = routedFetch({
      "AI-USAGE.md": () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async (): Promise<unknown> => {
          throw new Error("json() is unused by resolveRejectionSignaled");
        },
        text: async () => oversizedText,
      }),
      "CONTRIBUTING.md": () => textResponse("Do not submit AI-generated code."),
    });

    const result = await resolveRejectionSignaled("acme/widgets", { fetchImpl });

    // AI-USAGE.md is treated as absent (oversized), so the verdict falls through to CONTRIBUTING.md's ban.
    expect(result).toBe(true);
  });

  it("cancels a streamed policy document once it exceeds the byte limit", async () => {
    let canceled = false;
    const chunk = new Uint8Array(65 * 1024);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
      },
      cancel() {
        canceled = true;
      },
    });
    const fetchImpl = routedFetch({
      "AI-USAGE.md": () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: stream,
        json: async (): Promise<unknown> => {
          throw new Error("json() is unused by resolveRejectionSignaled");
        },
        text: async () => {
          throw new Error("streaming responses should not call text()");
        },
      }),
      "CONTRIBUTING.md": () => textResponse("Welcome, contributors!"),
    });

    const result = await resolveRejectionSignaled("acme/widgets", { fetchImpl });

    expect(result).toBe(false);
    expect(canceled).toBe(true);
  });

  it("reads a streamed policy document to completion when it stays within the byte limit", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("No AI-generated "));
        controller.enqueue(encoder.encode("pull requests, please."));
        controller.close();
      },
    });
    const fetchImpl = routedFetch({
      "AI-USAGE.md": () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: stream,
        json: async (): Promise<unknown> => {
          throw new Error("json() is unused by resolveRejectionSignaled");
        },
        text: async () => {
          throw new Error("streaming responses should not call text()");
        },
      }),
      "CONTRIBUTING.md": () => textResponse("Welcome, contributors!"),
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
