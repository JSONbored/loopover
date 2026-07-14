import { Bell, BellOff } from "lucide-react";
import { useMemo, useState } from "react";

import { StatusPill } from "./control-primitives";
import { useApiResource } from "@/lib/api/use-api-resource";
import { useLocalStorage } from "@/lib/use-local-storage";

type NotificationModelResponse = {
  notificationModel: {
    mode: "opt_in";
    defaultState: "disabled";
    channels: Array<{
      id: string;
      transport: "in_app" | "web_push";
      defaultEnabled: boolean;
      requiresPermission?: boolean;
      purpose: string;
    }>;
    privacyGuards: string[];
    fallbackWhenUnavailable: string;
  };
  pwa: { nativeDependency: boolean; manifestPath: string; serviceWorkerPath: string };
  mobileReadyRoutes: string[];
  nativeMobileFuture: string[];
};

export function NotificationReadinessCard() {
  const model = useApiResource<NotificationModelResponse>(
    "/v1/app/notification-model",
    "Notification model",
  );
  const [optIn, setOptIn] = useLocalStorage<boolean>(
    "loopover_notification_opt_in",
    false,
    "loopover_notification_opt_in",
  );
  const [busy, setBusy] = useState(false);

  const permission = typeof Notification === "undefined" ? "unsupported" : Notification.permission;
  const canAskPermission = permission !== "unsupported" && permission !== "granted";
  const pushChannel = useMemo(
    () =>
      model.status === "ready"
        ? model.data.notificationModel.channels.find((channel) => channel.id === "browser_push")
        : null,
    [model],
  );

  async function enableNotifications() {
    if (!canAskPermission || busy) return;
    setBusy(true);
    try {
      const result = await Notification.requestPermission();
      if (result === "granted") setOptIn(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-token border border-border bg-transparent p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-token-lg font-semibold">Notification readiness</h2>
        <StatusPill status={optIn ? "ready" : "warn"}>
          {optIn ? "opt-in enabled" : "opt-in required"}
        </StatusPill>
      </div>
      {model.status === "ready" ? (
        <div className="mt-3 space-y-3 text-token-sm">
          <p className="text-muted-foreground">
            Delivery mode is <strong>{model.data.notificationModel.mode}</strong> and defaults to{" "}
            <strong>{model.data.notificationModel.defaultState}</strong>.
          </p>
          <ul className="space-y-1 text-foreground/90">
            {model.data.notificationModel.channels.map((channel) => (
              <li key={channel.id}>
                · {channel.id}: {channel.purpose}
              </li>
            ))}
          </ul>
          <p className="text-token-xs text-muted-foreground">
            Fallback: {model.data.notificationModel.fallbackWhenUnavailable}. Native app dependency:{" "}
            {model.data.pwa.nativeDependency ? "yes" : "no"}.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void enableNotifications()}
              disabled={!canAskPermission || busy}
              className="inline-flex items-center gap-2 rounded-token border border-border px-3 py-1.5 text-token-xs text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Bell className="size-3.5" />
              Enable browser notifications
            </button>
            <button
              type="button"
              onClick={() => setOptIn(false)}
              className="inline-flex items-center gap-2 rounded-token border border-border px-3 py-1.5 text-token-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
            >
              <BellOff className="size-3.5" />
              Disable on this device
            </button>
            {pushChannel?.requiresPermission ? (
              <span className="text-token-2xs text-muted-foreground">
                Browser permission: {permission}
              </span>
            ) : null}
          </div>
          <ul className="space-y-1 text-token-xs text-muted-foreground">
            {model.data.notificationModel.privacyGuards.map((guard) => (
              <li key={guard}>· {guard}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-3 text-token-sm text-muted-foreground">
          {model.status === "loading"
            ? "Loading notification model…"
            : "Notification model unavailable."}
        </p>
      )}
    </section>
  );
}
