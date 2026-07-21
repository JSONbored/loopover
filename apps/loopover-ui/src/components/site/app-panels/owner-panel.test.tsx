import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Stub the data hook so the panel never touches the network; the Repository input
// renders above the state boundary regardless of resource status.
const { useApiResource } = vi.hoisted(() => ({ useApiResource: vi.fn() }));
vi.mock("@/lib/api/use-api-resource", () => ({
  useApiResource: () => useApiResource(),
}));
useApiResource.mockReturnValue({
  status: "loading",
  data: null,
  reload: () => {},
  reject: () => {},
  error: null,
  errorKind: undefined,
  loadedAt: null,
});

import { OwnerPanel } from "@/components/site/app-panels/owner-panel";

describe("OwnerPanel accessible name (#7532)", () => {
  it("exposes the Repository input by its label's accessible name", () => {
    render(<OwnerPanel />);
    expect(screen.getByLabelText(/repository/i)).toBeTruthy();
  });
});
