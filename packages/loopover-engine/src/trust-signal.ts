// Shared cross-system trust-signal vocabulary (#6302). A minimal, additive type that ORB's review-history
// reputation (src/review/submitter-reputation.ts) and AMS's track-record summary (track-record-summary.ts) can
// both converge toward once #6208's reputation-bridge design resolves identity-linkage / data-path / weighting.
//
// SCOPE: this is a TYPE-ONLY definition — no runtime helper, no validation, no populate/consume logic, and it is
// deliberately NOT wired into any real call site. #6208 owns how the signal is produced and read; #6246 (the
// track-record read-API groundwork) is a natural consumer. Every field here is one BOTH existing systems can
// already populate from public outcomes, so neither side has to invent a shape mid-implementation. It carries no
// score / ranking / reward fields — only a coarse bucket plus provenance.

/** How trustworthy a contributor's public history looks, as a coarse three-way bucket. Mirrors ORB's
 *  `ReputationSignal` ("low" | "neutral" | "trusted") so that side maps 1:1; AMS can bucket its merge-rate /
 *  incident summary onto the same three values. `"neutral"` is the safe default when the sample is thin. */
export type TrustLevel = "low" | "neutral" | "trusted";

/** Which system produced the signal, so a consumer can weigh provenance without assuming identity-linkage. */
export type TrustSignalSource = "orb-review-history" | "ams-track-record";

/** A minimal, shared trust signal both ORB and AMS can populate. Additive shared vocabulary only — this type is
 *  not read or written by any current call site (see the file header); it exists so #6208's eventual reputation
 *  bridge has a ready shape to converge both systems' internal representations toward. */
export interface TrustSignal {
  /** Coarse trust bucket. */
  level: TrustLevel;
  /** How many public outcomes backed the level — ORB's recent-window sample, or AMS's merge-rate denominator.
   *  A larger sample means the level is better supported; `0` means "no evidence, treat as neutral". */
  sampleSize: number;
  /** Which system computed the signal. */
  source: TrustSignalSource;
  /** ISO-8601 timestamp of the data the signal was computed from, so a consumer can reason about staleness. */
  asOf: string;
}
