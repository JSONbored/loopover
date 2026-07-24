// Runs once per test file (Vitest's setupFiles, distinct from globalSetup which runs once for the
// whole run in the main process — this needs to touch each file's own module registry). Defaults
// production retry/backoff delays that exist for real network-timing reasons to near-zero so a test
// whose stub incidentally triggers one (e.g. an empty-files fetch stub tripping
// fetchAndStorePullRequestFilesForReview's empty-retry) doesn't pay real wall-clock time for it
// (#test-hotspots). The delay CONSTANT and its production default are untouched — this only sets the
// `...ForTest` override every such helper already exposes; a dedicated test asserting the retry's own
// behavior (attempt count, precedence) still exercises the identical code path, just without the sleep.
import { setReviewFilesEmptyRetryDelayMsForTest } from "../../src/github/backfill";
import { setGithubRateLimitRetrySleepCapMsForTest } from "../../src/github/client";
import { setMergeStateUnknownRetryDelayMsForTest } from "../../src/queue/ci-resolution";

setReviewFilesEmptyRetryDelayMsForTest(0);
setGithubRateLimitRetrySleepCapMsForTest(0);
setMergeStateUnknownRetryDelayMsForTest(0);
