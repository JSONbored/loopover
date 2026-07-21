import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Mock the API layer so the settings + focus-manifest loads resolve without a network.
const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api/request", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("@/lib/api/origin", () => ({ getApiOrigin: () => "https://api.test" }));

import { MaintainerSettings } from "@/components/site/app-panels/maintainer-settings";

describe("MaintainerSettings focus-manifest editor accessible name (#7532)", () => {
  it("exposes the focus-manifest textarea by its aria-label once settings load", async () => {
    apiFetch.mockImplementation((url: string) => {
      if (url.endsWith("/focus-manifest")) {
        return Promise.resolve({ ok: true, data: { manifest: { wanted: [] } } });
      }
      // /settings
      return Promise.resolve({ ok: true, data: { autoLabelEnabled: false } });
    });

    render(<MaintainerSettings reviewability={[{ pr: "acme/widgets#1" }]} />);

    expect(await screen.findByRole("textbox", { name: /focus manifest/i })).toBeTruthy();
  });
});
