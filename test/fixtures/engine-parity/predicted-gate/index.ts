import aiReviewGateModeInert from "./ai-review-gate-mode-inert";
import claGateModeInert from "./cla-gate-mode-inert";
import cleanPassGittensor from "./clean-pass-gittensor";
import cleanPassOssAntiSlop from "./clean-pass-oss-anti-slop";
import firstTimeGraceInert from "./first-time-grace-inert";
import guardrailHold from "./guardrail-hold";
import mergeReadinessCompositeBlock from "./merge-readiness-composite-block";
import selfAuthoredLinkedIssueBlock from "./self-authored-linked-issue-block";
import duplicatePrBlock from "./duplicate-pr-block";
import manifestBlockedPath from "./manifest-blocked-path";
import missingLinkedIssueBlock from "./missing-linked-issue-block";
import pathGatedCheckWithPaths from "./path-gated-check-with-paths";
import pathGatedCheckWithoutPaths from "./path-gated-check-without-paths";
import readinessWarning from "./readiness-warning";

export type { PredictedGateFixture } from "./_shared";

export const predictedGateFixtures = [
  cleanPassGittensor,
  cleanPassOssAntiSlop,
  duplicatePrBlock,
  missingLinkedIssueBlock,
  manifestBlockedPath,
  readinessWarning,
  pathGatedCheckWithPaths,
  pathGatedCheckWithoutPaths,
  selfAuthoredLinkedIssueBlock,
  guardrailHold,
  mergeReadinessCompositeBlock,
  claGateModeInert,
  aiReviewGateModeInert,
  firstTimeGraceInert,
];
