# Changelog

## [3.8.0](https://github.com/JSONbored/loopover/compare/miner-v3.7.0...miner-v3.8.0) (2026-07-23)


### Features

* **miner:** wire the Neon branch-per-attempt DB fork into runAttempt ([#8206](https://github.com/JSONbored/loopover/issues/8206)) ([c26fe94](https://github.com/JSONbored/loopover/commit/c26fe94adfa50454157b7290958b81005ef02326))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @loopover/engine bumped from ^3.7.0 to ^3.8.0

## [3.7.0](https://github.com/JSONbored/loopover/compare/miner-v3.6.0...miner-v3.7.0) (2026-07-23)


### Features

* **engine:** AMS calibration corpus — pair predicted gate verdicts with realized PR outcomes ([#8200](https://github.com/JSONbored/loopover/issues/8200)) ([d40421e](https://github.com/JSONbored/loopover/commit/d40421e226bca36a9c322e1d44826a8f110115f6)), closes [#8183](https://github.com/JSONbored/loopover/issues/8183)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @loopover/engine bumped from ^3.6.0 to ^3.7.0

## [3.6.0](https://github.com/JSONbored/loopover/compare/miner-v3.5.0...miner-v3.6.0) (2026-07-23)


### Chores

* **miner:** Synchronize engine-and-dependents versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @loopover/engine bumped from ^3.5.0 to ^3.6.0

## [3.5.0](https://github.com/JSONbored/loopover/compare/miner-v3.4.0...miner-v3.5.0) (2026-07-23)


### Features

* **calibration:** shared ORB+AMS signal-tracking module, with AMS wired live ([#8079](https://github.com/JSONbored/loopover/issues/8079)) ([873ecf2](https://github.com/JSONbored/loopover/commit/873ecf2cf87e3b43066a6310723d347b001fa48a))
* **governor:** page PagerDuty on kill-switch trips ([#8052](https://github.com/JSONbored/loopover/issues/8052)) ([8329069](https://github.com/JSONbored/loopover/commit/832906916b5a9543c399cc4bd577913aa1a9beb7)), closes [#7666](https://github.com/JSONbored/loopover/issues/7666)
* **miner:** add a dry-run full-execution mode to the cross-repo evaluation harness ([#7668](https://github.com/JSONbored/loopover/issues/7668)) ([b764880](https://github.com/JSONbored/loopover/commit/b764880574944ea935bea8940d8a98852042c88f)), closes [#7634](https://github.com/JSONbored/loopover/issues/7634)
* **miner:** add a hosted-container entry point for AMS cron-wake cycles ([#7182](https://github.com/JSONbored/loopover/issues/7182)) ([#8070](https://github.com/JSONbored/loopover/issues/8070)) ([613e5fb](https://github.com/JSONbored/loopover/commit/613e5fbcfc05c18768e97b0161564bd5e0356a2b))
* **miner:** add a pr-outcomes CLI for the hosted contributor outcome history ([#7998](https://github.com/JSONbored/loopover/issues/7998)) ([24ddd19](https://github.com/JSONbored/loopover/commit/24ddd19fc773a1ed9323821ac2e2287b2133e826))
* **miner:** add AMS hosted-container health HTTP endpoint ([#7177](https://github.com/JSONbored/loopover/issues/7177)) ([#7185](https://github.com/JSONbored/loopover/issues/7185)) ([53527e6](https://github.com/JSONbored/loopover/commit/53527e6fc4f6cc4b218ec054e45d8117b6077dc2))
* **miner:** add tenant create/list/destroy control-plane admin CLI ([#7284](https://github.com/JSONbored/loopover/issues/7284)) ([37ca8a5](https://github.com/JSONbored/loopover/commit/37ca8a5bb8c156ebae34c08b519b85e870e3c228)), closes [#7275](https://github.com/JSONbored/loopover/issues/7275)
* **miner:** migrate policy-doc-cache onto the SqliteDriver store seam ([aa95c0a](https://github.com/JSONbored/loopover/commit/aa95c0ad922caf25eb1800749797754395ae9722))
* **miner:** migrate policy-doc-cache onto the SqliteDriver store seam ([5d19fe3](https://github.com/JSONbored/loopover/commit/5d19fe3cec913157e4c1be4a946e93f3ee6bf766)), closes [#7282](https://github.com/JSONbored/loopover/issues/7282)
* **miner:** roll the SqliteDriver seam onto the non-transactional local stores ([#7558](https://github.com/JSONbored/loopover/issues/7558)) ([7cbaa5b](https://github.com/JSONbored/loopover/commit/7cbaa5b5d0005bdcd8ea398901845aad478f1f7a))
* **miner:** SqliteDriver store seam + migrate run-state ([#7194](https://github.com/JSONbored/loopover/issues/7194)) ([c3660a2](https://github.com/JSONbored/loopover/commit/c3660a25dd27d1b3b6c56eaf24dded9ef0baf0bd))
* **miner:** wire the opt-in discovery-plane client into discover and attempt ([#7220](https://github.com/JSONbored/loopover/issues/7220)) ([0959d4b](https://github.com/JSONbored/loopover/commit/0959d4b7aeb29ae2da4366ed5d178fb1b562a086)), closes [#7168](https://github.com/JSONbored/loopover/issues/7168)
* **notifications:** extend badge notifications to AMS attempt, governor-pause, and PR-outcome events ([#8057](https://github.com/JSONbored/loopover/issues/8057)) ([17848e5](https://github.com/JSONbored/loopover/commit/17848e5068b92e8f037ab5efbaa077908ca978f7)), closes [#7657](https://github.com/JSONbored/loopover/issues/7657)


### Fixes

* **engine:** extend [#5831](https://github.com/JSONbored/loopover/issues/5831)'s repo-segment path-safety validation to governor/portfolio/worktree stores ([#7554](https://github.com/JSONbored/loopover/issues/7554)) ([fadb5cc](https://github.com/JSONbored/loopover/commit/fadb5cc92c7c4e6c2c8108beaf70209c45b6c595)), closes [#7525](https://github.com/JSONbored/loopover/issues/7525)
* **governor-state:** make scalar-state saves atomic against concurrent writers ([b031efa](https://github.com/JSONbored/loopover/commit/b031efa8dae997f1648a291e0ad22f7274d1b955))
* **governor-state:** make scalar-state saves atomic against concurrent writers ([21e9d86](https://github.com/JSONbored/loopover/commit/21e9d86f4d7015134c8ac67f3643ace1d03c3deb)), closes [#7221](https://github.com/JSONbored/loopover/issues/7221)
* **lint:** avoid a comment-induced trailing-whitespace line in compiled opportunity-fanout.js ([de94afb](https://github.com/JSONbored/loopover/commit/de94afbb83a4713fd1191ab92aed5de77cc54b25))
* **miner:** add policy-doc-cache to doctor and migrate store lists ([#7238](https://github.com/JSONbored/loopover/issues/7238)) ([#7263](https://github.com/JSONbored/loopover/issues/7263)) ([3aea7c7](https://github.com/JSONbored/loopover/commit/3aea7c76f0acfef484d63ff11740d4d9b14f381a))
* **miner:** bound the AMS export POST with a request timeout ([#7237](https://github.com/JSONbored/loopover/issues/7237)) ([#7267](https://github.com/JSONbored/loopover/issues/7267)) ([a783cc1](https://github.com/JSONbored/loopover/commit/a783cc1d6b50d58c96c0340d18047d16380e2aa0))
* **miner:** carry real assignees through the discovery-index supplement so the repo-owner exclusion applies ([#7488](https://github.com/JSONbored/loopover/issues/7488)) ([e7cbb1b](https://github.com/JSONbored/loopover/commit/e7cbb1b6cc4e80c8ea1bac4953a07555e437d15b)), closes [#7442](https://github.com/JSONbored/loopover/issues/7442)
* **miner:** fail closed on an unparseable lease in portfolio-queue findStuckItems ([#8033](https://github.com/JSONbored/loopover/issues/8033)) ([bf8bb14](https://github.com/JSONbored/loopover/commit/bf8bb14a444637624ea9b9937de668282edde7f0)), closes [#8007](https://github.com/JSONbored/loopover/issues/8007)
* **miner:** fail closed when referencing PR has missing authorLogin ([#7794](https://github.com/JSONbored/loopover/issues/7794)) ([#7824](https://github.com/JSONbored/loopover/issues/7824)) ([1b30e5b](https://github.com/JSONbored/loopover/commit/1b30e5b01b77469e5f2a7c7eb47df560fe84aede))
* **miner:** log prompt-injection audit from buildTaskBrief ([#7486](https://github.com/JSONbored/loopover/issues/7486)) ([8c2c81f](https://github.com/JSONbored/loopover/commit/8c2c81fcd8cc0305ddc4f47ce791358c8fd5bac3))
* **miner:** match the host's byte-range code-span exclusion + URL closing form in extractLinkedIssueNumbers ([#7550](https://github.com/JSONbored/loopover/issues/7550)) ([f685074](https://github.com/JSONbored/loopover/commit/f685074485960fc024652a3bfb947ecd031e0f8a)), closes [#7527](https://github.com/JSONbored/loopover/issues/7527)
* **miner:** order pr-outcome map by event recency so disengagement streaks are correct ([#7222](https://github.com/JSONbored/loopover/issues/7222)) ([#7239](https://github.com/JSONbored/loopover/issues/7239)) ([c953438](https://github.com/JSONbored/loopover/commit/c953438d08faa457b38e6b992d479c452c0c1067))
* **miner:** page contribution-profile label fetches past 100 ([#8010](https://github.com/JSONbored/loopover/issues/8010)) ([#8040](https://github.com/JSONbored/loopover/issues/8040)) ([75daa84](https://github.com/JSONbored/loopover/commit/75daa84ab384fb87624930fa8ad06e346f330e3c))
* **miner:** purge contribution-profile-cache and governor-state's repo-scoped tables ([#7091](https://github.com/JSONbored/loopover/issues/7091)) ([#7110](https://github.com/JSONbored/loopover/issues/7110)) ([6cb2c17](https://github.com/JSONbored/loopover/commit/6cb2c17eb038bb78cf664737c62363f3b8b6fd05))
* **miner:** purge ranked-candidates, replay-snapshot, and deny-hook-synthesis stores by repo ([#8009](https://github.com/JSONbored/loopover/issues/8009)) ([#8042](https://github.com/JSONbored/loopover/issues/8042)) ([8fcbfd9](https://github.com/JSONbored/loopover/commit/8fcbfd9e493e890a321c9ea368110b24fa616bb4))
* **miner:** reclaim worktree slots by lease age, not cross-container PID liveness ([#7131](https://github.com/JSONbored/loopover/issues/7131)) ([237530a](https://github.com/JSONbored/loopover/commit/237530a80d390e1baa7e53612267456ac16b821a)), closes [#7085](https://github.com/JSONbored/loopover/issues/7085)
* **miner:** register ranked-candidates + deny-hook-synthesis in doctor/migrate store lists ([#8036](https://github.com/JSONbored/loopover/issues/8036)) ([37369b9](https://github.com/JSONbored/loopover/commit/37369b938188538a968352b8d48b66a75ff75c61)), closes [#8008](https://github.com/JSONbored/loopover/issues/8008)
* **miner:** reject path-traversal repo segments in the 4 remaining normalizeRepoFullName parsers ([#8065](https://github.com/JSONbored/loopover/issues/8065)) ([b788945](https://github.com/JSONbored/loopover/commit/b78894571281ace28a4b61f6ce0af96de53eb42e)), closes [#7795](https://github.com/JSONbored/loopover/issues/7795)
* **miner:** reject path-traversal-shaped commitSha in replay-snapshot path planner ([#7996](https://github.com/JSONbored/loopover/issues/7996)) ([2656eaa](https://github.com/JSONbored/loopover/commit/2656eaa3e58df985283ff968fd5048cb9b5ff43b)), closes [#7796](https://github.com/JSONbored/loopover/issues/7796)
* **miner:** report a clean CLI failure when manage status collection throws ([#7236](https://github.com/JSONbored/loopover/issues/7236)) ([#7266](https://github.com/JSONbored/loopover/issues/7266)) ([86d5d31](https://github.com/JSONbored/loopover/commit/86d5d3125e9f4cc3b46ff73c18a8e880ab718a90))
* **miner:** retry transient 5xx/rate-limit in contribution-profile getJson ([#7126](https://github.com/JSONbored/loopover/issues/7126)) ([ec15d24](https://github.com/JSONbored/loopover/commit/ec15d24f20fb18b51980142eff1ff11097695c2b)), closes [#7090](https://github.com/JSONbored/loopover/issues/7090)
* **miner:** retry transient live-state fetch in checkSubmissionFreshness before failing closed ([#7129](https://github.com/JSONbored/loopover/issues/7129)) ([2183167](https://github.com/JSONbored/loopover/commit/21831675a22a05a806a438d166ac086af7b42785)), closes [#7089](https://github.com/JSONbored/loopover/issues/7089)
* **miner:** scan coding-agent driver roots in env-reference generator ([#6994](https://github.com/JSONbored/loopover/issues/6994)) ([#7154](https://github.com/JSONbored/loopover/issues/7154)) ([1d7248b](https://github.com/JSONbored/loopover/commit/1d7248bcec5ad750177d213231a6dff560703ed6))
* **miner:** serialize repo clones across processes with a lockfile ([#7084](https://github.com/JSONbored/loopover/issues/7084)) ([#7162](https://github.com/JSONbored/loopover/issues/7162)) ([051e969](https://github.com/JSONbored/loopover/commit/051e969a30fff45916502c5e9e183f70a84242e8))
* **miner:** size-guard cross-repo manifest by UTF-8 bytes, not UTF-16 length ([#7223](https://github.com/JSONbored/loopover/issues/7223)) ([#7235](https://github.com/JSONbored/loopover/issues/7235)) ([92ccd34](https://github.com/JSONbored/loopover/commit/92ccd34e2f62de898e28f13f520291c486d16252))
* **miner:** sweep a claim with an unparseable claimedAt instead of retaining it forever ([#7746](https://github.com/JSONbored/loopover/issues/7746)) ([352c49f](https://github.com/JSONbored/loopover/commit/352c49fcbe710d5a5272681aef1f2df1142d1d23)), closes [#7732](https://github.com/JSONbored/loopover/issues/7732)
* **miner:** wire policy_verdict_cache into purge/status/migrate local stores ([#7136](https://github.com/JSONbored/loopover/issues/7136)) ([d0fbe82](https://github.com/JSONbored/loopover/commit/d0fbe82c61b53d09ce03580129246becd1fbb0a4)), closes [#6987](https://github.com/JSONbored/loopover/issues/6987)
* **portfolio:** key the queue dashboard per-repo map by (apiBaseUrl, repoFullName) ([#7241](https://github.com/JSONbored/loopover/issues/7241)) ([c7fbb82](https://github.com/JSONbored/loopover/commit/c7fbb8228cd03aad17960bae95db223979e401b0))
* **portfolio:** scope per-repo WIP caps by forge host, not repo name alone ([#7224](https://github.com/JSONbored/loopover/issues/7224)) ([#7261](https://github.com/JSONbored/loopover/issues/7261)) ([4cd3f24](https://github.com/JSONbored/loopover/commit/4cd3f248bf7ddbd5cb1aba9cc4099b8de76b945e))
* **ranker:** only flag default-goal-spec use when every ranked repo lacks one ([#7226](https://github.com/JSONbored/loopover/issues/7226)) ([#7255](https://github.com/JSONbored/loopover/issues/7255)) ([a575ac2](https://github.com/JSONbored/loopover/commit/a575ac2db57f05ceaa8f863b27350c3d01336c36))
* **review:** stop bare hotkey/coldkey mentions from false-positiving as secret leaks ([#7994](https://github.com/JSONbored/loopover/issues/7994)) ([c73f518](https://github.com/JSONbored/loopover/commit/c73f518fad8b99e81135869a19cd756413556cce))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @loopover/engine bumped from ^3.4.0 to ^3.5.0

## [3.4.0](https://github.com/JSONbored/loopover/compare/miner-v3.3.0...miner-v3.4.0) (2026-07-18)


### Features

* **miner-ui:** add discover and attempt HTTP action routes ([#6574](https://github.com/JSONbored/loopover/issues/6574)) ([5c34c3a](https://github.com/JSONbored/loopover/commit/5c34c3a1fd145474ef50a55510c9ada8776b5330)), closes [#6522](https://github.com/JSONbored/loopover/issues/6522)
* **miner:** add AMS hosted-container health HTTP endpoint ([#7177](https://github.com/JSONbored/loopover/issues/7177)) ([#7185](https://github.com/JSONbored/loopover/issues/7185)) ([53527e6](https://github.com/JSONbored/loopover/commit/53527e6fc4f6cc4b218ec054e45d8117b6077dc2))
* **miner:** add config-gated chat action-dispatch scaffolding ([#6542](https://github.com/JSONbored/loopover/issues/6542)) ([c9984c1](https://github.com/JSONbored/loopover/commit/c9984c17935930cea78f74b696eabbf1664f34ee)), closes [#6519](https://github.com/JSONbored/loopover/issues/6519)
* **miner:** add the ContributionProfile local cache store + doctor/migrate integration ([#6797](https://github.com/JSONbored/loopover/issues/6797)) ([#7001](https://github.com/JSONbored/loopover/issues/7001)) ([9171769](https://github.com/JSONbored/loopover/commit/91717695e47939e9ff4c85db897916edeab37b8d))
* **miner:** consult selfLoopAutonomy in decideNextAction's pass-to-handoff step ([#6581](https://github.com/JSONbored/loopover/issues/6581)) ([7a275c7](https://github.com/JSONbored/loopover/commit/7a275c7558c712a49a334397cef98a0509778c6f)), closes [#6560](https://github.com/JSONbored/loopover/issues/6560)
* **miner:** consume ORB live gate thresholds in self-review-context ([1cb09e4](https://github.com/JSONbored/loopover/commit/1cb09e4b55b6d8a8fb1a0c69da659763862b16ee))
* **miner:** design the ContributionProfile schema + caching shape ([#6795](https://github.com/JSONbored/loopover/issues/6795)) ([#6970](https://github.com/JSONbored/loopover/issues/6970)) ([ad8536e](https://github.com/JSONbored/loopover/commit/ad8536e4462dcbf53c9b4eb4b0a6ec991219a357))
* **miner:** exclude discover candidates assigned to the repo owner ([7a7f90a](https://github.com/JSONbored/loopover/commit/7a7f90a44088202c0ae3c4ebef8ed20d617f5492))
* **miner:** exclude discover candidates assigned to the repo owner ([995686f](https://github.com/JSONbored/loopover/commit/995686ffae9acc7b0b7dd89845cbabdeda57156e))
* **miner:** implement generic ContributionProfile extraction ([#6796](https://github.com/JSONbored/loopover/issues/6796)) ([#6979](https://github.com/JSONbored/loopover/issues/6979)) ([018e261](https://github.com/JSONbored/loopover/commit/018e26178421e38fa473e43b962f52bab3b3ad46))
* **miner:** probe ORB live-gate-thresholds in self-review-context ([087a0e3](https://github.com/JSONbored/loopover/commit/087a0e393803598853c2aeb1b0fdbd178aa77473))
* **miner:** register governor pause/resume chat actions ([#6521](https://github.com/JSONbored/loopover/issues/6521)) ([#6587](https://github.com/JSONbored/loopover/issues/6587)) ([ad4486f](https://github.com/JSONbored/loopover/commit/ad4486f0bf98e8f0f05797da588a8bc29838aaee))
* **miner:** SqliteDriver store seam + migrate run-state ([#7194](https://github.com/JSONbored/loopover/issues/7194)) ([c3660a2](https://github.com/JSONbored/loopover/commit/c3660a25dd27d1b3b6c56eaf24dded9ef0baf0bd))
* **miner:** wire chat action-dispatch to the existing discover/attempt routes ([#6837](https://github.com/JSONbored/loopover/issues/6837)) ([#6855](https://github.com/JSONbored/loopover/issues/6855)) ([a4c76a6](https://github.com/JSONbored/loopover/commit/a4c76a6180efc9f8844a7dcc08dcd47b94b54dd7))
* **miner:** wire chat action-dispatch to the existing portfolio release/requeue routes ([#6838](https://github.com/JSONbored/loopover/issues/6838)) ([#6850](https://github.com/JSONbored/loopover/issues/6850)) ([61202e3](https://github.com/JSONbored/loopover/commit/61202e332f9eadf5212573267e10dfc153b7885a))
* **miner:** wire ContributionProfile eligibility filtering into discover ([08e56fb](https://github.com/JSONbored/loopover/commit/08e56fb192406ab14f6b519049ddcbffd185b332))
* **miner:** wire ContributionProfile eligibility filtering into discover ([#6798](https://github.com/JSONbored/loopover/issues/6798)) ([324490b](https://github.com/JSONbored/loopover/commit/324490b6ad19eb548c48b476f4f09e9ad48aa7a1))
* **purge:** add purgeByRepo method to portfolio queue and run state stores ([#6694](https://github.com/JSONbored/loopover/issues/6694)) ([11a6dac](https://github.com/JSONbored/loopover/commit/11a6dacfd65712dedbe9bdcfc29bfbbb86fbce3c))


### Fixes

* **miner:** add the tenant_id column to governor-ledger and plan-store ([#6707](https://github.com/JSONbored/loopover/issues/6707)) ([28f7f05](https://github.com/JSONbored/loopover/commit/28f7f0566e592e0e97cae87c9d9d85fee77321bf)), closes [#6597](https://github.com/JSONbored/loopover/issues/6597)
* **miner:** bound oauth-device-flow.js's GitHub fetches with a request timeout ([cd9aedf](https://github.com/JSONbored/loopover/commit/cd9aedf7cceb45146302158225193bb963ab4eca))
* **miner:** bound oauth-device-flow.js's GitHub fetches with a request timeout ([77ca20f](https://github.com/JSONbored/loopover/commit/77ca20fdcc30d05137b41a5848bce156110c238a))
* **miner:** cover four omitted stores in doctor and migrate ([#6928](https://github.com/JSONbored/loopover/issues/6928)) ([e1df4aa](https://github.com/JSONbored/loopover/commit/e1df4aa04970e19840899b199ee609c870b365b2))
* **miner:** enforce maxConcurrentClaims atomically across sibling processes ([#6912](https://github.com/JSONbored/loopover/issues/6912)) ([b1a2bbd](https://github.com/JSONbored/loopover/commit/b1a2bbd7890b1ecd63629632e4044bcae650f10d)), closes [#6758](https://github.com/JSONbored/loopover/issues/6758)
* **miner:** fail closed when a chat-action handler throws ([8ba48bd](https://github.com/JSONbored/loopover/commit/8ba48bd707dcf002a31991ac434be8cd6a7822d8))
* **miner:** fail closed when a chat-action handler throws ([bdb11d9](https://github.com/JSONbored/loopover/commit/bdb11d974d961594b4555582bd2b7c811b8cde16)), closes [#6989](https://github.com/JSONbored/loopover/issues/6989)
* **miner:** fail fast instead of hanging when init --interactive has no TTY ([#6907](https://github.com/JSONbored/loopover/issues/6907)) ([fa52680](https://github.com/JSONbored/loopover/commit/fa5268061c633b189c0c8487c610b3132bd340e9)), closes [#6846](https://github.com/JSONbored/loopover/issues/6846)
* **miner:** flag real LOOPOVER_MINER_* env vars missing from DEPLOYMENT.md ([#6601](https://github.com/JSONbored/loopover/issues/6601)) ([2e12f63](https://github.com/JSONbored/loopover/commit/2e12f63ec35f69117d53dd680ace20e92bb63172))
* **miner:** flag real LOOPOVER_MINER_* env vars missing from DEPLOYMENT.md ([#6601](https://github.com/JSONbored/loopover/issues/6601)) ([b586810](https://github.com/JSONbored/loopover/commit/b586810665222a673f5f0b6268bbe827156f3ca5))
* **miner:** forward HOME and the real coding-agent credential to CLI subprocesses ([4a852de](https://github.com/JSONbored/loopover/commit/4a852de548963d6e8c5b858af8c36880d3132ab6))
* **miner:** open doctor's laptop-state check read-only (camelCase readOnly) ([#6866](https://github.com/JSONbored/loopover/issues/6866)) ([81a3a03](https://github.com/JSONbored/loopover/commit/81a3a03464c334bcf7959f8434a294b7ff6acbdd))
* **miner:** open the worktree allocator through local-store's openLocalStoreDb ([#6600](https://github.com/JSONbored/loopover/issues/6600)) ([#6704](https://github.com/JSONbored/loopover/issues/6704)) ([4e9aa2d](https://github.com/JSONbored/loopover/commit/4e9aa2d97954ffcf71e43de981282231e33e74b5))
* **miner:** purge contribution-profile-cache and governor-state's repo-scoped tables ([#7091](https://github.com/JSONbored/loopover/issues/7091)) ([#7110](https://github.com/JSONbored/loopover/issues/7110)) ([6cb2c17](https://github.com/JSONbored/loopover/commit/6cb2c17eb038bb78cf664737c62363f3b8b6fd05))
* **miner:** reclaim worktree slots by lease age, not cross-container PID liveness ([#7131](https://github.com/JSONbored/loopover/issues/7131)) ([237530a](https://github.com/JSONbored/loopover/commit/237530a80d390e1baa7e53612267456ac16b821a)), closes [#7085](https://github.com/JSONbored/loopover/issues/7085)
* **miner:** reject blank acceptance hints as an objective success signal ([#6766](https://github.com/JSONbored/loopover/issues/6766)) ([25792fd](https://github.com/JSONbored/loopover/commit/25792fd68a5a4007b7e3409224356e0e6bf66da3))
* **miner:** reject blank acceptance hints as an objective success signal ([#6766](https://github.com/JSONbored/loopover/issues/6766)) ([fd730f1](https://github.com/JSONbored/loopover/commit/fd730f172aa3bec9b1b03e54fae369433c700f5d))
* **miner:** release the primed portfolio claim when --max-cycles is exhausted ([d2244e9](https://github.com/JSONbored/loopover/commit/d2244e92bacc47c6f110879becead46d36e4fc41))
* **miner:** release the primed portfolio claim when --max-cycles is exhausted ([c976ca3](https://github.com/JSONbored/loopover/commit/c976ca3b680b9d511b599a6b2d1d91fa324b487f))
* **miner:** report the real post-failure schema version for a partially-applied migration ([#6860](https://github.com/JSONbored/loopover/issues/6860)) ([4b786b1](https://github.com/JSONbored/loopover/commit/4b786b12f1f4d13cc809b5914a80bc8222f0d53e))
* **miner:** require a closing keyword in self-review's linked-PR extractor ([#6769](https://github.com/JSONbored/loopover/issues/6769)) ([6f5520d](https://github.com/JSONbored/loopover/commit/6f5520d3381c280a60d7b12034767ea57d2ed726))
* **miner:** require a closing keyword in self-review's linked-PR extractor ([#6769](https://github.com/JSONbored/loopover/issues/6769)) ([5192411](https://github.com/JSONbored/loopover/commit/5192411550ea4f82296c66feb10dec8decdd5520))
* **miner:** retain a crashed attempt's worktree for post-mortem ([#6867](https://github.com/JSONbored/loopover/issues/6867)) ([8ef43a4](https://github.com/JSONbored/loopover/commit/8ef43a434ce825f618a90e31c05292326dad4b7b))
* **miner:** retry GitHub rate-limit responses in http-retry instead of aborting the poll ([#6761](https://github.com/JSONbored/loopover/issues/6761)) ([#6878](https://github.com/JSONbored/loopover/issues/6878)) ([58cd901](https://github.com/JSONbored/loopover/commit/58cd901019ec6269646936af59e3e08afcef9676))
* **miner:** retry transient 5xx/rate-limit in contribution-profile getJson ([#7126](https://github.com/JSONbored/loopover/issues/7126)) ([ec15d24](https://github.com/JSONbored/loopover/commit/ec15d24f20fb18b51980142eff1ff11097695c2b)), closes [#7090](https://github.com/JSONbored/loopover/issues/7090)
* **miner:** retry transient live-state fetch in checkSubmissionFreshness before failing closed ([#7129](https://github.com/JSONbored/loopover/issues/7129)) ([2183167](https://github.com/JSONbored/loopover/commit/21831675a22a05a806a438d166ac086af7b42785)), closes [#7089](https://github.com/JSONbored/loopover/issues/7089)
* **miner:** route the governor/prediction/plan local stores through openLocalStoreDb ([#6667](https://github.com/JSONbored/loopover/issues/6667)) ([0591ffc](https://github.com/JSONbored/loopover/commit/0591ffcb7013fc42442862868db53b573d25b8ee))
* **miner:** scan coding-agent driver roots in env-reference generator ([#6994](https://github.com/JSONbored/loopover/issues/6994)) ([#7154](https://github.com/JSONbored/loopover/issues/7154)) ([1d7248b](https://github.com/JSONbored/loopover/commit/1d7248bcec5ad750177d213231a6dff560703ed6))
* **miner:** scope the managed-PR queue row to the polled forge host ([de1c473](https://github.com/JSONbored/loopover/commit/de1c47361bbf29e9b89414c6c7a3eabda4a32f0a))
* **miner:** scope the managed-PR queue row to the polled forge host ([492aef3](https://github.com/JSONbored/loopover/commit/492aef32b9edb8e067e9f929235541f106b04af6))
* **miner:** serialize per-repo base clone to prevent concurrent git races ([#6917](https://github.com/JSONbored/loopover/issues/6917)) ([2e2f588](https://github.com/JSONbored/loopover/commit/2e2f588068764520248bc9541ef9a794e66624d8)), closes [#6762](https://github.com/JSONbored/loopover/issues/6762)
* **miner:** serialize repo clones across processes with a lockfile ([#7084](https://github.com/JSONbored/loopover/issues/7084)) ([#7162](https://github.com/JSONbored/loopover/issues/7162)) ([051e969](https://github.com/JSONbored/loopover/commit/051e969a30fff45916502c5e9e183f70a84242e8))
* **miner:** stamp prediction-ledger schema version and add tenant_id column ([#6702](https://github.com/JSONbored/loopover/issues/6702)) ([46b1aca](https://github.com/JSONbored/loopover/commit/46b1aca8a434519f8aa830ef28cbb660a72faee7)), closes [#6596](https://github.com/JSONbored/loopover/issues/6596)
* **miner:** wire policy_verdict_cache into purge/status/migrate local stores ([#7136](https://github.com/JSONbored/loopover/issues/7136)) ([d0fbe82](https://github.com/JSONbored/loopover/commit/d0fbe82c61b53d09ce03580129246becd1fbb0a4)), closes [#6987](https://github.com/JSONbored/loopover/issues/6987)
* **registry:** scope self-host repo registration to gittensor opt-ins ([67af510](https://github.com/JSONbored/loopover/commit/67af510f55f064fa49c0e748a21670cc040a9b87))
* **release:** scope MCP publish validation to its own package ([86ee117](https://github.com/JSONbored/loopover/commit/86ee11744f7c7d2f76c9d64345391f61651256c8))
* **selfhost:** templatize the docker-prune systemd unit for multi-host use ([a740bce](https://github.com/JSONbored/loopover/commit/a740bce60b6181d9343c9e5f59ea879e5d390af2))
* **selfhost:** templatize the docker-prune systemd unit for multi-host use ([1842bd3](https://github.com/JSONbored/loopover/commit/1842bd332c751bedd1601bd25fb9d61d7d8ccb4b)), closes [#4894](https://github.com/JSONbored/loopover/issues/4894)
* **test:** update grafana dashboard assertions for the historical-continuity query rewrite ([8cd0b24](https://github.com/JSONbored/loopover/commit/8cd0b2489e1b4f1803a310951f53f25d94ff6ddb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @loopover/engine bumped from ^3.3.0 to ^3.4.0

## [3.3.0](https://github.com/JSONbored/loopover/compare/miner-v3.2.3...miner-v3.3.0) (2026-07-18)


### Features

* **miner:** add AMS hosted-container health HTTP endpoint ([#7177](https://github.com/JSONbored/loopover/issues/7177)) ([#7185](https://github.com/JSONbored/loopover/issues/7185)) ([53527e6](https://github.com/JSONbored/loopover/commit/53527e6fc4f6cc4b218ec054e45d8117b6077dc2))
* **miner:** SqliteDriver store seam + migrate run-state ([#7194](https://github.com/JSONbored/loopover/issues/7194)) ([c3660a2](https://github.com/JSONbored/loopover/commit/c3660a25dd27d1b3b6c56eaf24dded9ef0baf0bd))


### Fixes

* **miner:** scan coding-agent driver roots in env-reference generator ([#6994](https://github.com/JSONbored/loopover/issues/6994)) ([#7154](https://github.com/JSONbored/loopover/issues/7154)) ([1d7248b](https://github.com/JSONbored/loopover/commit/1d7248bcec5ad750177d213231a6dff560703ed6))
* **miner:** serialize repo clones across processes with a lockfile ([#7084](https://github.com/JSONbored/loopover/issues/7084)) ([#7162](https://github.com/JSONbored/loopover/issues/7162)) ([051e969](https://github.com/JSONbored/loopover/commit/051e969a30fff45916502c5e9e183f70a84242e8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @loopover/engine bumped from ^3.2.3 to ^3.3.0

## [3.2.3](https://github.com/JSONbored/loopover/compare/miner-v3.2.2...miner-v3.2.3) (2026-07-18)


### Fixes

* **miner:** bound oauth-device-flow.js's GitHub fetches with a request timeout ([cd9aedf](https://github.com/JSONbored/loopover/commit/cd9aedf7cceb45146302158225193bb963ab4eca))
* **miner:** bound oauth-device-flow.js's GitHub fetches with a request timeout ([77ca20f](https://github.com/JSONbored/loopover/commit/77ca20fdcc30d05137b41a5848bce156110c238a))
* **miner:** fail closed when a chat-action handler throws ([8ba48bd](https://github.com/JSONbored/loopover/commit/8ba48bd707dcf002a31991ac434be8cd6a7822d8))
* **miner:** fail closed when a chat-action handler throws ([bdb11d9](https://github.com/JSONbored/loopover/commit/bdb11d974d961594b4555582bd2b7c811b8cde16)), closes [#6989](https://github.com/JSONbored/loopover/issues/6989)
* **miner:** purge contribution-profile-cache and governor-state's repo-scoped tables ([#7091](https://github.com/JSONbored/loopover/issues/7091)) ([#7110](https://github.com/JSONbored/loopover/issues/7110)) ([6cb2c17](https://github.com/JSONbored/loopover/commit/6cb2c17eb038bb78cf664737c62363f3b8b6fd05))
* **miner:** reclaim worktree slots by lease age, not cross-container PID liveness ([#7131](https://github.com/JSONbored/loopover/issues/7131)) ([237530a](https://github.com/JSONbored/loopover/commit/237530a80d390e1baa7e53612267456ac16b821a)), closes [#7085](https://github.com/JSONbored/loopover/issues/7085)
* **miner:** retry transient 5xx/rate-limit in contribution-profile getJson ([#7126](https://github.com/JSONbored/loopover/issues/7126)) ([ec15d24](https://github.com/JSONbored/loopover/commit/ec15d24f20fb18b51980142eff1ff11097695c2b)), closes [#7090](https://github.com/JSONbored/loopover/issues/7090)
* **miner:** retry transient live-state fetch in checkSubmissionFreshness before failing closed ([#7129](https://github.com/JSONbored/loopover/issues/7129)) ([2183167](https://github.com/JSONbored/loopover/commit/21831675a22a05a806a438d166ac086af7b42785)), closes [#7089](https://github.com/JSONbored/loopover/issues/7089)
* **miner:** wire policy_verdict_cache into purge/status/migrate local stores ([#7136](https://github.com/JSONbored/loopover/issues/7136)) ([d0fbe82](https://github.com/JSONbored/loopover/commit/d0fbe82c61b53d09ce03580129246becd1fbb0a4)), closes [#6987](https://github.com/JSONbored/loopover/issues/6987)
* **release:** scope MCP publish validation to its own package ([86ee117](https://github.com/JSONbored/loopover/commit/86ee11744f7c7d2f76c9d64345391f61651256c8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @loopover/engine bumped from ^3.2.2 to ^3.2.3

## [3.2.2](https://github.com/JSONbored/loopover/compare/miner-v3.2.1...miner-v3.2.2) (2026-07-17)


### Fixes

* **miner:** bound oauth-device-flow.js's GitHub fetches with a request timeout ([cd9aedf](https://github.com/JSONbored/loopover/commit/cd9aedf7cceb45146302158225193bb963ab4eca))
* **miner:** bound oauth-device-flow.js's GitHub fetches with a request timeout ([77ca20f](https://github.com/JSONbored/loopover/commit/77ca20fdcc30d05137b41a5848bce156110c238a))
* **miner:** fail closed when a chat-action handler throws ([8ba48bd](https://github.com/JSONbored/loopover/commit/8ba48bd707dcf002a31991ac434be8cd6a7822d8))
* **miner:** fail closed when a chat-action handler throws ([bdb11d9](https://github.com/JSONbored/loopover/commit/bdb11d974d961594b4555582bd2b7c811b8cde16)), closes [#6989](https://github.com/JSONbored/loopover/issues/6989)
* **miner:** purge contribution-profile-cache and governor-state's repo-scoped tables ([#7091](https://github.com/JSONbored/loopover/issues/7091)) ([#7110](https://github.com/JSONbored/loopover/issues/7110)) ([6cb2c17](https://github.com/JSONbored/loopover/commit/6cb2c17eb038bb78cf664737c62363f3b8b6fd05))
* **miner:** reclaim worktree slots by lease age, not cross-container PID liveness ([#7131](https://github.com/JSONbored/loopover/issues/7131)) ([237530a](https://github.com/JSONbored/loopover/commit/237530a80d390e1baa7e53612267456ac16b821a)), closes [#7085](https://github.com/JSONbored/loopover/issues/7085)
* **miner:** retry transient 5xx/rate-limit in contribution-profile getJson ([#7126](https://github.com/JSONbored/loopover/issues/7126)) ([ec15d24](https://github.com/JSONbored/loopover/commit/ec15d24f20fb18b51980142eff1ff11097695c2b)), closes [#7090](https://github.com/JSONbored/loopover/issues/7090)
* **miner:** retry transient live-state fetch in checkSubmissionFreshness before failing closed ([#7129](https://github.com/JSONbored/loopover/issues/7129)) ([2183167](https://github.com/JSONbored/loopover/commit/21831675a22a05a806a438d166ac086af7b42785)), closes [#7089](https://github.com/JSONbored/loopover/issues/7089)
* **release:** scope MCP publish validation to its own package ([86ee117](https://github.com/JSONbored/loopover/commit/86ee11744f7c7d2f76c9d64345391f61651256c8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @loopover/engine bumped from ^3.2.1 to ^3.2.2

## [3.2.1](https://github.com/JSONbored/loopover/compare/miner-v3.1.1...miner-v3.2.1) (2026-07-17)


### Fixes

* **miner:** bound oauth-device-flow.js's GitHub fetches with a request timeout ([cd9aedf](https://github.com/JSONbored/loopover/commit/cd9aedf7cceb45146302158225193bb963ab4eca))
* **miner:** bound oauth-device-flow.js's GitHub fetches with a request timeout ([77ca20f](https://github.com/JSONbored/loopover/commit/77ca20fdcc30d05137b41a5848bce156110c238a))
* **miner:** fail closed when a chat-action handler throws ([8ba48bd](https://github.com/JSONbored/loopover/commit/8ba48bd707dcf002a31991ac434be8cd6a7822d8))
* **miner:** fail closed when a chat-action handler throws ([bdb11d9](https://github.com/JSONbored/loopover/commit/bdb11d974d961594b4555582bd2b7c811b8cde16)), closes [#6989](https://github.com/JSONbored/loopover/issues/6989)
* **miner:** purge contribution-profile-cache and governor-state's repo-scoped tables ([#7091](https://github.com/JSONbored/loopover/issues/7091)) ([#7110](https://github.com/JSONbored/loopover/issues/7110)) ([6cb2c17](https://github.com/JSONbored/loopover/commit/6cb2c17eb038bb78cf664737c62363f3b8b6fd05))
* **release:** scope MCP publish validation to its own package ([86ee117](https://github.com/JSONbored/loopover/commit/86ee11744f7c7d2f76c9d64345391f61651256c8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @loopover/engine bumped from ^3.0.0 to ^3.2.1

## [3.1.1](https://github.com/JSONbored/loopover/compare/miner-v3.1.0...miner-v3.1.1) (2026-07-17)


### Fixes

* **miner:** bound oauth-device-flow.js's GitHub fetches with a request timeout ([77ca20f](https://github.com/JSONbored/loopover/commit/77ca20fdcc30d05137b41a5848bce156110c238a))
* **miner:** fail closed when a chat-action handler throws ([bdb11d9](https://github.com/JSONbored/loopover/commit/bdb11d974d961594b4555582bd2b7c811b8cde16))

### Chores

- Re-cut release: miner-v3.1.0's release PR merged but the tag/publish never completed (release-please's own trigger only ran on a 2-day cron, and npm's Trusted Publisher config pointed at the pre-rebrand repo identity).

## [3.1.0](https://github.com/JSONbored/loopover/compare/miner-v3.0.0...miner-v3.1.0) (2026-07-17)


### Features

* **miner-ui:** add discover and attempt HTTP action routes ([#6574](https://github.com/JSONbored/loopover/issues/6574)) ([5c34c3a](https://github.com/JSONbored/loopover/commit/5c34c3a1fd145474ef50a55510c9ada8776b5330)), closes [#6522](https://github.com/JSONbored/loopover/issues/6522)
* **miner:** add config-gated chat action-dispatch scaffolding ([#6542](https://github.com/JSONbored/loopover/issues/6542)) ([c9984c1](https://github.com/JSONbored/loopover/commit/c9984c17935930cea78f74b696eabbf1664f34ee)), closes [#6519](https://github.com/JSONbored/loopover/issues/6519)
* **miner:** add the ContributionProfile local cache store + doctor/migrate integration ([#6797](https://github.com/JSONbored/loopover/issues/6797)) ([#7001](https://github.com/JSONbored/loopover/issues/7001)) ([9171769](https://github.com/JSONbored/loopover/commit/91717695e47939e9ff4c85db897916edeab37b8d))
* **miner:** consult selfLoopAutonomy in decideNextAction's pass-to-handoff step ([#6581](https://github.com/JSONbored/loopover/issues/6581)) ([7a275c7](https://github.com/JSONbored/loopover/commit/7a275c7558c712a49a334397cef98a0509778c6f)), closes [#6560](https://github.com/JSONbored/loopover/issues/6560)
* **miner:** consume ORB live gate thresholds in self-review-context ([1cb09e4](https://github.com/JSONbored/loopover/commit/1cb09e4b55b6d8a8fb1a0c69da659763862b16ee))
* **miner:** design the ContributionProfile schema + caching shape ([#6795](https://github.com/JSONbored/loopover/issues/6795)) ([#6970](https://github.com/JSONbored/loopover/issues/6970)) ([ad8536e](https://github.com/JSONbored/loopover/commit/ad8536e4462dcbf53c9b4eb4b0a6ec991219a357))
* **miner:** exclude discover candidates assigned to the repo owner ([7a7f90a](https://github.com/JSONbored/loopover/commit/7a7f90a44088202c0ae3c4ebef8ed20d617f5492))
* **miner:** exclude discover candidates assigned to the repo owner ([995686f](https://github.com/JSONbored/loopover/commit/995686ffae9acc7b0b7dd89845cbabdeda57156e))
* **miner:** implement generic ContributionProfile extraction ([#6796](https://github.com/JSONbored/loopover/issues/6796)) ([#6979](https://github.com/JSONbored/loopover/issues/6979)) ([018e261](https://github.com/JSONbored/loopover/commit/018e26178421e38fa473e43b962f52bab3b3ad46))
* **miner:** probe ORB live-gate-thresholds in self-review-context ([087a0e3](https://github.com/JSONbored/loopover/commit/087a0e393803598853c2aeb1b0fdbd178aa77473))
* **miner:** register governor pause/resume chat actions ([#6521](https://github.com/JSONbored/loopover/issues/6521)) ([#6587](https://github.com/JSONbored/loopover/issues/6587)) ([ad4486f](https://github.com/JSONbored/loopover/commit/ad4486f0bf98e8f0f05797da588a8bc29838aaee))
* **miner:** wire chat action-dispatch to the existing discover/attempt routes ([#6837](https://github.com/JSONbored/loopover/issues/6837)) ([#6855](https://github.com/JSONbored/loopover/issues/6855)) ([a4c76a6](https://github.com/JSONbored/loopover/commit/a4c76a6180efc9f8844a7dcc08dcd47b94b54dd7))
* **miner:** wire chat action-dispatch to the existing portfolio release/requeue routes ([#6838](https://github.com/JSONbored/loopover/issues/6838)) ([#6850](https://github.com/JSONbored/loopover/issues/6850)) ([61202e3](https://github.com/JSONbored/loopover/commit/61202e332f9eadf5212573267e10dfc153b7885a))
* **miner:** wire ContributionProfile eligibility filtering into discover ([08e56fb](https://github.com/JSONbored/loopover/commit/08e56fb192406ab14f6b519049ddcbffd185b332))
* **miner:** wire ContributionProfile eligibility filtering into discover ([#6798](https://github.com/JSONbored/loopover/issues/6798)) ([324490b](https://github.com/JSONbored/loopover/commit/324490b6ad19eb548c48b476f4f09e9ad48aa7a1))
* **purge:** add purgeByRepo method to portfolio queue and run state stores ([#6694](https://github.com/JSONbored/loopover/issues/6694)) ([11a6dac](https://github.com/JSONbored/loopover/commit/11a6dacfd65712dedbe9bdcfc29bfbbb86fbce3c))


### Fixes

* **config:** scrub remaining pre-rename gittensory references ([23152da](https://github.com/JSONbored/loopover/commit/23152dafcc1bbb329bdc63606dee311cdb4267cf))
* **config:** scrub remaining pre-rename gittensory references ([e4b0f8c](https://github.com/JSONbored/loopover/commit/e4b0f8cd4e24cbc7c14b157e7d660f73adca2115))
* **miner:** add the tenant_id column to governor-ledger and plan-store ([#6707](https://github.com/JSONbored/loopover/issues/6707)) ([28f7f05](https://github.com/JSONbored/loopover/commit/28f7f0566e592e0e97cae87c9d9d85fee77321bf)), closes [#6597](https://github.com/JSONbored/loopover/issues/6597)
* **miner:** cover four omitted stores in doctor and migrate ([#6928](https://github.com/JSONbored/loopover/issues/6928)) ([e1df4aa](https://github.com/JSONbored/loopover/commit/e1df4aa04970e19840899b199ee609c870b365b2))
* **miner:** enforce maxConcurrentClaims atomically across sibling processes ([#6912](https://github.com/JSONbored/loopover/issues/6912)) ([b1a2bbd](https://github.com/JSONbored/loopover/commit/b1a2bbd7890b1ecd63629632e4044bcae650f10d)), closes [#6758](https://github.com/JSONbored/loopover/issues/6758)
* **miner:** expire claims orphaned by a dead process at claim time ([#6441](https://github.com/JSONbored/loopover/issues/6441)) ([4d326e4](https://github.com/JSONbored/loopover/commit/4d326e47fbb16f91d12c3b8d2bde1ed9c50a122e)), closes [#6156](https://github.com/JSONbored/loopover/issues/6156)
* **miner:** fail fast instead of hanging when init --interactive has no TTY ([#6907](https://github.com/JSONbored/loopover/issues/6907)) ([fa52680](https://github.com/JSONbored/loopover/commit/fa5268061c633b189c0c8487c610b3132bd340e9)), closes [#6846](https://github.com/JSONbored/loopover/issues/6846)
* **miner:** flag real LOOPOVER_MINER_* env vars missing from DEPLOYMENT.md ([#6601](https://github.com/JSONbored/loopover/issues/6601)) ([2e12f63](https://github.com/JSONbored/loopover/commit/2e12f63ec35f69117d53dd680ace20e92bb63172))
* **miner:** flag real LOOPOVER_MINER_* env vars missing from DEPLOYMENT.md ([#6601](https://github.com/JSONbored/loopover/issues/6601)) ([b586810](https://github.com/JSONbored/loopover/commit/b586810665222a673f5f0b6268bbe827156f3ca5))
* **miner:** forward HOME and the real coding-agent credential to CLI subprocesses ([4a852de](https://github.com/JSONbored/loopover/commit/4a852de548963d6e8c5b858af8c36880d3132ab6))
* **miner:** open doctor's laptop-state check read-only (camelCase readOnly) ([#6866](https://github.com/JSONbored/loopover/issues/6866)) ([81a3a03](https://github.com/JSONbored/loopover/commit/81a3a03464c334bcf7959f8434a294b7ff6acbdd))
* **miner:** open the worktree allocator through local-store's openLocalStoreDb ([#6600](https://github.com/JSONbored/loopover/issues/6600)) ([#6704](https://github.com/JSONbored/loopover/issues/6704)) ([4e9aa2d](https://github.com/JSONbored/loopover/commit/4e9aa2d97954ffcf71e43de981282231e33e74b5))
* **miner:** reject blank acceptance hints as an objective success signal ([#6766](https://github.com/JSONbored/loopover/issues/6766)) ([25792fd](https://github.com/JSONbored/loopover/commit/25792fd68a5a4007b7e3409224356e0e6bf66da3))
* **miner:** reject blank acceptance hints as an objective success signal ([#6766](https://github.com/JSONbored/loopover/issues/6766)) ([fd730f1](https://github.com/JSONbored/loopover/commit/fd730f172aa3bec9b1b03e54fae369433c700f5d))
* **miner:** release the primed portfolio claim when --max-cycles is exhausted ([d2244e9](https://github.com/JSONbored/loopover/commit/d2244e92bacc47c6f110879becead46d36e4fc41))
* **miner:** release the primed portfolio claim when --max-cycles is exhausted ([c976ca3](https://github.com/JSONbored/loopover/commit/c976ca3b680b9d511b599a6b2d1d91fa324b487f))
* **miner:** report the real post-failure schema version for a partially-applied migration ([#6860](https://github.com/JSONbored/loopover/issues/6860)) ([4b786b1](https://github.com/JSONbored/loopover/commit/4b786b12f1f4d13cc809b5914a80bc8222f0d53e))
* **miner:** require a closing keyword in self-review's linked-PR extractor ([#6769](https://github.com/JSONbored/loopover/issues/6769)) ([6f5520d](https://github.com/JSONbored/loopover/commit/6f5520d3381c280a60d7b12034767ea57d2ed726))
* **miner:** require a closing keyword in self-review's linked-PR extractor ([#6769](https://github.com/JSONbored/loopover/issues/6769)) ([5192411](https://github.com/JSONbored/loopover/commit/5192411550ea4f82296c66feb10dec8decdd5520))
* **miner:** retain a crashed attempt's worktree for post-mortem ([#6867](https://github.com/JSONbored/loopover/issues/6867)) ([8ef43a4](https://github.com/JSONbored/loopover/commit/8ef43a434ce825f618a90e31c05292326dad4b7b))
* **miner:** retry GitHub rate-limit responses in http-retry instead of aborting the poll ([#6761](https://github.com/JSONbored/loopover/issues/6761)) ([#6878](https://github.com/JSONbored/loopover/issues/6878)) ([58cd901](https://github.com/JSONbored/loopover/commit/58cd901019ec6269646936af59e3e08afcef9676))
* **miner:** route the governor/prediction/plan local stores through openLocalStoreDb ([#6667](https://github.com/JSONbored/loopover/issues/6667)) ([0591ffc](https://github.com/JSONbored/loopover/commit/0591ffcb7013fc42442862868db53b573d25b8ee))
* **miner:** scope the managed-PR queue row to the polled forge host ([de1c473](https://github.com/JSONbored/loopover/commit/de1c47361bbf29e9b89414c6c7a3eabda4a32f0a))
* **miner:** scope the managed-PR queue row to the polled forge host ([492aef3](https://github.com/JSONbored/loopover/commit/492aef32b9edb8e067e9f929235541f106b04af6))
* **miner:** serialize per-repo base clone to prevent concurrent git races ([#6917](https://github.com/JSONbored/loopover/issues/6917)) ([2e2f588](https://github.com/JSONbored/loopover/commit/2e2f588068764520248bc9541ef9a794e66624d8)), closes [#6762](https://github.com/JSONbored/loopover/issues/6762)
* **miner:** stamp prediction-ledger schema version and add tenant_id column ([#6702](https://github.com/JSONbored/loopover/issues/6702)) ([46b1aca](https://github.com/JSONbored/loopover/commit/46b1aca8a434519f8aa830ef28cbb660a72faee7)), closes [#6596](https://github.com/JSONbored/loopover/issues/6596)
* **miner:** wire DEPLOYMENT.md audit into real CI execution ([1019fb2](https://github.com/JSONbored/loopover/commit/1019fb247740f094aae4b1420f83799f97d83578))
* **miner:** wire DEPLOYMENT.md audit into real CI execution ([cdf3321](https://github.com/JSONbored/loopover/commit/cdf33212d65841b1826232c3e92eb2ad53c5d109)), closes [#6158](https://github.com/JSONbored/loopover/issues/6158)
* **registry:** scope self-host repo registration to gittensor opt-ins ([67af510](https://github.com/JSONbored/loopover/commit/67af510f55f064fa49c0e748a21670cc040a9b87))
* **selfhost:** templatize the docker-prune systemd unit for multi-host use ([a740bce](https://github.com/JSONbored/loopover/commit/a740bce60b6181d9343c9e5f59ea879e5d390af2))
* **selfhost:** templatize the docker-prune systemd unit for multi-host use ([1842bd3](https://github.com/JSONbored/loopover/commit/1842bd332c751bedd1601bd25fb9d61d7d8ccb4b)), closes [#4894](https://github.com/JSONbored/loopover/issues/4894)
* **test:** update grafana dashboard assertions for the historical-continuity query rewrite ([8cd0b24](https://github.com/JSONbored/loopover/commit/8cd0b2489e1b4f1803a310951f53f25d94ff6ddb))

## [3.0.0](https://github.com/JSONbored/loopover/compare/miner-v2.0.0...miner-v3.0.0) (2026-07-14)


### ⚠ BREAKING CHANGES

* **config:** every GITTENSORY_* environment variable is now LOOPOVER_*. No dual-read/alias, per the epic's full-cutover mandate. Operators must rename these in their .env / secrets before deploying this change.
* **build:** every gittensory-prefixed directory under apps/ and packages/ is now loopover-prefixed, and the two extension packages' npm names changed from @jsonbored/gittensory-* to @loopover/*. No dual-path/alias, per the epic's full-cutover mandate.

### Features

* **build:** Phase 5 - full-cutover rename all gittensory-* directories to loopover-* ([#5743](https://github.com/JSONbored/loopover/issues/5743)) ([81e4ac3](https://github.com/JSONbored/loopover/commit/81e4ac34dfb4dee9c3cadefcc27a515617462da9))
* **config:** Phase 6 - full-cutover rename internal GITTENSORY_* constants to LOOPOVER_* ([#5750](https://github.com/JSONbored/loopover/issues/5750)) ([12958f4](https://github.com/JSONbored/loopover/commit/12958f4f36cbf1f9f1ac732e718a4316e91cb103)), closes [#5705](https://github.com/JSONbored/loopover/issues/5705)
* **miner:** add cross-repo evaluation harness ([#4788](https://github.com/JSONbored/loopover/issues/4788)) ([#5790](https://github.com/JSONbored/loopover/issues/5790)) ([0fff506](https://github.com/JSONbored/loopover/commit/0fff50692dbae856f2dbcc26d7c9cd8225ddf7c9))
* **miner:** honor kill-switch mid-attempt during iterate-loop ([#5799](https://github.com/JSONbored/loopover/issues/5799)) ([3525e95](https://github.com/JSONbored/loopover/commit/3525e95a4afd0a9827e64fc00a20919d9a222f82))
* **miner:** pre-execution feasibility check for freeform ideas ([#5789](https://github.com/JSONbored/loopover/issues/5789)) ([0e6f368](https://github.com/JSONbored/loopover/commit/0e6f3681829a76ddddb77484cfc94cea6b5545b1)), closes [#5671](https://github.com/JSONbored/loopover/issues/5671)
* **selfhost:** bridge fleet-mode miner state to the ams-observability exporter ([#5844](https://github.com/JSONbored/loopover/issues/5844)) ([15f6610](https://github.com/JSONbored/loopover/commit/15f66105ca69a28bf23d7a981b52affabd64b527)), closes [#5805](https://github.com/JSONbored/loopover/issues/5805)


### Fixes

* **miner:** list queue dashboard in cli.js help text ([#5853](https://github.com/JSONbored/loopover/issues/5853)) ([cd97822](https://github.com/JSONbored/loopover/commit/cd978226386e29ab2c617b1b3409c7e7724775a0)), closes [#5832](https://github.com/JSONbored/loopover/issues/5832)
* **rebrand:** full-cutover rename miner/AMS per-repo and operator config filenames ([#5765](https://github.com/JSONbored/loopover/issues/5765)) ([c93569d](https://github.com/JSONbored/loopover/commit/c93569dcd977ec7a6ec78157b6b40374f85f12cc))

## [2.0.0](https://github.com/JSONbored/gittensory/compare/miner-v1.0.0...miner-v2.0.0) (2026-07-14)


### ⚠ BREAKING CHANGES

* **cli:** `gittensory-miner`, `gittensory-miner-mcp`, and `gittensory-mcp` no longer exist as installed binaries; use `loopover-miner`, `loopover-miner-mcp`, and `loopover-mcp`. No dual-read/alias, per the epic's full-cutover mandate. A global npm install/link of the old package names must be reinstalled.

### Features

* **cli:** Phase 3 - full-cutover rename CLI binaries to loopover-* ([#5728](https://github.com/JSONbored/gittensory/issues/5728)) ([f2ee2ad](https://github.com/JSONbored/gittensory/commit/f2ee2ad24e0bf01d0a2dfd8f39421bb80aa527b6))


### Fixes

* **miner:** tighten the @loopover/engine dependency to ^2.0.0 ([#5729](https://github.com/JSONbored/gittensory/issues/5729)) ([634e121](https://github.com/JSONbored/gittensory/commit/634e121c7ed360a5e395f425013d32ca9c5d0ed6))

## [1.0.0](https://github.com/JSONbored/gittensory/compare/miner-v0.1.0...miner-v1.0.0) (2026-07-14)


### ⚠ BREAKING CHANGES

* **miner:** the miner's default config directory and every gittensory_miner_* Prometheus metric name changed; no dual-read/alias, per the epic's full-cutover mandate ([#5705](https://github.com/JSONbored/gittensory/issues/5705)). A self-hoster's existing ~/.config/gittensory-miner state does not migrate automatically.
* **miner:** every LOOPOVER_MINER_*/LOOPOVER_API_TOKEN_FILE/ LOOPOVER_MCP_TOKEN_FILE/LOOPOVER_MEM_LIMIT/LOOPOVER_REPORTING_* env var an existing self-hosted AMS/miner deployment sets must be renamed to its LOOPOVER_ equivalent -- the old names are no longer read.

### Features

* **mcp:** wire gittensory_feasibility_gate's claimStatus to the local claim ledger ([#5157](https://github.com/JSONbored/gittensory/issues/5157)) ([#5389](https://github.com/JSONbored/gittensory/issues/5389)) ([91b235d](https://github.com/JSONbored/gittensory/commit/91b235dbc4c9e3c818ff0a76e98f087c1f3ec8c2))
* **miner-deployment:** add docker-compose.miner.yml for AMS fleet mode ([#5299](https://github.com/JSONbored/gittensory/issues/5299)) ([df806cc](https://github.com/JSONbored/gittensory/commit/df806cca164630c471522ee0148a373c928270c7)), closes [#5177](https://github.com/JSONbored/gittensory/issues/5177)
* **miner-governor:** build a real production runSlopAssessment implementation ([#5133](https://github.com/JSONbored/gittensory/issues/5133)) ([#5140](https://github.com/JSONbored/gittensory/issues/5140)) ([e7d95a9](https://github.com/JSONbored/gittensory/commit/e7d95a9041a9f9292622b54ae5591a2343df1d0d))
* **miner-governor:** build production CodingAgentDriver construction ([#5131](https://github.com/JSONbored/gittensory/issues/5131)) ([#5138](https://github.com/JSONbored/gittensory/issues/5138)) ([9396dc8](https://github.com/JSONbored/gittensory/commit/9396dc873f447fe81ced70640ae25f664b4d6848))
* **miner-governor:** closed-loop discovery re-entry trigger ([#2338](https://github.com/JSONbored/gittensory/issues/2338)) ([#5051](https://github.com/JSONbored/gittensory/issues/5051)) ([d7e38d6](https://github.com/JSONbored/gittensory/commit/d7e38d6981fa973f61a320cf426dec293675f13e))
* **miner-governor:** dry-run-by-default enforcement + fail-closed chokepoint ([#2342](https://github.com/JSONbored/gittensory/issues/2342), [#2340](https://github.com/JSONbored/gittensory/issues/2340)) ([#5014](https://github.com/JSONbored/gittensory/issues/5014)) ([4719f2c](https://github.com/JSONbored/gittensory/commit/4719f2c2cb7a53e6f0288aedaea2ed205a59e347))
* **miner-governor:** enforce non-convergence + budget/turn/termination halts ([#2347](https://github.com/JSONbored/gittensory/issues/2347)) ([#4989](https://github.com/JSONbored/gittensory/issues/4989)) ([51208ce](https://github.com/JSONbored/gittensory/commit/51208ce443a5372e1234e7f7baedfdb4bb6e8864))
* **miner-governor:** freeze/snapshot mechanism for historical replay targets ([#3010](https://github.com/JSONbored/gittensory/issues/3010)) ([#5113](https://github.com/JSONbored/gittensory/issues/5113)) ([aacf718](https://github.com/JSONbored/gittensory/commit/aacf718d1f84f012de5c96b68d0644f3616ed220))
* **miner-governor:** global + per-repo kill-switch ([#2341](https://github.com/JSONbored/gittensory/issues/2341)) ([#5012](https://github.com/JSONbored/gittensory/issues/5012)) ([dcc1601](https://github.com/JSONbored/gittensory/commit/dcc1601cfb017164c6134d0e333ca74e69d95e78))
* **miner-governor:** kill-switch propagation into the manage/loop subsystem ([#2339](https://github.com/JSONbored/gittensory/issues/2339)) ([#5057](https://github.com/JSONbored/gittensory/issues/5057)) ([a21a8ad](https://github.com/JSONbored/gittensory/commit/a21a8ad8dce8a69880e2110bf48ad6fae6e645a2))
* **miner-governor:** late-binding freshness check before open_pr fires ([#3007](https://github.com/JSONbored/gittensory/issues/3007)) ([#5112](https://github.com/JSONbored/gittensory/issues/5112)) ([7d260f1](https://github.com/JSONbored/gittensory/commit/7d260f1067233bc293533b547382098c1c724beb))
* **miner-governor:** persist governor cross-attempt state ([#5134](https://github.com/JSONbored/gittensory/issues/5134)) ([#5203](https://github.com/JSONbored/gittensory/issues/5203)) ([a78edc8](https://github.com/JSONbored/gittensory/commit/a78edc884d3ad684093caa5dbe1dc53ff69bbe06))
* **miner-governor:** PreToolUse-hook-enforced house rules ([#2343](https://github.com/JSONbored/gittensory/issues/2343)) ([#5031](https://github.com/JSONbored/gittensory/issues/5031)) ([5aa103b](https://github.com/JSONbored/gittensory/commit/5aa103b9c418328de20a48b630a05be201d21104))
* **miner-governor:** self-plagiarism throttle across the miner's own repos ([#4972](https://github.com/JSONbored/gittensory/issues/4972)) ([f0fa765](https://github.com/JSONbored/gittensory/commit/f0fa76523340d956c2408d14fc8ce31513017391))
* **miner-governor:** shape the gated open-pr submission payload from a handoff ([#2337](https://github.com/JSONbored/gittensory/issues/2337)) ([#5091](https://github.com/JSONbored/gittensory/issues/5091)) ([86d1338](https://github.com/JSONbored/gittensory/commit/86d1338ea375167a39cc49d4997716c9d9718466))
* **miner-governor:** the real create-&gt;review-&gt;gate-&gt;submit attempt pipeline ([#2337](https://github.com/JSONbored/gittensory/issues/2337)) ([#5118](https://github.com/JSONbored/gittensory/issues/5118)) ([46d63b9](https://github.com/JSONbored/gittensory/commit/46d63b9c06b96fe39d6fc1f944989cbbe5b59199))
* **miner-governor:** wire rate-limit + jittered backoff into live write enforcement ([#2344](https://github.com/JSONbored/gittensory/issues/2344)) ([#4984](https://github.com/JSONbored/gittensory/issues/4984)) ([f175e0c](https://github.com/JSONbored/gittensory/commit/f175e0c028c2803f0d9410599d12ec4590e03c39))
* **miner-hands:** resolve the own-rejection-history trigger of rejectionSignaled ([#5657](https://github.com/JSONbored/gittensory/issues/5657)) ([7826e1d](https://github.com/JSONbored/gittensory/commit/7826e1dc53317920c8abf90699afc41aca8d3163)), closes [#5655](https://github.com/JSONbored/gittensory/issues/5655)
* **miner-hands:** wire real self-plagiarism data into the Governor chokepoint ([#5706](https://github.com/JSONbored/gittensory/issues/5706)) ([40ce138](https://github.com/JSONbored/gittensory/commit/40ce138e607d0c71ad2fa7a93cfc9f59ce9a4f86)), closes [#5676](https://github.com/JSONbored/gittensory/issues/5676)
* **miner-mcp:** event-ledger audit feed tool ([#5158](https://github.com/JSONbored/gittensory/issues/5158)) ([#5348](https://github.com/JSONbored/gittensory/issues/5348)) ([26624ca](https://github.com/JSONbored/gittensory/commit/26624cae9a0cdf61225a73c745b72260f4688246))
* **miner-selfimprove:** wire the historical-replay scorer into the Phase 7 calibration loop ([#4248](https://github.com/JSONbored/gittensory/issues/4248)) ([#5462](https://github.com/JSONbored/gittensory/issues/5462)) ([7e2e20d](https://github.com/JSONbored/gittensory/commit/7e2e20d1553385bf7602b2137b83abed60db229a))
* **miner-ui:** add a systemd unit for running miner-ui as a persistent service ([#5610](https://github.com/JSONbored/gittensory/issues/5610)) ([f7aa717](https://github.com/JSONbored/gittensory/commit/f7aa7172a15b14b588b5462d727d3212a947af7e)), closes [#4852](https://github.com/JSONbored/gittensory/issues/4852)
* **miner:** add --dry-run to attempt and loop ([#5527](https://github.com/JSONbored/gittensory/issues/5527)) ([a952d43](https://github.com/JSONbored/gittensory/commit/a952d43b633221296bafb05611f6b36ddc239b9f)), closes [#4847](https://github.com/JSONbored/gittensory/issues/4847)
* **miner:** add --dry-run to governor pause/resume ([#5553](https://github.com/JSONbored/gittensory/issues/5553)) ([a5bec8a](https://github.com/JSONbored/gittensory/commit/a5bec8acadd7efa2aad72a2c03d88370cd5c0ca4)), closes [#4847](https://github.com/JSONbored/gittensory/issues/4847)
* **miner:** add --dry-run to the remaining local-mutating CLI commands ([#5532](https://github.com/JSONbored/gittensory/issues/5532)) ([34ae1e5](https://github.com/JSONbored/gittensory/commit/34ae1e5d13be2df7ceabe29bf5ac7755692cb523)), closes [#4847](https://github.com/JSONbored/gittensory/issues/4847)
* **miner:** add .gittensory-ams.yml operator execution-policy config ([#5249](https://github.com/JSONbored/gittensory/issues/5249)) ([f92b298](https://github.com/JSONbored/gittensory/commit/f92b2982bac4d32000aabea366805bb008f52e0e))
* **miner:** add a calibration-report CLI command ([#5460](https://github.com/JSONbored/gittensory/issues/5460)) ([9a0f378](https://github.com/JSONbored/gittensory/commit/9a0f378e935902e34a5f60a201bf7fac4b593121)), closes [#4849](https://github.com/JSONbored/gittensory/issues/4849)
* **miner:** add a committed benchmark suite for discovery ranking and the local-store path ([#5615](https://github.com/JSONbored/gittensory/issues/5615)) ([a05e02e](https://github.com/JSONbored/gittensory/commit/a05e02e49f9847c6964502bc7d2a93cc29c327b6))
* **miner:** add a fleet-mode AMS host Terraform starter module ([#5549](https://github.com/JSONbored/gittensory/issues/5549)) ([f0b1840](https://github.com/JSONbored/gittensory/commit/f0b1840f573698ca8e9cd3dbe85698c11cd5655f)), closes [#5183](https://github.com/JSONbored/gittensory/issues/5183)
* **miner:** add a gittensory-miner init --interactive first-run onboarding wizard ([#5621](https://github.com/JSONbored/gittensory/issues/5621)) ([c5815f4](https://github.com/JSONbored/gittensory/commit/c5815f4152b1d714759e1e340b9d77091e703520))
* **miner:** add a gittensory-miner migrate command for the local stores ([#5538](https://github.com/JSONbored/gittensory/issues/5538)) ([4b609eb](https://github.com/JSONbored/gittensory/commit/4b609eb89b6c7829c6754214134e2adedf2a0586)), closes [#4871](https://github.com/JSONbored/gittensory/issues/4871)
* **miner:** add a ledger metrics command that renders event-ledger Prometheus text ([#4841](https://github.com/JSONbored/gittensory/issues/4841)) ([#5486](https://github.com/JSONbored/gittensory/issues/5486)) ([16b4191](https://github.com/JSONbored/gittensory/commit/16b4191d9925e3f055d7ffaa1d346c4974dba04e))
* **miner:** add a level-aware logging abstraction for the CLI ([#4835](https://github.com/JSONbored/gittensory/issues/4835)) ([#5550](https://github.com/JSONbored/gittensory/issues/5550)) ([eeb6ab4](https://github.com/JSONbored/gittensory/commit/eeb6ab4f6002c4d79104e36c684943f00478c6da))
* **miner:** add a metrics command that renders prediction-calibration Prometheus text ([#4838](https://github.com/JSONbored/gittensory/issues/4838)) ([#5470](https://github.com/JSONbored/gittensory/issues/5470)) ([29c18f2](https://github.com/JSONbored/gittensory/commit/29c18f28ff1e233a7a9bf3bd387363f4b8a865ec))
* **miner:** add a right-to-be-forgotten purge command across the local ledgers ([#5568](https://github.com/JSONbored/gittensory/issues/5568)) ([27c9685](https://github.com/JSONbored/gittensory/commit/27c968516d82b7045934d90e3047f90fd94da16e)), closes [#5564](https://github.com/JSONbored/gittensory/issues/5564)
* **miner:** add a systemd bare-host service example for the miner loop ([#5350](https://github.com/JSONbored/gittensory/issues/5350)) ([aeb2244](https://github.com/JSONbored/gittensory/commit/aeb22445a59076c7f4b58b5154bb11c188f7439b)), closes [#5197](https://github.com/JSONbored/gittensory/issues/5197)
* **miner:** add backup/restore tooling for local SQLite state ([#5623](https://github.com/JSONbored/gittensory/issues/5623)) ([b189eaf](https://github.com/JSONbored/gittensory/commit/b189eafe30b0ef79a3776edcbeda3d6bb7b1713b))
* **miner:** add GitHub token and coding agent credential checks to doctor functionality ([#5514](https://github.com/JSONbored/gittensory/issues/5514)) ([d25c60d](https://github.com/JSONbored/gittensory/commit/d25c60dbec40579cf3099c37d5446a5bd2cc96fd))
* **miner:** add GITHUB_TOKEN_FILE secret-mount indirection for fleet mode ([#5560](https://github.com/JSONbored/gittensory/issues/5560)) ([72fb957](https://github.com/JSONbored/gittensory/commit/72fb957cc2651e4505670714a02785ca21d4c9f9)), closes [#5178](https://github.com/JSONbored/gittensory/issues/5178)
* **miner:** add governor rate-limit/budget Prometheus metrics + pressure alerts ([#5604](https://github.com/JSONbored/gittensory/issues/5604)) ([29e460e](https://github.com/JSONbored/gittensory/commit/29e460e5d2269d28237b6cb0ed7a37df0822246e))
* **miner:** add lease + expiry sweep to reclaim stuck portfolio-queue items ([#5202](https://github.com/JSONbored/gittensory/issues/5202)) ([2e9fab7](https://github.com/JSONbored/gittensory/commit/2e9fab7ba1196a9cc81963b08482889c7c746005)), closes [#4827](https://github.com/JSONbored/gittensory/issues/4827)
* **miner:** add portfolio-queue Prometheus metrics + stuck/backlog alerts ([#5603](https://github.com/JSONbored/gittensory/issues/5603)) ([7e55ebc](https://github.com/JSONbored/gittensory/commit/7e55ebc18199d3838749f422428bd9a5e4815b5f))
* **miner:** add queue release and requeue commands to CLI ([#5520](https://github.com/JSONbored/gittensory/issues/5520)) ([05d1fb0](https://github.com/JSONbored/gittensory/commit/05d1fb0b7adaa6fc676238898fce97d127bd351b))
* **miner:** add repo stack auto-detection ([#4785](https://github.com/JSONbored/gittensory/issues/4785)) ([#5477](https://github.com/JSONbored/gittensory/issues/5477)) ([849e11e](https://github.com/JSONbored/gittensory/commit/849e11e0d3e0323adbeed30571dab6385edaa221))
* **miner:** add schema-version migration runner across local stores ([#5364](https://github.com/JSONbored/gittensory/issues/5364)) ([e8e068d](https://github.com/JSONbored/gittensory/commit/e8e068da36edfc08ccfc1c5320c0454337525bef)), closes [#4832](https://github.com/JSONbored/gittensory/issues/4832)
* **miner:** add signal and crash handling to the CLI ([#4826](https://github.com/JSONbored/gittensory/issues/4826)) ([#5484](https://github.com/JSONbored/gittensory/issues/5484)) ([34fc243](https://github.com/JSONbored/gittensory/commit/34fc243f93333a01ee90e7202c3fa1bc235bfa78))
* **miner:** add store integrity checks and ledger retention ([#5388](https://github.com/JSONbored/gittensory/issues/5388)) ([6fbf9d4](https://github.com/JSONbored/gittensory/commit/6fbf9d4c12709ae9357d994ada931b33b1db835c)), closes [#4834](https://github.com/JSONbored/gittensory/issues/4834)
* **miner:** audit DEPLOYMENT.md env vars, paths, and CLI subcommands against source ([#5414](https://github.com/JSONbored/gittensory/issues/5414)) ([c535aa4](https://github.com/JSONbored/gittensory/commit/c535aa46c79e659861dd936a8109812beda7ec90)), closes [#5180](https://github.com/JSONbored/gittensory/issues/5180)
* **miner:** build a governor pause/resume control surface ([#5523](https://github.com/JSONbored/gittensory/issues/5523)) ([b7d3645](https://github.com/JSONbored/gittensory/commit/b7d364518c1ae0fbb5baca4f52f53c36239cbc56))
* **miner:** build a real SelfReviewContext fetcher ([#5145](https://github.com/JSONbored/gittensory/issues/5145)) ([#5235](https://github.com/JSONbored/gittensory/issues/5235)) ([7a423be](https://github.com/JSONbored/gittensory/commit/7a423be3648342232e9274e39ef39c691feca967))
* **miner:** build the autonomous supervising loop ([#5303](https://github.com/JSONbored/gittensory/issues/5303)) ([dc6fa7a](https://github.com/JSONbored/gittensory/commit/dc6fa7a7348f3daaaa07c2e5fff8194350621a93))
* **miner:** build the coding-task-spec (title/instructions/acceptanceCriteriaPath) ([#5132](https://github.com/JSONbored/gittensory/issues/5132)) ([#5239](https://github.com/JSONbored/gittensory/issues/5239)) ([199a995](https://github.com/JSONbored/gittensory/commit/199a9951c92a23b139afa2ea674d10e575fc3da2))
* **miner:** cache policy docs with conditional-GET revalidation ([#5508](https://github.com/JSONbored/gittensory/issues/5508)) ([a798778](https://github.com/JSONbored/gittensory/commit/a79877859859b063b9820d2c697d7f2a870e87d9)), closes [#4842](https://github.com/JSONbored/gittensory/issues/4842)
* **miner:** de-hardcode discovery from gittensory's own conventions ([#4784](https://github.com/JSONbored/gittensory/issues/4784)) ([#5472](https://github.com/JSONbored/gittensory/issues/5472)) ([eca8387](https://github.com/JSONbored/gittensory/commit/eca83877cbf6052d404b073fbad9a7d52f319143))
* **miner:** device-flow OAuth onboarding for the loopover-ams GitHub App ([#5703](https://github.com/JSONbored/gittensory/issues/5703)) ([63885df](https://github.com/JSONbored/gittensory/commit/63885dfe90329799eab19074bd191ee59bd71d11)), closes [#5682](https://github.com/JSONbored/gittensory/issues/5682)
* **miner:** enhance coding-agent instructions with detected repo stack commands ([#4786](https://github.com/JSONbored/gittensory/issues/4786)) ([#5722](https://github.com/JSONbored/gittensory/issues/5722)) ([f7b2352](https://github.com/JSONbored/gittensory/commit/f7b23522b81c2b5aa9a40b1ea46e50a00f5b94d5))
* **miner:** expose governor decisions via a read-only, payload-redacted MCP tool ([#5413](https://github.com/JSONbored/gittensory/issues/5413)) ([cffe5aa](https://github.com/JSONbored/gittensory/commit/cffe5aa7625cf5bf9144fac0b0e843bbabf2a423)), closes [#5159](https://github.com/JSONbored/gittensory/issues/5159)
* **miner:** expose per-repo run-state as a read-only MCP tool ([#5363](https://github.com/JSONbored/gittensory/issues/5363)) ([b5db38f](https://github.com/JSONbored/gittensory/commit/b5db38fa765fe9abe49d3561571fa9448c10db43)), closes [#5160](https://github.com/JSONbored/gittensory/issues/5160)
* **miner:** expose status/doctor diagnostics via a read-only MCP tool ([#5415](https://github.com/JSONbored/gittensory/issues/5415)) ([b7d3308](https://github.com/JSONbored/gittensory/commit/b7d33089f749cc5581556ddb306765f607a6ac01)), closes [#5154](https://github.com/JSONbored/gittensory/issues/5154)
* **miner:** expose the claim ledger as a read-only MCP tool ([#5326](https://github.com/JSONbored/gittensory/issues/5326)) ([97707b8](https://github.com/JSONbored/gittensory/commit/97707b8f6a13854c5a0970af206353476f5b35eb)), closes [#5156](https://github.com/JSONbored/gittensory/issues/5156)
* **miner:** expose the persisted plan store via read-only MCP tools ([#5371](https://github.com/JSONbored/gittensory/issues/5371)) ([a0639fd](https://github.com/JSONbored/gittensory/commit/a0639fd2a109e728fb0385413f2db0dc9627a3b1)), closes [#5161](https://github.com/JSONbored/gittensory/issues/5161)
* **miner:** expose the portfolio-queue dashboard as a read-only MCP tool ([#5298](https://github.com/JSONbored/gittensory/issues/5298)) ([0f68081](https://github.com/JSONbored/gittensory/commit/0f680818323940a793379fd2c690ce410ee8c65e)), closes [#5155](https://github.com/JSONbored/gittensory/issues/5155)
* **miner:** extract and persist real coding-agent token usage ([#5658](https://github.com/JSONbored/gittensory/issues/5658)) ([1e0ac6c](https://github.com/JSONbored/gittensory/commit/1e0ac6c9b1d932f2f83b34efdfea24710988c606))
* **miner:** generated env-var reference with CI drift check ([#5179](https://github.com/JSONbored/gittensory/issues/5179)) ([#5295](https://github.com/JSONbored/gittensory/issues/5295)) ([83944c4](https://github.com/JSONbored/gittensory/commit/83944c46029bb16744ec5b3b27f8b7f32aa401ad))
* **miner:** make queue next WIP-cap-aware via --global-wip/--per-repo-wip ([#5600](https://github.com/JSONbored/gittensory/issues/5600)) ([bbcb787](https://github.com/JSONbored/gittensory/commit/bbcb78730defb431fd11aeb78ccde60d12324034))
* **miner:** paginate discovery fetches via the GitHub Link header ([#4831](https://github.com/JSONbored/gittensory/issues/4831)) ([#5442](https://github.com/JSONbored/gittensory/issues/5442)) ([65fa28b](https://github.com/JSONbored/gittensory/commit/65fa28bb52cccd3e6d038e4cfa22c842ccdea8fb))
* **miner:** persist coding-agent provider + real cost on the attempt log ([#5637](https://github.com/JSONbored/gittensory/issues/5637)) ([941c300](https://github.com/JSONbored/gittensory/commit/941c300691982c65b534e86bdedf03a85f8712b4))
* **miner:** persist ranked-candidates snapshots and serve them locally ([#5619](https://github.com/JSONbored/gittensory/issues/5619)) ([6553b54](https://github.com/JSONbored/gittensory/commit/6553b54d34ce005e4120e040e96e0b62119ac439))
* **miner:** persist resolved policy verdicts across discover runs ([#5516](https://github.com/JSONbored/gittensory/issues/5516)) ([0d5c340](https://github.com/JSONbored/gittensory/commit/0d5c3402a3899fcb9f8658a21472b3b0c1be8d01))
* **miner:** read loop-cli convergence history from the persisted portfolio queue ([#5679](https://github.com/JSONbored/gittensory/issues/5679)) ([66e927e](https://github.com/JSONbored/gittensory/commit/66e927e95bfbb7135494a4000a42372b336cbb86)), closes [#5677](https://github.com/JSONbored/gittensory/issues/5677)
* **miner:** rename LOOPOVER_MINER_*/LOOPOVER_* env vars to LOOPOVER_MINER_*/LOOPOVER_* ([#5707](https://github.com/JSONbored/gittensory/issues/5707)) ([6714f0c](https://github.com/JSONbored/gittensory/commit/6714f0cac5ab37477c7f56332cde969788c7996e)), closes [#5705](https://github.com/JSONbored/gittensory/issues/5705)
* **miner:** resolve rejectionSignaled's AI-usage-policy-ban trigger ([#5132](https://github.com/JSONbored/gittensory/issues/5132)) ([#5241](https://github.com/JSONbored/gittensory/issues/5241)) ([e6adb43](https://github.com/JSONbored/gittensory/commit/e6adb4396f236200ca116fbb59a2c144e9053902))
* **miner:** resolve the real per-repo MinerGoalSpec from a cloned worktree ([#5255](https://github.com/JSONbored/gittensory/issues/5255)) ([28949be](https://github.com/JSONbored/gittensory/commit/28949be13b97f4eaa0d013e7b37317790833c13f))
* **miner:** respect --json on CLI error paths ([#5543](https://github.com/JSONbored/gittensory/issues/5543)) ([7cffca2](https://github.com/JSONbored/gittensory/commit/7cffca2c8893a4a7a98c79618ee635a531b6e40b))
* **miner:** retry a transient 5xx around the CI and gate-verdict pollers ([#5420](https://github.com/JSONbored/gittensory/issues/5420)) ([59ba5d1](https://github.com/JSONbored/gittensory/commit/59ba5d1d5bb299c1b5c2d1f79a57362bc5a177f3)), closes [#4829](https://github.com/JSONbored/gittensory/issues/4829)
* **miner:** retry a transient 5xx in the discovery fanout ([#5425](https://github.com/JSONbored/gittensory/issues/5425)) ([6b703a4](https://github.com/JSONbored/gittensory/commit/6b703a406546f0cd51bd7e03a53c8a237b7fbe00)), closes [#4830](https://github.com/JSONbored/gittensory/issues/4830)
* **miner:** scaffold the gittensory-miner MCP stdio server ([#5254](https://github.com/JSONbored/gittensory/issues/5254)) ([e99c151](https://github.com/JSONbored/gittensory/commit/e99c15179aefe4880b3c76f2554591e99df1c8e2)), closes [#5153](https://github.com/JSONbored/gittensory/issues/5153)
* **miner:** surface a codex auth-freshness remediation detail in doctor ([#5166](https://github.com/JSONbored/gittensory/issues/5166)) ([#5297](https://github.com/JSONbored/gittensory/issues/5297)) ([b7a410d](https://github.com/JSONbored/gittensory/commit/b7a410d798e133e09bfbc578d82f4716754cd551))
* **miner:** surface rate-limit telemetry in discover output ([#4837](https://github.com/JSONbored/gittensory/issues/4837)) ([#5461](https://github.com/JSONbored/gittensory/issues/5461)) ([7e89fae](https://github.com/JSONbored/gittensory/commit/7e89faeaae8e9685e9e64900f73d858e226b55c0))
* **miner:** surface the resolved coding-agent-driver provider and CLI presence in status --json ([#5164](https://github.com/JSONbored/gittensory/issues/5164)) ([#5312](https://github.com/JSONbored/gittensory/issues/5312)) ([fb76770](https://github.com/JSONbored/gittensory/commit/fb76770d13d011836e557f5fa4e0dfedf59e8e88))
* **miner:** throttle discovery concurrency as rate-limit budget drops ([#5467](https://github.com/JSONbored/gittensory/issues/5467)) ([6a6426e](https://github.com/JSONbored/gittensory/commit/6a6426eccc4f4e693508c614df8713b4b00dcb70)), closes [#4844](https://github.com/JSONbored/gittensory/issues/4844)
* **miner:** track real per-issue attempt-history on the portfolio queue ([#5661](https://github.com/JSONbored/gittensory/issues/5661)) ([b579eb6](https://github.com/JSONbored/gittensory/commit/b579eb6a0f0ff8554dc7e622d22928c2d1063742)), closes [#5654](https://github.com/JSONbored/gittensory/issues/5654)
* **miner:** update package structure and validation for operational files ([#5528](https://github.com/JSONbored/gittensory/issues/5528)) ([15d9d1a](https://github.com/JSONbored/gittensory/commit/15d9d1a3c8b07aab05430507ade2e09148c72128))
* **miner:** validate config content in doctor, not just its path ([#5402](https://github.com/JSONbored/gittensory/issues/5402)) ([0d78f24](https://github.com/JSONbored/gittensory/commit/0d78f24a06241beb36b1b7805b1cad9faee0d004)), closes [#4873](https://github.com/JSONbored/gittensory/issues/4873)
* **miner:** wire AMS's dead orb-export.js telemetry stub to a real central ingest endpoint ([#5697](https://github.com/JSONbored/gittensory/issues/5697)) ([4ebce08](https://github.com/JSONbored/gittensory/commit/4ebce08b02ace82e2c59d938fb1b947473e9e0ad)), closes [#5681](https://github.com/JSONbored/gittensory/issues/5681)
* **miner:** wire attempt-metering.ts into the iterate loop for a real mid-attempt budget abort ([#5437](https://github.com/JSONbored/gittensory/issues/5437)) ([30a6ffb](https://github.com/JSONbored/gittensory/commit/30a6ffbc7b7625d0fdc4ce01320ca7a5da4c986b))
* **miner:** wire claim-conflict resolution end-to-end ([#5480](https://github.com/JSONbored/gittensory/issues/5480)) ([7109bf2](https://github.com/JSONbored/gittensory/commit/7109bf267eba84733c441fa8e137c1a5d310983d))
* **miner:** wire per-repo kill switch, real claim-ledger, and CI-status observation into the real attempt/loop pipeline ([#5429](https://github.com/JSONbored/gittensory/issues/5429)) ([5ff7d37](https://github.com/JSONbored/gittensory/commit/5ff7d37c5f2e6ef6b738bb0e318292d7726e6ec3))
* **miner:** wire real git worktree preparation into the attempt CLI ([#5252](https://github.com/JSONbored/gittensory/issues/5252)) ([44a1861](https://github.com/JSONbored/gittensory/commit/44a186136af42ff78f12103f923113d8b5a8583c))
* **miner:** wire real git worktree preparation into the attempt pipeline ([#5132](https://github.com/JSONbored/gittensory/issues/5132)) ([#5237](https://github.com/JSONbored/gittensory/issues/5237)) ([69e8d81](https://github.com/JSONbored/gittensory/commit/69e8d8171263d7bdea29706235856be29f0380e0))
* **miner:** wire real reputationHistory into the Governor's self-reputation throttle ([#5685](https://github.com/JSONbored/gittensory/issues/5685)) ([be9af47](https://github.com/JSONbored/gittensory/commit/be9af47a970a1770ff9b4bf7c0ebe1e40ef1d0da)), closes [#5675](https://github.com/JSONbored/gittensory/issues/5675)
* **miner:** wire the attempt CLI subcommand's real dependencies ([#5132](https://github.com/JSONbored/gittensory/issues/5132)) ([#5152](https://github.com/JSONbored/gittensory/issues/5152)) ([f166c07](https://github.com/JSONbored/gittensory/commit/f166c07aa3f4c59a5e13427c637985f1827f323e))
* **miner:** wire the batch claimer and telemetry exporter into the CLI ([#5242](https://github.com/JSONbored/gittensory/issues/5242)) ([d3b9707](https://github.com/JSONbored/gittensory/commit/d3b97079bb4e84e5aab83295b52c79d32cc55286)), closes [#4833](https://github.com/JSONbored/gittensory/issues/4833)
* **miner:** wire the real runMinerAttempt call into attempt-cli.js ([#5261](https://github.com/JSONbored/gittensory/issues/5261)) ([f3f1f2b](https://github.com/JSONbored/gittensory/commit/f3f1f2b59565fc83ce2f7f84d3b186a533221087))


### Fixes

* **miner-extension:** purge a stale discoveryIndexUrl value from chrome.storage.sync ([#5511](https://github.com/JSONbored/gittensory/issues/5511)) ([ec7d4c2](https://github.com/JSONbored/gittensory/commit/ec7d4c248a1507165f299eec7a69f4d16b2deb62))
* **miner-governor:** require global live opt-in ([#5231](https://github.com/JSONbored/gittensory/issues/5231)) ([14c75e2](https://github.com/JSONbored/gittensory/commit/14c75e29c8f4e25f50e8a30af94e47f9df0a3234))
* **miner-governor:** wire buildHouseRulesPreToolUseHook into a real driver-construction call site ([#5082](https://github.com/JSONbored/gittensory/issues/5082)) ([e04e847](https://github.com/JSONbored/gittensory/commit/e04e847069d199d2163162da33d5158c02d204aa))
* **miner-governor:** wire the real attempt pipeline to persisted governor state ([#5134](https://github.com/JSONbored/gittensory/issues/5134)) ([#5214](https://github.com/JSONbored/gittensory/issues/5214)) ([8802933](https://github.com/JSONbored/gittensory/commit/8802933a6bb817d683cc20ce08112761b11f31da))
* **miner:** add optional token verification to init ([#5422](https://github.com/JSONbored/gittensory/issues/5422)) ([e790f89](https://github.com/JSONbored/gittensory/commit/e790f89f2b87683016cab8aedee759fca6e04756))
* **miner:** add three lib files missing from build:miner's check list ([#5210](https://github.com/JSONbored/gittensory/issues/5210)) ([b81e00c](https://github.com/JSONbored/gittensory/commit/b81e00cff5b8a4b918f29966eba287bf9974160a))
* **miner:** avoid unscoped run-state lookup ([#4653](https://github.com/JSONbored/gittensory/issues/4653)) ([9a46a4b](https://github.com/JSONbored/gittensory/commit/9a46a4b412f18774f5440d23c23df836205edc4b))
* **miner:** bound rejection policy document reads ([#5325](https://github.com/JSONbored/gittensory/issues/5325)) ([1894b75](https://github.com/JSONbored/gittensory/commit/1894b758479a05bd7fe5cd900fc7b8f0411c8b89))
* **miner:** bound self-review manifest reads ([#5358](https://github.com/JSONbored/gittensory/issues/5358)) ([09b155e](https://github.com/JSONbored/gittensory/commit/09b155ef85c4dc9ccd7462bd18af834d02ddcb43))
* **miner:** claimNextBatch can claim the wrong host's row across two forge hosts ([#5594](https://github.com/JSONbored/gittensory/issues/5594)) ([2cd2aa8](https://github.com/JSONbored/gittensory/commit/2cd2aa8d979a66ace61cb5e505462525addf8a86))
* **miner:** close two blind spots in the DEPLOYMENT.md docs-accuracy audit ([#5435](https://github.com/JSONbored/gittensory/issues/5435)) ([156b382](https://github.com/JSONbored/gittensory/commit/156b382598bbbcf1513546458034863f5daab4c3))
* **miner:** close_pr runs unconditionally before its best-effort comment ([#5494](https://github.com/JSONbored/gittensory/issues/5494)) ([68ce986](https://github.com/JSONbored/gittensory/commit/68ce986ed319eca62b8bc3a4c840346cc1ee6e97))
* **miner:** constrain discovery pagination URLs ([#5487](https://github.com/JSONbored/gittensory/issues/5487)) ([09fd393](https://github.com/JSONbored/gittensory/commit/09fd393153627c753154042adaaabb98b7822b90))
* **miner:** derive sdk changed files from git ([#5362](https://github.com/JSONbored/gittensory/issues/5362)) ([20dc547](https://github.com/JSONbored/gittensory/commit/20dc547551b89b375a2f023b24bf644f19937716))
* **miner:** fail closed for CLI drivers when house-rule hooks are explicitly requested ([#5142](https://github.com/JSONbored/gittensory/issues/5142)) ([029ada8](https://github.com/JSONbored/gittensory/commit/029ada80de3f5688231a077fb97cd2bdd2217f91))
* **miner:** full-cutover rename gittensory-miner config dir + Prometheus metric names ([#5721](https://github.com/JSONbored/gittensory/issues/5721)) ([8496b4f](https://github.com/JSONbored/gittensory/commit/8496b4f4cf6a0215852ca4e40841bd31fd85b796))
* **miner:** gate doctor's claude/codex CLI-presence checks by MINER_CODING_AGENT_PROVIDER ([#5165](https://github.com/JSONbored/gittensory/issues/5165)) ([#5271](https://github.com/JSONbored/gittensory/issues/5271)) ([fb9fb20](https://github.com/JSONbored/gittensory/commit/fb9fb20a36d7bf7148c128533b6a1951503a8ef5))
* **miner:** keep AMS policy operator-local ([#5351](https://github.com/JSONbored/gittensory/issues/5351)) ([5f28519](https://github.com/JSONbored/gittensory/commit/5f2851923071506f1c67cb0b79933be43e7a5d1b))
* **miner:** reject symlinked goal specs ([#5497](https://github.com/JSONbored/gittensory/issues/5497)) ([690644d](https://github.com/JSONbored/gittensory/commit/690644d41cc19769213d0e0af3998ea76ec4a7df))
* **miner:** scope claim-ledger by forge host, not bare repoFullName ([#5576](https://github.com/JSONbored/gittensory/issues/5576)) ([f3cbcc0](https://github.com/JSONbored/gittensory/commit/f3cbcc0b2f6fce72d8b4f7d61297104a2e94ac66))
* **miner:** scope deny-hook synthesis proposals by forge host, not bare repoFullName ([#5595](https://github.com/JSONbored/gittensory/issues/5595)) ([a7f2063](https://github.com/JSONbored/gittensory/commit/a7f2063374db98814c71357a6975be3a0d4ee351))
* **miner:** scope governor_reputation_history by forge host, not bare repoFullName ([#5591](https://github.com/JSONbored/gittensory/issues/5591)) ([968a838](https://github.com/JSONbored/gittensory/commit/968a838b0ee9c78929a32fa37131ce959e907c8c))
* **miner:** scope portfolio-queue by forge host, not bare repoFullName ([#5583](https://github.com/JSONbored/gittensory/issues/5583)) ([8e42774](https://github.com/JSONbored/gittensory/commit/8e42774bf761e0d7a0e5e53a3106f89d9978488a))
* **miner:** scope run-state by forge host, not bare repoFullName ([#5585](https://github.com/JSONbored/gittensory/issues/5585)) ([b1d3e8d](https://github.com/JSONbored/gittensory/commit/b1d3e8ddb2eff9cce6c86e5ff2f32c6510698d65))
* **miner:** status --json reports the real installed engine version, not the declared range ([#5447](https://github.com/JSONbored/gittensory/issues/5447)) ([eab80bc](https://github.com/JSONbored/gittensory/commit/eab80bcb46cb29c0b79394f5d8a821c2eeca7ab6))
* **miner:** thread githubToken/apiBaseUrl into the PR-disposition poll ([#5320](https://github.com/JSONbored/gittensory/issues/5320)) ([776d59c](https://github.com/JSONbored/gittensory/commit/776d59cc3afc7c199ea80dc197dee9adc39dc60a))
* **miner:** use camelCase readOnly in checkStoreIntegrity's DatabaseSync open ([#5572](https://github.com/JSONbored/gittensory/issues/5572)) ([738c312](https://github.com/JSONbored/gittensory/commit/738c31260a17ca4ace88ded82b869f6211bdcce4))
* **miner:** wire real dollar-cost tracking into the loop's budgetSpent ([#5356](https://github.com/JSONbored/gittensory/issues/5356)) ([7935bb4](https://github.com/JSONbored/gittensory/commit/7935bb4a2c7c5398b3480a59252ad3ad855734e6))
* **miner:** wire recordOwnSubmission's write side into the real attempt pipeline ([#5678](https://github.com/JSONbored/gittensory/issues/5678)) ([ebb540d](https://github.com/JSONbored/gittensory/commit/ebb540d51c5ffa67581fb7e018e2ce9d439b8a30))
* **miner:** write acceptance criteria safely ([#5322](https://github.com/JSONbored/gittensory/issues/5322)) ([dada3ec](https://github.com/JSONbored/gittensory/commit/dada3ecb39fde4f6bd43ba01ca4ee080e642caca))
* **observability:** avoid exposing live AMS ledgers ([#5471](https://github.com/JSONbored/gittensory/issues/5471)) ([2fd9196](https://github.com/JSONbored/gittensory/commit/2fd91962aff3cd43d2afa0f6fcbf51383c524ec5))
