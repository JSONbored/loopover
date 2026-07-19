import { describe, expect, it, vi } from "vitest";

vi.mock("@loopover/engine", async () => {
  return import("../../packages/loopover-engine/src/index");
});

import {
  REJECTION_REASON_AI_USAGE_POLICY_BAN,
  REJECTION_REASON_OWN_SUBMISSION_REJECTED,
  resolveOwnRejectionHistory,
  resolveRejectionSignaled,
} from "../../packages/loopover-miner/lib/rejection-signal.js";

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
    expect(result).toBe(REJECTION_REASON_AI_USAGE_POLICY_BAN);
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
    expect(result).toBe(REJECTION_REASON_AI_USAGE_POLICY_BAN);
  });

  it("does not fetch CONTRIBUTING.md when a non-empty AI-USAGE.md decides the policy", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("AI-USAGE.md")) return textResponse("No AI-generated pull requests, please.");
      return textResponse("Do not download me");
    });

    const result = await resolveRejectionSignaled("acme/widgets", { fetchImpl });

    expect(result).toBe(REJECTION_REASON_AI_USAGE_POLICY_BAN);
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

    expect(result).toBe(REJECTION_REASON_AI_USAGE_POLICY_BAN);
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
    expect(result).toBe(REJECTION_REASON_AI_USAGE_POLICY_BAN);
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

    expect(result).toBe(REJECTION_REASON_AI_USAGE_POLICY_BAN);
  });

  it("tolerates a stream read that reports a chunk with no value (skips it, keeps reading)", async () => {
    const encoder = new TextEncoder();
    let call = 0;
    const body = {
      getReader() {
        return {
          read: async () => {
            call += 1;
            if (call === 1) return { done: false, value: undefined };
            if (call === 2) return { done: false, value: encoder.encode("No AI-generated pull requests, please.") };
            return { done: true, value: undefined };
          },
          cancel: async () => undefined,
          releaseLock: () => undefined,
        };
      },
    };
    const fetchImpl = routedFetch({
      "AI-USAGE.md": () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        body,
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

    expect(result).toBe(REJECTION_REASON_AI_USAGE_POLICY_BAN);
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

  it("returns false for a non-string repoFullName, without calling fetch", async () => {
    const fetchImpl = vi.fn();
    const result = await resolveRejectionSignaled(42 as unknown as string, { fetchImpl });
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
      const result = await resolveRejectionSignaled("acme/widgets", { listSubmissions: () => [] });
      expect(result).toBe(false);
      expect(fetchSpy).toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

const CLOSED_WITHOUT_MERGE = {
  state: "closed",
  merged: false,
  closed_at: "2026-07-01T00:00:00Z",
  merged_at: null,
};
const MERGED = {
  state: "closed",
  merged: true,
  closed_at: "2026-07-01T00:00:00Z",
  merged_at: "2026-07-01T00:00:00Z",
};

describe("resolveOwnRejectionHistory (#5655)", () => {
  it("returns true when a prior submission on the repo resolves to a closed-without-merge PR", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: unknown) => jsonResponse(CLOSED_WITHOUT_MERGE));
    const result = await resolveOwnRejectionHistory("acme/widgets", {
      listSubmissions: () => [{ pullRequestNumber: 42 }],
      fetchImpl,
    });
    expect(result).toBe(true);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/repos/acme/widgets/pulls/42");
  });

  it("returns false and fetches nothing when no prior submission on this repo has a real PR number", async () => {
    const fetchImpl = vi.fn();
    const result = await resolveOwnRejectionHistory("acme/widgets", {
      listSubmissions: () => [{ pullRequestNumber: null }, { pullRequestNumber: 0 }, {}],
      fetchImpl,
    });
    expect(result).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("bounds the fetch count to maxRejectionHistoryChecks (no unbounded fan-out)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(MERGED)); // none rejected -> it checks up to the cap
    const submissions = Array.from({ length: 15 }, (_, i) => ({ pullRequestNumber: i + 1 }));
    const result = await resolveOwnRejectionHistory("acme/widgets", {
      listSubmissions: () => submissions,
      fetchImpl,
      maxRejectionHistoryChecks: 3,
    });
    expect(result).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("fails open on an individual PR fetch failure while still checking the rest", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/pulls/1")) throw new Error("network unreachable");
      return jsonResponse(CLOSED_WITHOUT_MERGE);
    });
    const result = await resolveOwnRejectionHistory("acme/widgets", {
      listSubmissions: () => [{ pullRequestNumber: 1 }, { pullRequestNumber: 2 }],
      fetchImpl,
    });
    expect(result).toBe(true); // PR 1 failed, but PR 2's rejection is still detected
  });

  it("treats a non-array submissions result as empty and fetches nothing", async () => {
    const fetchImpl = vi.fn();
    const result = await resolveOwnRejectionHistory("acme/widgets", {
      listSubmissions: (() => null) as never,
      fetchImpl,
    });
    expect(result).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails open to false (never throws) on a wholesale failure to read submissions", async () => {
    const result = await resolveOwnRejectionHistory("acme/widgets", {
      listSubmissions: () => {
        throw new Error("db unavailable");
      },
      fetchImpl: vi.fn(),
    });
    expect(result).toBe(false);
  });

  it("treats a non-2xx PR response as not-a-rejection", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 404));
    const result = await resolveOwnRejectionHistory("acme/widgets", {
      listSubmissions: () => [{ pullRequestNumber: 7 }],
      fetchImpl,
    });
    expect(result).toBe(false);
  });

  it("does not treat a merged PR as a rejection", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(MERGED));
    const result = await resolveOwnRejectionHistory("acme/widgets", {
      listSubmissions: () => [{ pullRequestNumber: 9 }],
      fetchImpl,
    });
    expect(result).toBe(false);
  });

  it("sends the auth header and hits the configured API base when an auth value is provided", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: unknown) => jsonResponse(MERGED));
    const injectedAuthValue = "fake-auth-placeholder";
    await resolveOwnRejectionHistory("acme/widgets", {
      listSubmissions: () => [{ pullRequestNumber: 9 }],
      fetchImpl,
      githubToken: injectedAuthValue,
      githubApiBaseUrl: "https://api.example.internal",
    });
    const init = fetchImpl.mock.calls[0]?.[1] as { headers?: Record<string, string> };
    expect(init?.headers?.authorization).toBe(`Bearer ${injectedAuthValue}`);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(
      "https://api.example.internal/repos/acme/widgets/pulls/9",
    );
  });

  it("returns false for a malformed repoFullName without reading submissions", async () => {
    const listSubmissions = vi.fn();
    const result = await resolveOwnRejectionHistory("not-a-repo", { listSubmissions, fetchImpl: vi.fn() });
    expect(result).toBe(false);
    expect(listSubmissions).not.toHaveBeenCalled();
  });
});

describe("resolveRejectionSignaled combines both triggers (#5655)", () => {
  it("returns true from the policy-ban trigger even with a clean rejection history (short-circuits)", async () => {
    const listSubmissions = vi.fn(() => []);
    const result = await resolveRejectionSignaled("acme/widgets", {
      fetchImpl: routedFetch({
        "AI-USAGE.md": () => textResponse("No AI-generated pull requests, please."),
        "CONTRIBUTING.md": () => textResponse("Welcome, contributors!"),
      }),
      listSubmissions,
    });
    expect(result).toBe(REJECTION_REASON_AI_USAGE_POLICY_BAN);
    expect(listSubmissions).not.toHaveBeenCalled();
  });

  it("returns own_submission_rejected from the own-rejection-history trigger when the policy docs are clean", async () => {
    const policyFetch = routedFetch({
      "AI-USAGE.md": () => textResponse("AI contributions are welcome here."),
      "CONTRIBUTING.md": () => textResponse("Welcome, contributors!"),
    });
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("/pulls/") ? jsonResponse(CLOSED_WITHOUT_MERGE) : policyFetch(url),
    );
    const result = await resolveRejectionSignaled("acme/widgets", {
      fetchImpl,
      listSubmissions: () => [{ pullRequestNumber: 42 }],
    });
    expect(result).toBe(REJECTION_REASON_OWN_SUBMISSION_REJECTED);
  });

  it("returns false when neither trigger fires (clean policy + no prior rejection)", async () => {
    const policyFetch = routedFetch({
      "AI-USAGE.md": () => textResponse("AI contributions are welcome here."),
      "CONTRIBUTING.md": () => textResponse("Welcome, contributors!"),
    });
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("/pulls/") ? jsonResponse(MERGED) : policyFetch(url),
    );
    const result = await resolveRejectionSignaled("acme/widgets", {
      fetchImpl,
      listSubmissions: () => [{ pullRequestNumber: 42 }],
    });
    expect(result).toBe(false);
  });
});
