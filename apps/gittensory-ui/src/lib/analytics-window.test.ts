import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  ANALYTICS_WINDOW_STORAGE_KEY,
  DEFAULT_ANALYTICS_WINDOW_DAYS,
  operatorDashboardPath,
  parseAnalyticsWindowDays,
} from "@/lib/analytics-window";
import { useApiResource } from "@/lib/api/use-api-resource";
import { useLocalStorage } from "@/lib/use-local-storage";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api/request", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock("@/lib/api/origin", () => ({ getApiOrigin: () => "https://api.test" }));

describe("parseAnalyticsWindowDays (#2199)", () => {
  it("defaults invalid values to 7d", () => {
    expect(parseAnalyticsWindowDays(undefined)).toBe(7);
    expect(parseAnalyticsWindowDays("14")).toBe(7);
  });

  it("accepts the supported 7/30/90 day windows", () => {
    expect(parseAnalyticsWindowDays(30)).toBe(30);
    expect(parseAnalyticsWindowDays("90")).toBe(90);
  });
});

describe("operatorDashboardPath (#2199)", () => {
  it("threads the selected window into the fetch path", () => {
    expect(operatorDashboardPath(7)).toBe("/v1/app/operator-dashboard?days=7");
    expect(operatorDashboardPath(30)).toBe("/v1/app/operator-dashboard?days=30");
  });
});

describe("analytics window persistence (#2199)", () => {
  it("restores a persisted value from localStorage", async () => {
    window.localStorage.setItem(ANALYTICS_WINDOW_STORAGE_KEY, JSON.stringify(90));
    const { result } = renderHook(() =>
      useLocalStorage(ANALYTICS_WINDOW_STORAGE_KEY, DEFAULT_ANALYTICS_WINDOW_DAYS),
    );
    await waitFor(() => expect(result.current[2]).toBe(true));
    expect(result.current[0]).toBe(90);
  });

  it("falls back to the default when storage is empty", async () => {
    window.localStorage.removeItem(ANALYTICS_WINDOW_STORAGE_KEY);
    const { result } = renderHook(() =>
      useLocalStorage(ANALYTICS_WINDOW_STORAGE_KEY, DEFAULT_ANALYTICS_WINDOW_DAYS),
    );
    await waitFor(() => expect(result.current[2]).toBe(true));
    expect(result.current[0]).toBe(DEFAULT_ANALYTICS_WINDOW_DAYS);
  });
});

describe("useApiResource window re-key (#2199)", () => {
  it("refetches when the dashboard path changes", async () => {
    apiFetch.mockResolvedValue({ ok: true, data: { metrics: [] }, status: 200, durationMs: 5 });
    const { result, rerender } = renderHook(
      ({ path }: { path: string }) => useApiResource<{ metrics: [] }>(path, "Product analytics"),
      { initialProps: { path: operatorDashboardPath(7) } },
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(apiFetch).toHaveBeenCalledWith(
      "https://api.test/v1/app/operator-dashboard?days=7",
      expect.any(Object),
    );

    rerender({ path: operatorDashboardPath(30) });
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        "https://api.test/v1/app/operator-dashboard?days=30",
        expect.any(Object),
      ),
    );
  });
});
