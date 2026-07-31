import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, useRef, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { captureBrowserError } from "../lib/browser-sentry";
import { initAnalytics, capturePageview } from "../lib/analytics";
import { SiteHeader } from "@/components/site/site-header";
import { SiteFooter } from "@/components/site/site-footer";
import { BackToTop } from "@/components/site/back-to-top";
import { Toaster } from "@/components/ui/sonner";
import { ApiProgressBar } from "@/components/site/api-progress-bar";
import { ApiStatusBanner } from "@/components/site/api-status-banner";
import { useApiStatus } from "@/lib/api/status";
import { toast } from "sonner";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-token-3xl font-medium text-foreground">404</h1>
        <h2 className="mt-4 text-token-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-token-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-token bg-primary px-4 py-2 text-token-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
    captureBrowserError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-token-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-token-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-token bg-primary px-4 py-2 text-token-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-token border border-input bg-background px-4 py-2 text-token-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "LoopOver — The loop never sleeps. You finally can." },
      {
        name: "description",
        content:
          "Agents automate the entire development lifecycle — write, review, merge, learn — end to end, with a published safety record. Any GitHub repo.",
      },
      { property: "og:site_name", content: "LoopOver" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "theme-color", content: "#0e100d" },
    ],
    links: [
      { rel: "icon", href: "/favicon.ico", sizes: "any" },
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
      { rel: "stylesheet", href: appCss },
      {
        rel: "preconnect",
        href: "https://fonts.googleapis.com",
      },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap",
      },
    ],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "Organization",
          name: "LoopOver",
          url: "https://loopover.ai",
          description:
            "Agents automate the entire development lifecycle — write, review, merge, learn — end to end, with a published safety record.",
        }),
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark" style={{ colorScheme: "dark" }}>
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen bg-background text-foreground antialiased">
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const router = useRouter();

  // PostHog web analytics (#8293). `capture_pageview` is disabled in
  // lib/analytics.ts's own init call -- an SPA's auto-pageview only ever
  // covers the very first load -- so every pageview, including this initial
  // one, is captured explicitly here: once on mount, then once per navigation
  // whose URL actually changed. `onResolved` also fires when a route
  // re-resolves without navigating (e.g. after `router.invalidate()`), which
  // is not a new pageview, hence the `hrefChanged` guard.
  useEffect(() => {
    initAnalytics();
    capturePageview(window.location.href);
    return router.subscribe("onResolved", (event) => {
      if (!event.hrefChanged) return;
      capturePageview(window.location.href);
    });
  }, [router]);

  return (
    <QueryClientProvider client={queryClient}>
      <div className="relative flex min-h-screen flex-col">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-token focus:bg-foreground focus:px-3 focus:py-2 focus:text-token-xs focus:font-medium focus:text-background focus-ring"
        >
          Skip to content
        </a>
        <SiteHeader />
        <ApiStatusBanner />
        <ApiProgressBar />
        <main id="main-content" className="flex-1">
          <Outlet />
        </main>
        <SiteFooter />
        <BackToTop />
        <OfflineToastWatcher />
        <Toaster richColors closeButton position="bottom-right" />
      </div>
    </QueryClientProvider>
  );
}

function OfflineToastWatcher() {
  const { connection } = useApiStatus();
  const prev = useRef(connection);
  useEffect(() => {
    if (prev.current === connection) return; // skip mount toast
    const wasOffline = prev.current === "offline";
    prev.current = connection;
    if (connection === "offline") {
      toast.error("You're offline", {
        id: "offline",
        description: "Live API actions are paused until your connection returns.",
        duration: Infinity,
      });
    } else if (wasOffline) {
      toast.success("Back online", {
        id: "offline",
        description: "Re-checking API status now.",
        duration: 2500,
      });
    }
  }, [connection]);
  return null;
}
