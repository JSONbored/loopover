import { describe, it, expect, vi, beforeEach } from "vitest";

// withReviewSpan composes the two tracer wrappers; both are mocked here as passthroughs so we assert the
// composition (one boundary → both tracers, option forwarding, value pass-through) without any real SDK.
const otel = vi.hoisted(() => ({
  withOtelSpan: vi.fn(
    <T>(_name: string, _attrs: unknown, fn: () => T | Promise<T>, _options?: unknown): T | Promise<T> => fn(),
  ),
}));
const sentry = vi.hoisted(() => ({
  withSentrySpan: vi.fn(
    <T>(_name: string, _attrs: unknown, fn: () => T | Promise<T>): T | Promise<T> => fn(),
  ),
}));
vi.mock("../../src/selfhost/otel", () => ({ withOtelSpan: otel.withOtelSpan }));
vi.mock("../../src/selfhost/sentry", () => ({ withSentrySpan: sentry.withSentrySpan }));

import { withReviewSpan } from "../../src/selfhost/tracing";

beforeEach(() => vi.clearAllMocks());

describe("withReviewSpan — one boundary feeds both tracers (#1734)", () => {
  it("runs fn through the OTEL span wrapping the Sentry span, and returns fn's value", async () => {
    const result = await withReviewSpan("selfhost.queue.job", { "job.type": "github-webhook" }, async () => "ok");
    expect(result).toBe("ok");
    expect(otel.withOtelSpan).toHaveBeenCalledTimes(1);
    expect(sentry.withSentrySpan).toHaveBeenCalledTimes(1);
    // Same span name + attributes are handed to both tracers.
    expect(otel.withOtelSpan.mock.calls[0]![0]).toBe("selfhost.queue.job");
    expect(sentry.withSentrySpan.mock.calls[0]![0]).toBe("selfhost.queue.job");
  });

  it("forwards the parentTraceParent option to the OTEL span (cross-job trace continuity)", async () => {
    await withReviewSpan("n", undefined, async () => 1, { parentTraceParent: "00-trace-span-01" });
    expect(otel.withOtelSpan.mock.calls[0]![3]).toEqual({ parentTraceParent: "00-trace-span-01" });
  });

  it("reduces to fn() when both tracer wrappers no-op (neither backend configured)", async () => {
    expect(await withReviewSpan("n", undefined, async () => 42)).toBe(42);
  });
});
