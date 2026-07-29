import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { apiFetch } from "./request";
import { getApiOrigin } from "./origin";

export type AppRole = "miner" | "maintainer" | "owner" | "operator";

export interface AppSession {
  login: string;
  github_id?: number | null;
  githubId?: number | null;
  roles: AppRole[];
  roleSummary?: {
    roles: AppRole[];
    onboarding: {
      status: "ready" | "needs_setup";
      primaryRole?: AppRole;
      nextActions: string[];
    };
    roleCards: Array<{
      role: AppRole;
      status: "active" | "available" | "needs_setup";
      title: string;
      detail: string;
      href: string;
      evidenceCount: number;
      sampleRepos: string[];
      nextActions: string[];
    }>;
  };
  confirmed_miner: boolean;
  confirmedMiner?: boolean;
  expiresAt?: string;
  scopes?: string[];
  createdAt?: string;
  lastSeenAt?: string | null;
}

type AuthState =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "loading" }
  | { status: "error"; message: string };

type SessionResponse = (AppSession & { status: "authenticated" }) | { status: "signed_out" };

const SESSION_CHANGED_EVENT = "loopover.session.changed";

async function fetchBrowserSession(): Promise<AppSession | null> {
  const origin = getApiOrigin().replace(/\/$/, "");
  const result = await apiFetch<SessionResponse>(`${origin}/v1/auth/session`, {
    method: "GET",
    label: "Session",
    credentials: "include",
    headers: { Accept: "application/json" },
    silentStatus: true,
    timeoutMs: 8_000,
  });
  return result.ok && result.data.status === "authenticated" ? result.data : null;
}

function emitSessionChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SESSION_CHANGED_EVENT));
}

// The synthetic local-preview session is available in `vite dev` (DEV) AND on dedicated preview deploys
// built with VITE_PREVIEW=1 (the per-PR `ui-preview.yml` build sets it; production builds never do, so this
// escape hatch is dead-code-eliminated from prod). It writes no real token and grants only a client-side
// demo session — it lets the reviewbot screenshot pipeline render the authenticated /app/* UI instead of a
// screenshot of the sign-in wall. (#authed-route-preview)
export const PREVIEW_SESSION_ALLOWED = import.meta.env.DEV || import.meta.env.VITE_PREVIEW === "1";

export function useSession() {
  const [session, setSession] = useState<AppSession | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });

  const refresh = useCallback(async () => {
    const next = await fetchBrowserSession();
    setSession(next);
    setHydrated(true);
    setAuth({ status: "idle" });
    return next;
  }, []);

  // Subscribing to an external event is what effects are FOR, so this one stays -- what moved out of it is
  // the mount-time fetch, which now runs as a react-query query (#9588). The listener only re-triggers that
  // query; it sets no state of its own, and the query owns the request's lifecycle.
  useEffect(() => {
    const onChange = () => {
      void refresh();
    };
    window.addEventListener(SESSION_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(SESSION_CHANGED_EVENT, onChange);
  }, [refresh]);

  // The initial read. Its result is written into the same state the event listener and the sign-in/out
  // paths write, so every consumer keeps seeing one session value from one place.
  useQuery({
    queryKey: ["browser-session"],
    retry: false,
    refetchOnWindowFocus: false,
    gcTime: 0,
    queryFn: async () => {
      await refresh();
      // The value lives in state above; react-query only owns WHEN this runs, so the payload it caches
      // would be a second copy of the truth. Returning null keeps it from becoming one.
      return null;
    },
  });

  const signIn = () => {
    setAuth({ status: "starting" });
    const origin = getApiOrigin().replace(/\/$/, "");
    const returnTo = typeof window === "undefined" ? "/app" : window.location.href;
    window.location.assign(
      `${origin}/v1/auth/github/start?returnTo=${encodeURIComponent(returnTo)}`,
    );
  };

  const signInPreview = () => {
    if (!PREVIEW_SESSION_ALLOWED) return;
    setSession({
      login: "local-preview",
      roles: ["miner", "maintainer", "owner", "operator"],
      confirmed_miner: false,
    });
    setHydrated(true);
    setAuth({ status: "idle" });
    toast.success("Preview session started", {
      description: "A demo session for dev + preview deploys — it never writes a production token.",
    });
  };

  const signOut = async () => {
    const origin = getApiOrigin().replace(/\/$/, "");
    setSession(null);
    emitSessionChanged();
    const result = await apiFetch(`${origin}/v1/auth/logout`, {
      method: "POST",
      label: "Sign out",
      credentials: "include",
      silentStatus: true,
    });
    if (!result.ok) {
      toast.error("Sign out failed", { description: result.message });
      // The optimistic setSession(null)/emitSessionChanged above cleared the client session before the server
      // confirmed the logout. A failed request means the server cookie is still valid, so re-sync from the
      // server (the definitive source of truth) and re-broadcast — restoring the still-authenticated session
      // instead of leaving this hook and every other useSession() consumer falsely signed out (#7533).
      await refresh();
      emitSessionChanged();
      return;
    }
    toast("Signed out", { description: "The browser session cookie was cleared." });
  };

  return {
    session,
    hydrated,
    auth,
    signIn,
    signInPreview,
    signOut,
    refresh,
  };
}
