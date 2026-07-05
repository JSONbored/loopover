# Predicted Gate Parity Fixtures

These fixtures are the scenario corpus for [issue #2285](https://github.com/JSONbored/gittensory/issues/2285).
Each file exports one complete, self-contained `buildPredictedGateVerdict` input plus the expected high-level
surface it should produce today. The follow-up parity runner can reuse the same inputs to snapshot full outputs.

| Fixture | Scenario / branch | Expected conclusion | Expected finding codes |
| --- | --- | --- | --- |
| `clean-pass-gittensor.ts` | Clean pass under the default `gittensor` pack | `success` | none |
| `clean-pass-oss-anti-slop.ts` | Clean pass under `oss-anti-slop`, including the public funnel | `success` | none |
| `duplicate-pr-block.ts` | Open sibling PR sharing the linked issue | `failure` | `duplicate_pr_risk` |
| `missing-linked-issue-block.ts` | `linkedIssue:block` with no linked issue in the body or metadata | `failure` | `missing_linked_issue` |
| `manifest-blocked-path.ts` | Legacy `blockedPaths` with `manifestPolicy:block` are ignored | `success` | none |
| `readiness-warning.ts` | `gate.readiness.mode=advisory` with a threshold above the public readiness score | `success` | `readiness_score_below_threshold` |
| `path-gated-check-with-paths.ts` | Enforced `review.pre_merge_checks` rule once matching `changedPaths` are supplied | `failure` | `pre_merge_check_required` |
| `path-gated-check-without-paths.ts` | The same path-gated pre-merge rule before `changedPaths` are known | `success` | none |
