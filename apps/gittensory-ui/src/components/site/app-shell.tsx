import { Link, Outlet, useLocation, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  BarChart3,
  ExternalLink,
  FolderGit2,
  LayoutGrid,
  Loader2,
  LogOut,
  ScrollText,
  TerminalSquare,
  Wrench,
  Workflow,
} from "lucide-react";
import type { ComponentType } from "react";
import { useEffect, useState } from "react";

import { PREVIEW_SESSION_ALLOWED, useSession } from "@/lib/api/session";
import { describeApiStatus, pingHealth, useApiStatus } from "@/lib/api/status";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { GittensoryMark } from "./mark";
import { StatusPill, type Status } from "./control-primitives";
import { LoadingState } from "./state-views";
import { cn } from "@/lib/utils";

type NavItem = {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  roles?: string[];
};

type NavGroup = { label: string; items: NavItem[] };

const GROUPS: NavGroup[] = [
  {
    label: "Workspace",
    items: [
      { to: "/app", label: "Overview", icon: LayoutGrid },
      {
        to: "/app/workbench",
        label: "Workbench",
        icon: Workflow,
        roles: ["miner", "maintainer", "owner", "operator"],
      },
      {
        to: "/app/repos",
        label: "Repositories",
        icon: FolderGit2,
        roles: ["maintainer", "owner", "operator"],
      },
      {
        to: "/app/runs",
        label: "Agent runs",
        icon: Activity,
        roles: ["miner", "maintainer", "owner", "operator"],
      },
      {
        to: "/app/audit",
        label: "Skip audit",
        icon: ScrollText,
        roles: ["maintainer", "owner", "operator"],
      },
    ],
  },
  {
    label: "Operations",
    items: [
      {
        to: "/app/analytics",
        label: "Analytics",
        icon: BarChart3,
        roles: ["operator"],
      },
      { to: "/app/operator", label: "Operator", icon: Wrench, roles: ["operator"] },
    ],
  },
];

export function AppShell() {
  const { session, hydrated, signOut, signInPreview } = useSession();
  const loc = useLocation();
  const navigate = useNavigate();
  const routerState = useRouterState();
  const [sidebarOpen, setSidebarOpen] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    const m = document.cookie.match(/(?:^|; )sidebar_state=([^;]+)/);
    setSidebarOpen(m ? m[1] === "true" : true);
  }, []);

  // Preview deploys: when this is a preview build (VITE_PREVIEW) and the URL carries `?preview=1`, start
  // the synthetic demo session automatically once hydration confirms there's no real session. This lets the
  // reviewbot screenshot pipeline capture the authenticated /app/* UI instead of the sign-in wall. The
  // effect depends on `session`, so it self-heals if a later refresh clears the synthetic session. Inert in
  // production (PREVIEW_SESSION_ALLOWED is compiled to false) and without the param. (#authed-route-preview)
  useEffect(() => {
    if (!PREVIEW_SESSION_ALLOWED || session || !hydrated) return;
    if (new URLSearchParams(window.location.search).get("preview") === "1") signInPreview();
  }, [session, hydrated, signInPreview]);

  // Keyboard shortcuts: g+o overview, g+w workbench, g+r runs, g+p repos, g+a analytics.
  useEffect(() => {
    if (!session) return;
    let armed = false;
    let timer: number | undefined;
    const isEditable = (el: EventTarget | null) => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
    };
    const map: Record<string, string> = {
      o: "/app",
      w: "/app/workbench",
      r: "/app/runs",
      p: "/app/repos",
      a: "/app/analytics",
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditable(e.target)) return;
      if (!armed && e.key === "g") {
        armed = true;
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          armed = false;
        }, 900);
        return;
      }
      if (armed) {
        const dest = map[e.key.toLowerCase()];
        armed = false;
        window.clearTimeout(timer);
        if (dest) {
          e.preventDefault();
          void navigate({ to: dest });
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.clearTimeout(timer);
    };
  }, [navigate, session]);

  if (!hydrated || sidebarOpen === undefined) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16">
        <LoadingState
          title="Loading app shell…"
          description="Restoring your local session and navigation preferences."
        />
      </div>
    );
  }

  if (!session) {
    return <SignedOut />;
  }

  const roles = new Set(session.roles);
  const isActive = (to: string) =>
    to === "/app" ? loc.pathname === "/app" : loc.pathname.startsWith(to);

  const visibleGroups = GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((n) => !n.roles || n.roles.some((r) => roles.has(r as never))),
  })).filter((g) => g.items.length > 0);

  const current =
    visibleGroups.flatMap((g) => g.items).find((n) => isActive(n.to))?.label ?? "Workspace";

  // Tab-aware breadcrumb suffix for routes that drive content via ?tab=
  const tabSearch = (routerState.location.search as Record<string, unknown>)?.tab;
  const currentTab = typeof tabSearch === "string" ? tabSearch : undefined;
  const tabLabel = currentTab
    ? currentTab
        .split("-")
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
        .join(" ")
    : null;

  return (
    <SidebarProvider defaultOpen={sidebarOpen}>
      <Sidebar collapsible="icon" className="border-r border-border">
        <SidebarHeader className="border-b border-border">
          <div className="flex items-center gap-0.5 px-2 py-1.5">
            <GittensoryMark className="size-4" />
            <span className="sr-only">Gittensory</span>
            <span
              aria-hidden
              className="truncate font-display text-token-sm font-semibold group-data-[collapsible=icon]:hidden"
            >
              ittensory
            </span>
          </div>
        </SidebarHeader>
        <SidebarContent>
          {visibleGroups.map((g) => (
            <SidebarGroup key={g.label}>
              <SidebarGroupLabel className="font-mono text-token-2xs uppercase tracking-wider">
                {g.label}
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {g.items.map((n) => {
                    const Icon = n.icon;
                    const active = isActive(n.to);
                    return (
                      <SidebarMenuItem key={n.to}>
                        <SidebarMenuButton
                          asChild
                          isActive={active}
                          tooltip={n.label}
                          className={cn(
                            "transition-colors duration-150 motion-reduce:transition-none",
                            active && "nav-active-bar",
                          )}
                        >
                          <Link to={n.to} aria-current={active ? "page" : undefined}>
                            <Icon className="size-4" />
                            <span>{n.label}</span>
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>
        <SidebarFooter className="border-t border-border">
          <div className="flex flex-col gap-2 px-2 py-2 group-data-[collapsible=icon]:hidden">
            <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
              Signed in
            </div>
            <div className="truncate font-display text-token-sm font-semibold">{session.login}</div>
            <div className="flex flex-wrap gap-1">
              {session.roles.slice(0, 3).map((role) => (
                <StatusPill key={role} status="ready">
                  {role}
                </StatusPill>
              ))}
              {session.roles.length === 0 && <StatusPill status="warn">setup</StatusPill>}
              <ApiStatusButton />
            </div>
            <button
              type="button"
              onClick={signOut}
              className="mt-1 inline-flex min-w-0 w-full items-center justify-center gap-2 rounded-token border border-border px-2 py-1.5 text-center text-token-xs text-muted-foreground transition-all duration-150 hover:bg-muted hover:text-foreground focus-ring motion-reduce:transition-none motion-reduce:active:scale-100 active:scale-[0.98]"
            >
              <LogOut className="size-3.5" />
              Sign out
            </button>
          </div>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="bg-background">
        <header className="sticky top-14 z-20 flex h-12 items-center gap-3 border-b border-border bg-background/90 px-4 backdrop-blur sm:px-6">
          <SidebarTrigger className="-ml-1" />
          <nav className="flex items-center gap-2 text-token-sm">
            <Link
              to="/app"
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              App
            </Link>
            <span className="text-muted-foreground/50">/</span>
            <span
              className={cn(
                "text-foreground",
                tabLabel
                  ? "text-muted-foreground transition-colors hover:text-foreground"
                  : "font-medium",
              )}
            >
              {current}
            </span>
            {tabLabel && (
              <>
                <span className="text-muted-foreground/50">/</span>
                <span className="font-medium text-foreground capitalize">{tabLabel}</span>
              </>
            )}
          </nav>
          <div className="ml-auto hidden items-center gap-1 font-mono text-token-2xs text-muted-foreground sm:flex">
            <kbd className="rounded border border-border bg-background/60 px-1 py-0.5">g</kbd>
            <span>then</span>
            <kbd className="rounded border border-border bg-background/60 px-1 py-0.5">o w r</kbd>
            <span>to navigate</span>
          </div>
        </header>
        <div className="min-w-0 px-4 py-6 sm:px-6 lg:px-8">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

function ApiStatusButton() {
  const { status, connection, lastCheckedAt } = useApiStatus();
  const tone: Status =
    connection === "offline" || status === "unreachable" || status === "timeout"
      ? "blocked"
      : status === "degraded"
        ? "warn"
        : status === "ok"
          ? "ready"
          : "info";
  const label =
    connection === "offline"
      ? "Offline"
      : status === "ok"
        ? "API · ready"
        : status === "loading" || status === "idle"
          ? "API · checking"
          : describeApiStatus(status);
  const checked = lastCheckedAt ? new Date(lastCheckedAt).toLocaleTimeString() : "never";
  return (
    <button
      type="button"
      onClick={() => void pingHealth(true)}
      title={`Last checked ${checked} · click to recheck`}
      aria-label={`${label}. Last checked ${checked}. Click to recheck.`}
      className="focus-ring rounded-full"
    >
      <StatusPill status={tone}>{label}</StatusPill>
    </button>
  );
}

function SignedOut() {
  const { auth, signIn, signInPreview } = useSession();
  const isStarting = auth.status === "starting";
  return (
    <div className="mx-auto max-w-md px-4 py-20 text-center">
      <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-mint/50 bg-mint/10 px-3 py-1 font-mono text-token-2xs uppercase tracking-wider text-foreground">
        <TerminalSquare className="size-3" />
        GitHub OAuth
      </div>
      <h1 className="font-display text-token-2xl font-semibold tracking-tight">
        Sign in to Gittensory
      </h1>
      <p className="mt-2 text-token-sm text-muted-foreground">
        Sign in with GitHub to use the live API-backed app surfaces.
      </p>
      <div className="mt-6 rounded-token border border-border bg-transparent p-5 text-left">
        <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
          GitHub browser OAuth
        </div>
        <button
          type="button"
          onClick={() => void signIn()}
          disabled={isStarting}
          className="mt-2 inline-flex min-w-0 w-full items-center justify-center gap-2 rounded-token bg-primary px-4 py-2 text-center text-token-xs font-semibold text-primary-foreground transition-all duration-150 hover:bg-primary/90 focus-ring motion-reduce:transition-none motion-reduce:active:scale-100 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isStarting ? (
            <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <ExternalLink className="size-3.5" />
          )}
          {isStarting ? "Starting sign-in…" : "Sign in with GitHub"}
        </button>
        {auth.status === "error" && (
          <p className="mt-3 rounded-token border border-danger/40 bg-danger/10 px-3 py-2 text-token-xs text-danger">
            {auth.message}
          </p>
        )}
        {import.meta.env.DEV && (
          <>
            <div className="mt-4 font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
              Local dev only
            </div>
            <button
              type="button"
              onClick={signInPreview}
              className="mt-2 inline-flex min-w-0 w-full items-center justify-center rounded-token bg-primary px-4 py-2 text-center text-token-xs font-semibold text-primary-foreground transition-all duration-150 hover:bg-primary/90 focus-ring motion-reduce:transition-none motion-reduce:active:scale-100 active:scale-[0.98]"
            >
              Continue with local preview
            </button>
          </>
        )}
        <p className="mt-3 text-token-2xs text-muted-foreground">
          No GitHub PAT is collected by the browser. The app uses an HttpOnly Gittensory session
          cookie issued after GitHub OAuth.
        </p>
      </div>
    </div>
  );
}
