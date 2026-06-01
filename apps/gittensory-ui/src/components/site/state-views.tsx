import { Loader2, Inbox, AlertTriangle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { notifyApiFailure } from "@/lib/api/request";

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
        <div className="max-w-prose text-token-sm text-muted-foreground">{description}</div>
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
  title = "Couldn't load this",
  description = "Something went wrong fetching this data. You can retry, or come back in a moment. If this keeps happening, check status or try again shortly.",
  onRetry,
  retryLabel = "Try again",
  secondaryAction,
  toastOnRetry = true,
  className,
}: {
  title?: string;
  description?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  secondaryAction?: ReactNode;
  toastOnRetry?: boolean;
  className?: string;
}) {
  return (
    <Shell
      role="alert"
      icon={<AlertTriangle className="size-5 text-warning" aria-hidden />}
      title={title}
      description={description}
      action={
        onRetry && (
          <StateActionButton
            onClick={() => {
              if (toastOnRetry) {
                toast("Retrying…", {
                  description: "We’ll request the data again and keep this view in place.",
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

export function usePreviewDataState(label: string, delay = 220) {
  const [version, setVersion] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    setIsLoading(true);
    const timer = window.setTimeout(() => setIsLoading(false), delay);
    return () => window.clearTimeout(timer);
  }, [delay, version]);

  const refresh = useCallback(() => {
    toast("Refreshing preview data", {
      description: `${label} will reload with the latest available domain data.`,
    });
    setVersion((current) => current + 1);
  }, [label]);

  const retry = useCallback(() => {
    toast("Retrying data request", {
      description: `We’re requesting ${label.toLowerCase()} again now.`,
    });
    setVersion((current) => current + 1);
  }, [label]);

  return { isLoading, refresh, retry };
}

export function StateBoundary({
  isLoading,
  isError,
  isEmpty,
  loadingTitle = "Loading data…",
  loadingDescription = "Fetching the latest available signals for this view.",
  emptyTitle = "No data available yet",
  emptyDescription = "This view has no records to show. Refresh when the source data is available.",
  errorTitle = "Couldn't load data",
  errorDescription = "The data source did not respond. Retry the request, or check back once the service has recovered.",
  onRetry,
  onRefresh,
  errorLabel,
  children,
}: {
  isLoading?: boolean;
  isError?: boolean;
  isEmpty?: boolean;
  loadingTitle?: string;
  loadingDescription?: ReactNode;
  emptyTitle?: string;
  emptyDescription?: ReactNode;
  errorTitle?: string;
  errorDescription?: ReactNode;
  onRetry?: () => void;
  onRefresh?: () => void;
  /** When provided, surfaces a global API-failure toast with a Retry action. */
  errorLabel?: string;
  children: ReactNode;
}) {
  // When this boundary flips into the error state, surface a toast with Retry.
  useEffect(() => {
    if (isError && errorLabel) {
      notifyApiFailure({
        label: errorLabel,
        kind: "network",
        message:
          typeof errorDescription === "string" ? errorDescription : "Data source did not respond.",
        retry: onRetry,
      });
    }
  }, [isError, errorLabel, errorDescription, onRetry]);

  if (isLoading) {
    return <LoadingState title={loadingTitle} description={loadingDescription} />;
  }

  if (isError) {
    return (
      <ErrorState
        title={errorTitle}
        description={errorDescription}
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
