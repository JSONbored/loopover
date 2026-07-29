import { act, waitFor } from "@testing-library/react";
import { renderHookWithQueryClient as renderHook } from "@/lib/test-query-client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api/request", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock("@/lib/api/origin", () => ({ getApiOrigin: () => "https://api.test" }));

const { toast } = vi.hoisted(() => {
  const fn = Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() });
  return { toast: fn };
});
vi.mock("sonner", () => ({ toast }));

import { useSession } from "@/lib/api/session";

const authedSession = {
  status: "authenticated" as const,
  login: "alice",
  roles: ["maintainer"],
  confirmed_miner: true,
};

// `apiFetch` is the single network seam for both `GET /v1/auth/session` (used by refresh) and
// `POST /v1/auth/logout`. `loggedOut` models the server: once a logout SUCCEEDS the session endpoint reports
// signed_out; a FAILED logout leaves the cookie valid, so the session endpoint keeps reporting authenticated.
function mockServer({ logoutSucceeds }: { logoutSucceeds: boolean }) {
  let loggedOut = false;
  apiFetch.mockImplementation(async (url: string) => {
    if (url.endsWith("/v1/auth/logout")) {
      if (!logoutSucceeds)
        return { ok: false, message: "network blip", status: 500, durationMs: 1 };
      loggedOut = true;
      return { ok: true, data: { status: "signed_out" }, status: 200, durationMs: 1 };
    }
    return {
      ok: true,
      data: loggedOut ? { status: "signed_out" } : authedSession,
      status: 200,
      durationMs: 1,
    };
  });
}

describe("useSession signOut (#7533)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("REGRESSION: restores the session when the logout request fails, instead of leaving it optimistically null", async () => {
    mockServer({ logoutSucceeds: false });
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.session?.login).toBe("alice"));

    await act(async () => {
      await result.current.signOut();
    });

    // The logout failed, so the server cookie is still valid -- signOut must re-sync from the server rather
    // than leaving the optimistic `null`, so the hook (and every other useSession consumer) stays authenticated.
    await waitFor(() => expect(result.current.session?.login).toBe("alice"));
    expect(result.current.session).not.toBeNull();
    expect(toast.error).toHaveBeenCalledWith(
      "Sign out failed",
      expect.objectContaining({ description: expect.anything() }),
    );
  });

  it("shows the success toast on a successful logout, without taking the failure re-sync path (unchanged behavior)", async () => {
    mockServer({ logoutSucceeds: true });
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.session?.login).toBe("alice"));

    await act(async () => {
      await result.current.signOut();
    });

    // Success path is unchanged: the "Signed out" toast fires and the failure-only error toast / re-sync
    // does not run.
    expect(toast).toHaveBeenCalledWith(
      "Signed out",
      expect.objectContaining({ description: expect.anything() }),
    );
    expect(toast.error).not.toHaveBeenCalled();
  });
});
