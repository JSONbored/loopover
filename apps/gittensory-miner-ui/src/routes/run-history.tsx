import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { fetchRunStates, type RunHistoryResult, type RunStateRow } from "../lib/run-history";

export const Route = createFileRoute("/run-history")({
  component: RunHistoryPage,
});

// Read-only run-history table (#4305): one row per repo from the local `miner_run_state` store (repo, state,
// last-updated), served by the dev server's local API. No writes, no new state — a fresh install renders the
// empty state, an unreachable API renders an error message.

const STATE_BADGE_CLASSES: Record<RunStateRow["state"], string> = {
  idle: "bg-white/10 text-white/70",
  discovering: "bg-sky-500/20 text-sky-200",
  planning: "bg-amber-500/20 text-amber-200",
  preparing: "bg-emerald-500/20 text-emerald-200",
};

export function RunHistoryView({ result }: { result: RunHistoryResult | null }) {
  if (result === null) {
    return <p className="text-sm text-white/60">Loading local run state…</p>;
  }
  if (!result.ok) {
    return (
      <p role="alert" className="text-sm text-rose-300">
        Could not read local run state: {result.error}
      </p>
    );
  }
  if (result.rows.length === 0) {
    return (
      <p className="text-sm text-white/60">
        No local run state yet — the table fills in once the miner records its first repo run.
      </p>
    );
  }
  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="border-b border-white/10 text-xs uppercase tracking-wider text-white/50">
          <th scope="col" className="py-2 pr-4">
            Repository
          </th>
          <th scope="col" className="py-2 pr-4">
            State
          </th>
          <th scope="col" className="py-2">
            Last updated
          </th>
        </tr>
      </thead>
      <tbody>
        {result.rows.map((row) => (
          <tr key={row.repoFullName} className="border-b border-white/5">
            <td className="py-2 pr-4 font-mono text-white/90">{row.repoFullName}</td>
            <td className="py-2 pr-4">
              <span className={`rounded-full px-2 py-0.5 text-xs ${STATE_BADGE_CLASSES[row.state]}`}>{row.state}</span>
            </td>
            <td className="py-2 text-white/70">{row.updatedAt}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function RunHistoryPage({
  loadRunStates = fetchRunStates,
}: {
  loadRunStates?: () => Promise<RunHistoryResult>;
}) {
  const [result, setResult] = useState<RunHistoryResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadRunStates().then((loaded) => {
      if (!cancelled) setResult(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [loadRunStates]);

  return (
    <section className="rounded-xl border border-white/10 bg-white/5 p-6">
      <h2 className="text-xl font-semibold">Run history</h2>
      <p className="mt-1 text-sm text-white/60">
        Local, read-only view over the miner&apos;s per-repo run state (`miner_run_state`).
      </p>
      <div className="mt-4">
        <RunHistoryView result={result} />
      </div>
    </section>
  );
}
