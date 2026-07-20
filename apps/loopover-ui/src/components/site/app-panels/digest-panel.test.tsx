import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Drive the digest resource straight to a ready state so the SubscribeForm renders.
const { useApiResource } = vi.hoisted(() => ({ useApiResource: vi.fn() }));
vi.mock("@/lib/api/use-api-resource", () => ({
  useApiResource: () => useApiResource(),
}));
vi.mock("@/lib/api/request", () => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api/origin", () => ({ getApiOrigin: () => "https://api.test" }));

useApiResource.mockReturnValue({
  status: "ready",
  data: {
    date: "2026-07-20",
    signal: "ready",
    items: [{ kind: "summary", title: "One update", detail: "Detail" }],
    subscriptions: [],
    delivery: { mode: "store_only", emailDeliveryEnabled: false },
  },
  reload: () => {},
  error: null,
  errorKind: undefined,
  loadedAt: Date.now(),
});

import { DigestPanel } from "@/components/site/app-panels/digest-panel";

describe("DigestPanel subscribe form accessible name (#7532)", () => {
  it("exposes the email input by its aria-label", () => {
    render(<DigestPanel />);
    expect(screen.getByLabelText(/digest notification email/i)).toBeTruthy();
  });
});
