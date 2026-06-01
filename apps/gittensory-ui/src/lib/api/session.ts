import { useCallback, useEffect, useState } from "react";
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

const SESSION_CHANGED_EVENT = "gittensory.session.changed";

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

  useEffect(() => {
    void refresh();
    const onChange = () => {
      void refresh();
    };
    window.addEventListener(SESSION_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(SESSION_CHANGED_EVENT, onChange);
  }, [refresh]);

  const signIn = () => {
    setAuth({ status: "starting" });
    const origin = getApiOrigin().replace(/\/$/, "");
    const returnTo = typeof window === "undefined" ? "/app" : window.location.href;
    window.location.assign(
      `${origin}/v1/auth/github/start?returnTo=${encodeURIComponent(returnTo)}`,
    );
  };

  const signInPreview = () => {
    if (!import.meta.env.DEV) return;
    setSession({
      login: "local-preview",
      roles: ["miner", "maintainer", "owner", "operator"],
      confirmed_miner: false,
    });
    setHydrated(true);
    setAuth({ status: "idle" });
    toast.success("Local preview session started", {
      description: "This exists only in dev mode and never writes a production token.",
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
