import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// A maintainer session + a path-aware data hook: the dashboard call resolves with reviewability rows (one
// with a slop assessment, one without), every other call stays in loading so sub-panels render harmlessly.
const { useSession } = vi.hoisted(() => ({ useSession: vi.fn() }));
vi.mock("@/lib/api/session", () => ({ useSession: () => useSession() }));

const dashboard = {
  metrics: [],
  health: [],
  reviewability: [
    {
      pr: "acme/widgets#7",
      title: "Tidy things",
      author: "alice",
      bucket: "review-now",
      reason: "cached open PR",
      slop: { risk: 72, band: "high" },
    },
    {
      pr: "acme/widgets#8",
      title: "Real feature",
      author: "bob",
      bucket: "watch",
      reason: "linked issue #3",
      slop: null,
    },
  ],
  settingsPreview: { removed: [], added: [] },
};

vi.mock("@/lib/api/use-api-resource", () => ({
  useApiResource: (path: string) =>
    path.includes("maintainer-dashboard")
      ? { status: "ready", data: dashboard, reload: () => {}, error: null }
      : { status: "loading", data: null, reload: () => {}, error: null },
}));
// AiReviewSettings.load() awaits apiFetch and reads `.ok`; a benign not-ok response keeps it from throwing.
vi.mock("@/lib/api/request", () => ({ apiFetch: vi.fn(async () => ({ ok: false })) }));
vi.mock("@/lib/api/origin", () => ({ getApiOrigin: () => "https://api.test" }));

import { MaintainerPanel } from "@/components/site/app-panels/maintainer-panel";

describe("MaintainerPanel slop score column", () => {
  it("renders a slop band + risk pill for an assessed PR and an em-dash for an unassessed one", () => {
    useSession.mockReturnValue({
      session: { login: "maint", roles: ["maintainer"] },
      hydrated: true,
    });
    render(<MaintainerPanel />);

    // The new column header.
    expect(screen.getByText("Slop")).toBeTruthy();
    // Assessed PR → band + score rendered together.
    expect(screen.getByText(/high\s*72/)).toBeTruthy();
    // Unassessed PR → a muted em-dash placeholder.
    expect(screen.getByText("—")).toBeTruthy();
  });
});
