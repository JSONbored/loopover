import { BoundaryBadge, StatusPill } from "@/components/site/control-primitives";
import { EmptyState } from "@/components/site/state-views";
import {
  QUALITY_BAND_TONE,
  type MaintainerTopContributor,
} from "@/components/site/app-panels/contributor-quality-table-model";

/**
 * Top-contributors-by-quality-band table (#2204, part of #539): a single, read-only slice of the
 * maintainer quality dashboard listing each contributor's login, quality band, and open PR count.
 * Renders the band only — never the raw clean-ratio/credibility number it's derived from.
 */
export function ContributorQualityTable({
  topContributors,
}: {
  topContributors: MaintainerTopContributor[];
}) {
  return (
    <section className="rounded-token border-hairline bg-card p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-token-lg font-semibold">
          Top contributors by quality band
        </h2>
        <BoundaryBadge boundary="public" />
      </div>
      {topContributors.length === 0 ? (
        <EmptyState
          className="mt-4"
          title="No contributor quality data yet"
          description="Quality bands appear once this maintainer's repos have cached open pull requests to shape."
        />
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[420px] text-left text-token-sm">
            <thead>
              <tr className="border-b-hairline font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                <th className="py-2 pr-3 font-normal">Contributor</th>
                <th className="py-2 pr-3 font-normal">Band</th>
                <th className="py-2 font-normal">Open PRs</th>
              </tr>
            </thead>
            <tbody>
              {topContributors.map((contributor) => (
                <tr
                  key={contributor.login}
                  className="border-b-hairline last:border-b-0 transition-colors hover:bg-muted/40"
                >
                  <td className="py-2 pr-3 font-medium text-foreground">{contributor.login}</td>
                  <td className="py-2 pr-3">
                    <StatusPill status={QUALITY_BAND_TONE[contributor.band] ?? "info"}>
                      {contributor.band}
                    </StatusPill>
                  </td>
                  <td className="py-2 font-mono text-token-xs text-muted-foreground">
                    {contributor.openPrCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
