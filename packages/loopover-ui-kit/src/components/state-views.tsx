import {
  Loader2,
  Inbox,
  AlertTriangle,
  RefreshCw,
  WifiOff,
} from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { toast } from "sonner";

import { cn } from "../utils";

export type ApiFailureKind = "timeout" | "network" | "http";

/** `errorKind`s that mean "we never reached the server" as opposed to "the server answered with an
 *  error" — StateBoundary/ErrorState use this to show connectivity-specific copy and iconography (#793). */
const NETWORK_ERROR_KINDS: ReadonlySet<ApiFailureKind> = new Set([
  "network",
  "timeout",
]);

/**
 * Shared state primitives so every panel/route renders a consistent
 * loading / empty / error surface. All animations respect prefers-reduced-motion.
 */

export function Spinner({ className }: { className?: string }) {
  return (
    <Loader2
      aria-hidden
      className={cn(
        "size-4 animate-spin text-muted-foreground motion-reduce:animate-none",
        className,
      )}
    />
  );
}

function Shell({
  icon,
  title,
  description,
  action,
  secondaryAction,
  className,
  role,
}: {
  icon: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  secondaryAction?: ReactNode;
  className?: string;
  role?: "status" | "alert";
}) {
  return (
    <div
      role={role}
      aria-live={role === "status" ? "polite" : undefined}
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-token border border-dashed border-border bg-transparent px-6 py-10 text-center",
        className,
      )}
    >
      <div className="text-muted-foreground">{icon}</div>
      <div className="text-token-sm font-medium text-foreground">{title}</div>
      {description && (
        <div className="max-w-prose text-token-sm text-muted-foreground">
          {description}
        </div>
      )}
      {(action || secondaryAction) && (
        <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
          {action}
          {secondaryAction}
        </div>
      )}
    </div>
  );
}

export function LoadingState({
  title = "Loading…",
  description,
  className,
}: {
  title?: string;
  description?: ReactNode;
  className?: string;
}) {
  return (
    <Shell
      role="status"
      icon={<Spinner className="size-5" />}
      title={title}
      description={description}
      className={className}
    />
  );
}

export function EmptyState({
  title = "Nothing here yet",
  description,
  action,
  secondaryAction,
  className,
}: {
  title?: string;
  description?: ReactNode;
  action?: ReactNode;
  secondaryAction?: ReactNode;
  className?: string;
}) {
  return (
    <Shell
      icon={<Inbox className="size-5" aria-hidden />}
      title={title}
      description={description}
      action={action}
      secondaryAction={secondaryAction}
      className={className}
    />
  );
}

export function StateActionButton({
  children,
  onClick,
  disabled,
  icon,
  variant = "outline",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  icon?: ReactNode;
  variant?: "outline" | "primary";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex min-h-8 min-w-0 items-center justify-center gap-1.5 rounded-token px-3 py-1.5 text-center text-token-xs font-medium leading-token-snug transition-all duration-150 focus-ring motion-reduce:transition-none motion-reduce:active:scale-100 active:scale-[0.98] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-60",
        variant === "primary"
          ? "bg-primary text-primary-foreground hover:bg-primary/90"
          : "border border-border bg-transparent text-foreground hover:border-strong hover:bg-accent",
      )}
    >
      {icon}
      <span className="min-w-0 break-words">{children}</span>
    </button>
  );
}

export function ErrorState({
  title,
  description,
  errorKind,
  onRetry,
  retryLabel = "Try again",
  secondaryAction,
  toastOnRetry = true,
  className,
}: {
  title?: string;
  description?: ReactNode;
  /** Distinguishes "couldn't reach the server at all" from "the server answered with an error" (#793).
   *  Only changes the default `title`/`description` — an explicit `title`/`description` always wins. */
  errorKind?: ApiFailureKind;
  onRetry?: () => void;
  retryLabel?: string;
  secondaryAction?: ReactNode;
  toastOnRetry?: boolean;
  className?: string;
}) {
  const isNetworkIssue =
    errorKind !== undefined && NETWORK_ERROR_KINDS.has(errorKind);
  const resolvedTitle =
    title ?? (isNetworkIssue ? "Can't reach the server" : "Couldn't load this");
  const resolvedDescription =
    description ??
    (isNetworkIssue
      ? "We couldn't reach the API — check your connection and retry. This is a connectivity issue, not a problem with the data itself."
      : "Something went wrong fetching this data. You can retry, or come back in a moment. If this keeps happening, check status or try again shortly.");
  return (
    <Shell
      role="alert"
      icon={
        isNetworkIssue ? (
          <WifiOff className="size-5 text-warning" aria-hidden />
        ) : (
          <AlertTriangle className="size-5 text-warning" aria-hidden />
        )
      }
      title={resolvedTitle}
      description={resolvedDescription}
      action={
        onRetry && (
          <StateActionButton
            onClick={() => {
              if (toastOnRetry) {
                toast("Retrying…", {
                  description:
                    "We’ll request the data again and keep this view in place.",
                });
              }
              onRetry();
            }}
            icon={<RefreshCw className="size-3 shrink-0" aria-hidden />}
          >
            {retryLabel}
          </StateActionButton>
        )
      }
      secondaryAction={secondaryAction}
      className={className}
    />
  );
}

export function StateBoundary({
  isLoading,
  isError,
  isEmpty,
  loadingTitle = "Loading data…",
  loadingDescription = "Fetching the latest available signals for this view.",
  loadingSkeleton,
  emptyTitle = "No data available yet",
  emptyDescription = "This view has no records to show. Refresh when the source data is available.",
  errorTitle,
  errorDescription,
  errorKind,
  onRetry,
  onRefresh,
  errorLabel,
  onFailureNotify,
  children,
}: {
  isLoading?: boolean;
  isError?: boolean;
  isEmpty?: boolean;
  loadingTitle?: string;
  loadingDescription?: ReactNode;
  /** Content-shaped placeholder (build with `@/components/ui/skeleton`) shown instead of the generic
   *  spinner while loading, so the layout doesn't jump once data arrives (#793). */
  loadingSkeleton?: ReactNode;
  emptyTitle?: string;
  emptyDescription?: ReactNode;
  errorTitle?: string;
  errorDescription?: ReactNode;
  /** Distinguishes "couldn't reach the server at all" from "the server answered with an error" (#793). */
  errorKind?: ApiFailureKind;
  onRetry?: () => void;
  onRefresh?: () => void;
  /** When provided, surfaces a global API-failure toast with a Retry action. */
  errorLabel?: string;
  /** Invoked when `isError && errorLabel` -- callers wire this to their own API-status singleton (e.g.
   *  a `notifyApiFailure`); no-ops when omitted. Kept optional and generic so this package never
   *  depends on an app-local module. */
  onFailureNotify?: (args: {
    label: string;
    kind: ApiFailureKind;
    message: string;
    retry?: () => void;
  }) => void;
  children: ReactNode;
}) {
  const isNetworkIssue =
    errorKind !== undefined && NETWORK_ERROR_KINDS.has(errorKind);
  // Preserve the pre-#793 defaults exactly when no errorKind is given; when one is given and the caller
  // didn't override the copy, fall through to ErrorState's own network-aware defaults instead.
  const resolvedErrorTitle =
    errorTitle ?? (isNetworkIssue ? undefined : "Couldn't load data");
  const resolvedErrorDescription =
    errorDescription ??
    (isNetworkIssue
      ? undefined
      : "The data source did not respond. Retry the request, or check back once the service has recovered.");

  // When this boundary flips into the error state, surface a toast with Retry.
  // Edge-triggered (#7436): only fire on false→true of (isError && errorLabel). Level-triggering here
  // re-notified on every re-render while already errored because app wrappers pass a fresh
  // `onFailureNotify` arrow each render (see apps/loopover-ui site/state-views.tsx). Mirrors the
  // wasError-ref pattern used by mcp-version-badge for transition detection.
  const wasFailureNotifyActive = useRef(false);
  useEffect(() => {
    const failureNotifyActive = Boolean(isError && errorLabel);
    if (isError && errorLabel && !wasFailureNotifyActive.current) {
      onFailureNotify?.({
        label: errorLabel,
        kind: errorKind ?? "network",
        message:
          typeof resolvedErrorDescription === "string"
            ? resolvedErrorDescription
            : "Data source did not respond.",
        retry: onRetry,
      });
    }
    wasFailureNotifyActive.current = failureNotifyActive;
  }, [
    isError,
    errorLabel,
    errorKind,
    resolvedErrorDescription,
    onRetry,
    onFailureNotify,
  ]);

  if (isLoading) {
    return (
      loadingSkeleton ?? (
        <LoadingState title={loadingTitle} description={loadingDescription} />
      )
    );
  }

  if (isError) {
    return (
      <ErrorState
        title={resolvedErrorTitle}
        description={resolvedErrorDescription}
        errorKind={errorKind}
        onRetry={onRetry}
        toastOnRetry={false}
        secondaryAction={
          onRefresh ? (
            <StateActionButton
              onClick={onRefresh}
              icon={<RefreshCw className="size-3 shrink-0" aria-hidden />}
            >
              Refresh
            </StateActionButton>
          ) : undefined
        }
      />
    );
  }

  if (isEmpty) {
    return (
      <EmptyState
        title={emptyTitle}
        description={emptyDescription}
        action={
          onRefresh ? (
            <StateActionButton
              onClick={onRefresh}
              icon={<RefreshCw className="size-3 shrink-0" aria-hidden />}
            >
              Refresh
            </StateActionButton>
          ) : undefined
        }
      />
    );
  }

  return <>{children}</>;
}
