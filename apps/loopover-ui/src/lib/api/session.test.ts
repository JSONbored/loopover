import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api/request", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("@/lib/api/origin", () => ({ getApiOrigin: () => "https://api.test" }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

import { useSession } from "@/lib/api/session";

describe("useSession signOut (#7533)", () => {
  it("re-syncs from the server AFTER a failed logout instead of staying optimistically signed out", async () => {
    const authed = {
      status: "authenticated",
      login: "alice",
      roles: ["maintainer"],
      confirmed_miner: true,
    };
    // Record each call so we can prove a session re-sync happens *after* the logout fails — the emit-driven
    // refresh fires before the logout POST, so only the fix's own post-failure refresh() lands after it.
    const calls: string[] = [];
    apiFetch.mockImplementation((url: string) => {
      const kind = url.includes("/v1/auth/logout") ? "logout" : "session";
      calls.push(kind);
      // The logout POST fails; the session GET still reports authenticated, because a failed logout never
      // cleared the server-side cookie — so the app must not remain optimistically signed out.
      return kind === "logout"
        ? Promise.resolve({ ok: false, kind: "http", message: "500", status: 500, durationMs: 1 })
        : Promise.resolve({ ok: true, data: authed, status: 200, durationMs: 1 });
    });

    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.session?.login).toBe("alice"));

    await act(async () => {
      await result.current.signOut();
    });

    // Regression for #7533: the failed logout optimistically cleared the session; the fix re-syncs it from
    // the server so the app is not left falsely signed out (hiding every role-gated route until a reload).
    await waitFor(() => expect(result.current.session?.login).toBe("alice"));
    expect(result.current.session).not.toBeNull();

    // The fix specifically: a session re-sync runs AFTER the failed logout POST. Without it, the only
    // refreshes are the mount hydrate + the pre-logout emit, so nothing follows the logout call.
    const afterLogout = calls.slice(calls.indexOf("logout") + 1);
    expect(afterLogout).toContain("session");
  });
});
