import { Outlet, createRootRoute, Link } from "@tanstack/react-router";

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  return (
    <div className="min-h-screen">
      <header className="border-b border-white/10 px-6 py-4">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4">
          <div>
            <p className="text-sm uppercase tracking-[0.2em] text-emerald-300/80">Gittensory Miner</p>
            <h1 className="text-lg font-semibold">Local dashboard shell</h1>
          </div>
          <nav className="flex gap-4 text-sm text-white/70">
            <Link to="/" className="hover:text-white">
              Overview
            </Link>
            <Link to="/run-history" className="hover:text-white">
              Run history
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}
