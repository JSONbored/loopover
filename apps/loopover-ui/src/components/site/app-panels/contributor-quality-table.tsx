import { BoundaryBadge, StatusPill } from "@/components/site/control-primitives";
import { TableScroll } from "@/components/site/data-table";
import { EmptyState } from "@/components/site/state-views";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
        <TableScroll className="mt-4" label="Top contributors by quality band">
          <Table className="min-w-[420px] whitespace-nowrap text-left text-token-sm">
            <TableCaption className="sr-only">
              Contributors with their quality band and open pull request count.
            </TableCaption>
            <TableHeader>
              <TableRow className="border-b-hairline font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                <TableHead scope="col" className="py-2 pr-3 font-normal">
                  Contributor
                </TableHead>
                <TableHead scope="col" className="py-2 pr-3 font-normal">
                  Band
                </TableHead>
                <TableHead scope="col" className="py-2 font-normal">
                  Open PRs
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {topContributors.map((contributor) => (
                <TableRow
                  key={contributor.login}
                  className="border-b-hairline last:border-b-0 transition-colors hover:bg-muted/40"
                >
                  <TableCell className="py-2 pr-3 font-medium text-foreground">
                    {contributor.login}
                  </TableCell>
                  <TableCell className="py-2 pr-3">
                    <StatusPill status={QUALITY_BAND_TONE[contributor.band] ?? "info"}>
                      {contributor.band}
                    </StatusPill>
                  </TableCell>
                  <TableCell className="py-2 font-mono text-token-xs text-muted-foreground">
                    {contributor.openPrCount}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableScroll>
      )}
    </section>
  );
}
