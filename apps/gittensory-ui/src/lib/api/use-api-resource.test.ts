import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api/request", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock("@/lib/api/origin", () => ({ getApiOrigin: () => "https://api.test" }));

import { useApiResource } from "@/lib/api/use-api-resource";

describe("useApiResource loadedAt (#2219)", () => {
  it("stamps loadedAt when a load succeeds, so headers can show 'last refresh'", async () => {
    apiFetch.mockResolvedValue({ ok: true, data: { rows: [] }, status: 200, durationMs: 5 });
    const before = Date.now();
    const { result } = renderHook(() => useApiResource<{ rows: [] }>("/v1/thing", "Thing"));
    expect(result.current.loadedAt).toBeNull();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.loadedAt).toBeGreaterThanOrEqual(before);
    expect(result.current.loadedAt).toBeLessThanOrEqual(Date.now());
  });

  it("keeps loadedAt null on a failed load", async () => {
    apiFetch.mockResolvedValue({ ok: false, message: "boom", status: 500, durationMs: 5 });
    const { result } = renderHook(() => useApiResource("/v1/thing", "Thing"));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.loadedAt).toBeNull();
  });

  it("keeps loadedAt null when the resource is disabled", async () => {
    const { result } = renderHook(() =>
      useApiResource("/v1/thing", "Thing", undefined, { enabled: false }),
    );
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toBe("disabled");
    expect(result.current.loadedAt).toBeNull();
  });
});
