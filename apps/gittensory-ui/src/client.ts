import * as React from "react";
import { StartClient } from "@tanstack/react-start/client";
import { hydrateRoot } from "react-dom/client";

React.startTransition(() => {
  hydrateRoot(
    document,
    React.createElement(React.StrictMode, null, React.createElement(StartClient)),
  );
});
