import * as React from "react";
import { StartClient } from "@tanstack/react-start/client";
import { hydrateRoot } from "react-dom/client";

React.startTransition(() => {
  hydrateRoot(
    document,
    React.createElement(React.StrictMode, null, React.createElement(StartClient)),
  );
});

if ("serviceWorker" in navigator && window.isSecureContext) {
  void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
}
