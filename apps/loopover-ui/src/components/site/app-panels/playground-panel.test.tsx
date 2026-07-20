import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Keep the panel off the network — useSession()/live runs both go through apiFetch.
const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api/request", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("@/lib/api/origin", () => ({ getApiOrigin: () => "https://api.test" }));
apiFetch.mockResolvedValue({ ok: true, data: { status: "signed_out" } });

import { PlaygroundPanel } from "@/components/site/app-panels/playground-panel";

describe("PlaygroundPanel accessible names (#7532)", () => {
  it("exposes the Tool, Repo, and Branch controls by their label accessible names", () => {
    render(<PlaygroundPanel />);
    expect(screen.getByRole("combobox", { name: /tool/i })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: /repo/i })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: /branch/i })).toBeTruthy();
  });
});
