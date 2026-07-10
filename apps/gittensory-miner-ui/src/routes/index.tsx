import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: IndexPage,
});

export function IndexPage() {
  return (
    <section className="rounded-xl border border-white/10 bg-white/5 p-6">
      <h2 className="text-xl font-semibold">Dashboard shell ready</h2>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-white/70">
        This package is the empty Phase 6 scaffold for a local, read-only miner dashboard. Run-history and portfolio
        views will mount here in follow-up issues once the local data-access layer is wired.
      </p>
    </section>
  );
}
