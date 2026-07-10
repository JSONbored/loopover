import type { Status } from "@/components/site/control-primitives";

// UI-side mirror of MaintainerTopContributor (src/services/maintainer-quality-dashboard.ts), delivered on
// the /v1/app/maintainer-dashboard payload's qualityDashboard.topContributors (#2204, part of #539). `band`
// is a plain string, not the narrower server-side union, because it crosses the API boundary the same way
// reviewability's `bucket` / `slop.band` fields do elsewhere in this panel: an unrecognized value degrades
// to a neutral pill instead of a type error. Only a BAND and an observable open-PR count are modeled here —
// never a raw clean-ratio/credibility number (see the boundary rule in maintainer-quality-dashboard.ts).
export type MaintainerTopContributor = {
  login: string;
  band: string;
  openPrCount: number;
};

// Deterministic quality band -> pill tone. Unrecognized bands fall back to the neutral "info" tone rather
// than throwing, mirroring maintainer-panel.tsx's BUCKET_TONE/SLOP_BAND_TONE maps.
export const QUALITY_BAND_TONE: Record<string, Status> = {
  strong: "ready",
  developing: "info",
  early: "warn",
};
