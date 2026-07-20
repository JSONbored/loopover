import { createFileRoute, Outlet } from "@tanstack/react-router";

// Layout for the self-serve install flow (part of #4802). `/install` is the signup->install->confirm
// entry (install.index.tsx); `/install/permissions` is the scoped-permissions confirmation step. This
// route only provides the shared outlet so those sibling pages render under the /install path -- it
// holds no content of its own and reads no secrets.
export const Route = createFileRoute("/install")({
  component: InstallLayout,
});

export function InstallLayout() {
  return <Outlet />;
}
