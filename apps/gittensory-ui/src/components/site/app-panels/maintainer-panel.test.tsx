import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Control the session role + stub the data hook so the dashboard branch never hits the network.
const useSession = vi.fn();
vi.mock("@/lib/api/session", () => ({ useSession: () => useSession() }));
vi.mock("@/lib/api/use-api-resource", () => ({
  useApiResource: () => ({ status: "loading", data: null, reload: () => {}, error: null }),
}));

import { MaintainerPanel } from "@/components/site/app-panels/maintainer-panel";

describe("MaintainerPanel role gate", () => {
  it("shows a loading state until the session is hydrated", () => {
    useSession.mockReturnValue({ session: null, hydrated: false });
    render(<MaintainerPanel />);
    expect(screen.getByText(/Checking maintainer access/i)).toBeTruthy();
  });

  it("blocks a non-maintainer: shows 'Maintainer access required' and never mounts the BYOK panel", () => {
    useSession.mockReturnValue({ session: { login: "miner", roles: ["miner"] }, hydrated: true });
    render(<MaintainerPanel />);
    expect(screen.getByText(/Maintainer access required/i)).toBeTruthy();
    // The BYOK key field (the only sk-ant- placeholder) must not exist for a non-maintainer.
    expect(screen.queryByPlaceholderText("sk-ant-…")).toBeNull();
  });

  it("admits a maintainer (no access-required message) and proceeds to the dashboard", () => {
    useSession.mockReturnValue({
      session: { login: "maint", roles: ["maintainer"] },
      hydrated: true,
    });
    render(<MaintainerPanel />);
    expect(screen.queryByText(/Maintainer access required/i)).toBeNull();
  });
});
