# Changelog

## [3.8.0](https://github.com/JSONbored/loopover/compare/engine-v3.7.0...engine-v3.8.0) (2026-07-23)


### Features

* **engine:** add operator-declared network-egress allowlist to AmsPolicySpec ([#8204](https://github.com/JSONbored/loopover/issues/8204)) ([e3f215d](https://github.com/JSONbored/loopover/commit/e3f215dacabce449aee59878ff8da99af21e9dec))
* **engine:** Neon branch-per-attempt disposable DB fork for AMS attempts ([#8205](https://github.com/JSONbored/loopover/issues/8205)) ([19273b3](https://github.com/JSONbored/loopover/commit/19273b39f2a893ed41740f4c0697af0bc55e1372))

## [3.7.0](https://github.com/JSONbored/loopover/compare/engine-v3.6.0...engine-v3.7.0) (2026-07-23)


### Features

* **engine:** AMS calibration corpus — pair predicted gate verdicts with realized PR outcomes ([#8200](https://github.com/JSONbored/loopover/issues/8200)) ([d40421e](https://github.com/JSONbored/loopover/commit/d40421e226bca36a9c322e1d44826a8f110115f6)), closes [#8183](https://github.com/JSONbored/loopover/issues/8183)

## [3.6.0](https://github.com/JSONbored/loopover/compare/engine-v3.5.0...engine-v3.6.0) (2026-07-23)


### Features

* **gate:** config-driven backtest-regression gate mode, default advisory ([#8105](https://github.com/JSONbored/loopover/issues/8105)) ([#8162](https://github.com/JSONbored/loopover/issues/8162)) ([9c303a6](https://github.com/JSONbored/loopover/commit/9c303a6c9c23f2dafefdeed2a477d52ff72f0a0c))

## [3.5.0](https://github.com/JSONbored/loopover/compare/engine-v3.4.1...engine-v3.5.0) (2026-07-23)


### Features

* **calibration:** deterministic seeded held-out/visible split of the backtest corpus ([#8087](https://github.com/JSONbored/loopover/issues/8087)) ([#8097](https://github.com/JSONbored/loopover/issues/8097)) ([43b02c9](https://github.com/JSONbored/loopover/commit/43b02c9f96282e4c1babea575e8bc3355b6f0905))
* **calibration:** Pareto-floor comparator between two BacktestScoreReports ([#8086](https://github.com/JSONbored/loopover/issues/8086)) ([#8108](https://github.com/JSONbored/loopover/issues/8108)) ([0738a70](https://github.com/JSONbored/loopover/commit/0738a70f595e24578d14b41d07f610fa81003c97))
* **calibration:** pure BacktestCase corpus builder from fired/override events ([#8093](https://github.com/JSONbored/loopover/issues/8093)) ([423a3d1](https://github.com/JSONbored/loopover/commit/423a3d1cfa98d84079a00557d12def3b2aa528c2))
* **calibration:** pure confusion-matrix scorer for candidate rule classifiers ([#8085](https://github.com/JSONbored/loopover/issues/8085)) ([#8098](https://github.com/JSONbored/loopover/issues/8098)) ([d07b057](https://github.com/JSONbored/loopover/commit/d07b057ce0e565417585a44d2b4c03ceeecb2088))
* **calibration:** shared ORB+AMS signal-tracking module, with AMS wired live ([#8079](https://github.com/JSONbored/loopover/issues/8079)) ([873ecf2](https://github.com/JSONbored/loopover/commit/873ecf2cf87e3b43066a6310723d347b001fa48a))
* **engine:** aggregate REGRESSED-verdict track-record statistics from persisted backtest CI results ([#8140](https://github.com/JSONbored/loopover/issues/8140)) ([#8143](https://github.com/JSONbored/loopover/issues/8143)) ([4578fef](https://github.com/JSONbored/loopover/commit/4578fef6afe10702a47f3ef0aaf8203a4e98a47b))
* **engine:** render backtest score and comparison reports as Markdown ([#8088](https://github.com/JSONbored/loopover/issues/8088)) ([#8116](https://github.com/JSONbored/loopover/issues/8116)) ([5553138](https://github.com/JSONbored/loopover/commit/5553138042f13a838bfbca01ea53b09bff2395ab))
* **engine:** represent idea targetRepo as an existing-vs-provision union ([#7710](https://github.com/JSONbored/loopover/issues/7710)) ([d7042ef](https://github.com/JSONbored/loopover/commit/d7042efdee08029c91e37995db34f83bb4d604fe)), closes [#7635](https://github.com/JSONbored/loopover/issues/7635)
* **governor:** page PagerDuty on kill-switch trips ([#8052](https://github.com/JSONbored/loopover/issues/8052)) ([8329069](https://github.com/JSONbored/loopover/commit/832906916b5a9543c399cc4bd577913aa1a9beb7)), closes [#7666](https://github.com/JSONbored/loopover/issues/7666)
* **review:** add a config-as-code content-lane deliverable gate ([#7703](https://github.com/JSONbored/loopover/issues/7703)) ([6c31631](https://github.com/JSONbored/loopover/commit/6c31631ef19a14edd290d4e0ea4954bab7ebb467))
* **review:** add config-as-code settings surface for the issue-planning tool ([#7521](https://github.com/JSONbored/loopover/issues/7521)) ([37e7f86](https://github.com/JSONbored/loopover/commit/37e7f86cfc0a29fbc4a6edba37fccff945c458b1)), closes [#7429](https://github.com/JSONbored/loopover/issues/7429)
* **review:** add opt-in one-shot synchronize-amendment close policy ([#7715](https://github.com/JSONbored/loopover/issues/7715)) ([a964eaf](https://github.com/JSONbored/loopover/commit/a964eaf705529971532fbc56b4c72131a658c20c))
* **review:** backtest confidence-threshold changes against real signal history in ORB's live gate ([#8142](https://github.com/JSONbored/loopover/issues/8142)) ([9258836](https://github.com/JSONbored/loopover/commit/92588368a78119fe6706590eae55036a2db5cfb5))
* **review:** config-as-code manifest override for the loop-escalation sweep cron ([#8018](https://github.com/JSONbored/loopover/issues/8018)) ([#8059](https://github.com/JSONbored/loopover/issues/8059)) ([f3cb090](https://github.com/JSONbored/loopover/commit/f3cb090d8264c3165472d90acea5bcf59f030f3d))
* **review:** same-rule repeat alarm — detection + alert, no autonomous action ([#8092](https://github.com/JSONbored/loopover/issues/8092)) ([321c192](https://github.com/JSONbored/loopover/commit/321c1929ff0f4516b52dbe4dc2d5df9f3b128a16))
* **selfhost:** per-repo opt-out for the active-review reconciliation sweep ([#7880](https://github.com/JSONbored/loopover/issues/7880)) ([b76c91d](https://github.com/JSONbored/loopover/commit/b76c91de597fe6d0f34c57c8f5dd0ef16042fa6d))
* **visual:** automatically detect hover interactions from CSS diffs ([35631c3](https://github.com/JSONbored/loopover/commit/35631c320e094f57839524a79f63963aac55e48c))
* **visual:** automatically detect hover interactions from CSS diffs ([5b8d150](https://github.com/JSONbored/loopover/commit/5b8d150f3d2b584ea4edc8f0d116ed4af75457d4))
* **visual:** capture hover/click interactions as animated GIF evidence ([f4d27e6](https://github.com/JSONbored/loopover/commit/f4d27e6eef4e252092d42e089ca117b42b7d7d65))
* **visual:** capture hover/click/drag interactions as animated GIF evidence ([c5d8671](https://github.com/JSONbored/loopover/commit/c5d867121415c30cdb192ee546380b710b02affd))
* **visual:** maintainer-notify follow-up comment for unrelated visual findings ([5c5c160](https://github.com/JSONbored/loopover/commit/5c5c1603229da9fdba1f5f5308ce5b565b956100))
* **visual:** maintainer-notify follow-up comment for unrelated visual findings ([3c50324](https://github.com/JSONbored/loopover/commit/3c5032452dd4e0f9f6d3bf80b604ff867b35b4ad))
* **visual:** PR-intent-aware vision bug analysis + out-of-scope issue flagging ([#7348](https://github.com/JSONbored/loopover/issues/7348)) ([e622684](https://github.com/JSONbored/loopover/commit/e622684f573e859cabd9ed92553279cb89f7ce6f))
* **visual:** support drag as an interaction-capture action ([36319f9](https://github.com/JSONbored/loopover/commit/36319f9f1746ed5348b2e6917908ac76254a3592))


### Fixes

* **advisory:** redact the check-run leak terms sanitizePublicComment already caught ([39a431b](https://github.com/JSONbored/loopover/commit/39a431bdda222283c46808fbb1d964aaa3deaf42))
* **advisory:** redact the check-run leak terms sanitizePublicComment already caught ([3b956f4](https://github.com/JSONbored/loopover/commit/3b956f4675bbdd265ad7dacc65c6ed17b7a01679)), closes [#7074](https://github.com/JSONbored/loopover/issues/7074)
* **content-lane:** add snake_case aliases to protectedFrontmatterFields ([#7445](https://github.com/JSONbored/loopover/issues/7445)) ([#7478](https://github.com/JSONbored/loopover/issues/7478)) ([37f6e06](https://github.com/JSONbored/loopover/commit/37f6e0694015273ed308f2a455c92c2ecef48918))
* **content-lane:** add snake_case source-url aliases to sourceUrlFields ([#7250](https://github.com/JSONbored/loopover/issues/7250)) ([#7269](https://github.com/JSONbored/loopover/issues/7269)) ([7571a78](https://github.com/JSONbored/loopover/commit/7571a7821a6aee03c2454a52922865727f87afb7))
* **content-lane:** recognize snake_case distribution and primary source fields ([#7492](https://github.com/JSONbored/loopover/issues/7492)) ([90b01f6](https://github.com/JSONbored/loopover/commit/90b01f655f41f792f0e7e53f97b6bafc7aa6611a)), closes [#7446](https://github.com/JSONbored/loopover/issues/7446)
* **draft:** make draftPrClosePolicy config-as-code only ([#7722](https://github.com/JSONbored/loopover/issues/7722)) ([30d039b](https://github.com/JSONbored/loopover/commit/30d039bf3b7822f6a39276c63989557139c3c252))
* **engine:** apply the JSON→YAML fallback in config-lint's canonical parser too ([#7287](https://github.com/JSONbored/loopover/issues/7287)) ([d54bc35](https://github.com/JSONbored/loopover/commit/d54bc35e7ef4b36899883f5f35524c55d7eda740)), closes [#7244](https://github.com/JSONbored/loopover/issues/7244)
* **engine:** cap idea-intake acceptanceHints entry length ([#7285](https://github.com/JSONbored/loopover/issues/7285)) ([93113d7](https://github.com/JSONbored/loopover/commit/93113d716520710fd4b8b92cb94219618449611a)), closes [#7243](https://github.com/JSONbored/loopover/issues/7243)
* **engine:** correct mergeReadinessGateMode doc comment's sub-gate count ([#7288](https://github.com/JSONbored/loopover/issues/7288)) ([341798a](https://github.com/JSONbored/loopover/commit/341798adf4dfe4f76315ac74a1c3832f163945a0))
* **engine:** diffFilePriority's vendored-directory pattern misses vendored/third_party/third-party/bower_components/jspm_packages ([#7540](https://github.com/JSONbored/loopover/issues/7540)) ([1a019ab](https://github.com/JSONbored/loopover/commit/1a019aba8aa71403996468cd87706ae751bfabc3))
* **engine:** don't charge per-file-skipped files against repo-map's aggregate budget ([#7270](https://github.com/JSONbored/loopover/issues/7270)) ([e66f869](https://github.com/JSONbored/loopover/commit/e66f8693d7b079faf38d87d517ce71046c7e788c))
* **engine:** exclude evidence URLs from track-record blocklist scan ([#7483](https://github.com/JSONbored/loopover/issues/7483)) ([ecf57ad](https://github.com/JSONbored/loopover/commit/ecf57adb1a747a20dccd7ea42e1b2edbb9ef534c)), closes [#7444](https://github.com/JSONbored/loopover/issues/7444)
* **engine:** extend [#5831](https://github.com/JSONbored/loopover/issues/5831)'s repo-segment path-safety validation to governor/portfolio/worktree stores ([#7554](https://github.com/JSONbored/loopover/issues/7554)) ([fadb5cc](https://github.com/JSONbored/loopover/commit/fadb5cc92c7c4e6c2c8108beaf70209c45b6c595)), closes [#7525](https://github.com/JSONbored/loopover/issues/7525)
* **engine:** fold idea hints/constraints into the first draft's own explicit criteria ([#7737](https://github.com/JSONbored/loopover/issues/7737)) ([0709850](https://github.com/JSONbored/loopover/commit/0709850a5f59f3319e6636477f9d73393c1dab41)), closes [#7730](https://github.com/JSONbored/loopover/issues/7730)
* **engine:** include inputTokenPattern in ruleSignature's deny-hook identity ([#8126](https://github.com/JSONbored/loopover/issues/8126)) ([fbcba1e](https://github.com/JSONbored/loopover/commit/fbcba1ef3f9c9e5414673c1234955efcff27c273)), closes [#8013](https://github.com/JSONbored/loopover/issues/8013)
* **engine:** normalize computeMetadataDupRisk's self-skip repo comparison ([#7734](https://github.com/JSONbored/loopover/issues/7734)) ([5430064](https://github.com/JSONbored/loopover/commit/5430064f741065f00abc44b58685cedd735511b7)), closes [#7731](https://github.com/JSONbored/loopover/issues/7731)
* **engine:** preserve explicit zero pairwise calibration weights ([#7477](https://github.com/JSONbored/loopover/issues/7477)) ([253dfcb](https://github.com/JSONbored/loopover/commit/253dfcba53247c76cb2a4c9cfd246ce0343b452b)), closes [#7443](https://github.com/JSONbored/loopover/issues/7443)
* **engine:** protect the real post-[#6203](https://github.com/JSONbored/loopover/issues/6203) autonomy/guardrail-config paths, not just their src/ shims ([#8128](https://github.com/JSONbored/loopover/issues/8128)) ([d821cbd](https://github.com/JSONbored/loopover/commit/d821cbdf2b2a4ca1cb62b0fe666dd853a6776036))
* **engine:** redact secret-shaped titles from the public-safe results summary ([#7279](https://github.com/JSONbored/loopover/issues/7279)) ([a0c3b33](https://github.com/JSONbored/loopover/commit/a0c3b33adc2d44f95a9142f70e97579883eb8ff9)), closes [#7249](https://github.com/JSONbored/loopover/issues/7249)
* **engine:** single-source the suspicious-label matcher so bestFitLabels can't drift ([40c6349](https://github.com/JSONbored/loopover/commit/40c63497e4f362e572c3d5f25d92615508121ee2))
* **engine:** single-source the suspicious-label matcher so bestFitLabels can't drift ([0bcd64f](https://github.com/JSONbored/loopover/commit/0bcd64f1746ce7db0a6d94ede09a1e7cc3bf527e)), closes [#7251](https://github.com/JSONbored/loopover/issues/7251)
* **engine:** tolerate a malformed repoFullName per-row in deny-hook blocker history ([c0b4185](https://github.com/JSONbored/loopover/commit/c0b418579366bce1f609a85f9ac4edf00c472f28))
* **engine:** tolerate a malformed repoFullName per-row in deny-hook blocker history ([744de48](https://github.com/JSONbored/loopover/commit/744de48df1b7c06950aa075577287d4e362177ae))
* **engine:** treat a dangling dependsOn id as unsatisfied in plan-export ordering ([#7738](https://github.com/JSONbored/loopover/issues/7738)) ([e8577cb](https://github.com/JSONbored/loopover/commit/e8577cb28d8bada53b1dd4359fda8f67e07e1e33)), closes [#7729](https://github.com/JSONbored/loopover/issues/7729)
* **engine:** trim attempt-id slug after truncation ([#7551](https://github.com/JSONbored/loopover/issues/7551)) ([ed183a3](https://github.com/JSONbored/loopover/commit/ed183a3d5faf1ef2cc5da83f2e836a6ea7a3ef9b))
* **miner:** carry real assignees through the discovery-index supplement so the repo-owner exclusion applies ([#7488](https://github.com/JSONbored/loopover/issues/7488)) ([e7cbb1b](https://github.com/JSONbored/loopover/commit/e7cbb1b6cc4e80c8ea1bac4953a07555e437d15b)), closes [#7442](https://github.com/JSONbored/loopover/issues/7442)
* **miner:** clamp out-of-contract usage from the iterate-loop running totals ([#7246](https://github.com/JSONbored/loopover/issues/7246)) ([#7272](https://github.com/JSONbored/loopover/issues/7272)) ([d6134b2](https://github.com/JSONbored/loopover/commit/d6134b20a74471b73d6b2811baa1e09986bfce43))
* **miner:** grant Read/Bash in the agent-sdk driver's tool allowlist ([#7245](https://github.com/JSONbored/loopover/issues/7245)) ([#7276](https://github.com/JSONbored/loopover/issues/7276)) ([d0617d1](https://github.com/JSONbored/loopover/commit/d0617d1b72ca911223602740f90c062e8acdf965))
* **review:** block the RFC 6598 CGNAT range in both safe-url twin guards ([3c72fce](https://github.com/JSONbored/loopover/commit/3c72fce9146804b1dd40afe9c8929b5b60f36e5c))
* **review:** block the RFC 6598 CGNAT range in both safe-url twin guards ([3630700](https://github.com/JSONbored/loopover/commit/3630700ef0938b9699a55651157d71cf99a9d529)), closes [#7253](https://github.com/JSONbored/loopover/issues/7253)
* **review:** close SSRF and lockfile-tamper detection gaps ([#7826](https://github.com/JSONbored/loopover/issues/7826)) ([0ff0b8f](https://github.com/JSONbored/loopover/commit/0ff0b8fb5dff9099bc136623e0f01fa7966603fc))
* **review:** correct the stale-base grounding fact and close the mergeable_state blind spot it depends on ([#7686](https://github.com/JSONbored/loopover/issues/7686)) ([9e6691a](https://github.com/JSONbored/loopover/commit/9e6691a963016a0ef14833799c8119b4c87b4dfc))
* **review:** ORB fairness analytics -- broken accuracy metric, public report, contributor trust profiles ([#7581](https://github.com/JSONbored/loopover/issues/7581)) ([87843ab](https://github.com/JSONbored/loopover/commit/87843abdb72e0178cbf4c9b743fee64df3f80105))
* **review:** reject plain ws: in isSafeEndpointUrl, matching its own "secure" doc comment ([#8131](https://github.com/JSONbored/loopover/issues/8131)) ([24929e3](https://github.com/JSONbored/loopover/commit/24929e3f5427e42376ab295c6668df54b746a92f))
* **review:** stop bare hotkey/coldkey mentions from false-positiving as secret leaks ([#7994](https://github.com/JSONbored/loopover/issues/7994)) ([c73f518](https://github.com/JSONbored/loopover/commit/c73f518fad8b99e81135869a19cd756413556cce))
* **selfhost:** stop delayed webhooks from resurrecting closed PRs' review tracking ([#7839](https://github.com/JSONbored/loopover/issues/7839)) ([6ea4e28](https://github.com/JSONbored/loopover/commit/6ea4e284684a89bc10575bc80a0e33d0ca8ac0d2))
* **signals:** single-source predicted-gate-engine isCodeFile so .kts counts as code ([#7273](https://github.com/JSONbored/loopover/issues/7273)) ([c743eca](https://github.com/JSONbored/loopover/commit/c743ecab1cf3abde4861e67ee8a43012fa6ca65f)), closes [#7252](https://github.com/JSONbored/loopover/issues/7252)
* **visual:** address adversarial review findings on interaction capture ([26a7a3b](https://github.com/JSONbored/loopover/commit/26a7a3b24e45d37904211201d51ea2937965a19c))

## [3.4.0](https://github.com/JSONbored/loopover/compare/engine-v3.3.0...engine-v3.4.0) (2026-07-18)


### Features

* **api:** add a REST route + CLI mirror for loopover_check_test_evidence ([#6810](https://github.com/JSONbored/loopover/issues/6810)) ([d45d8fd](https://github.com/JSONbored/loopover/commit/d45d8fd6eb12c1f85b66912097d1a562e900ad13)), closes [#6749](https://github.com/JSONbored/loopover/issues/6749)
* **config:** make sweepWatchdog staleness threshold configurable ([#6594](https://github.com/JSONbored/loopover/issues/6594)) ([#6639](https://github.com/JSONbored/loopover/issues/6639)) ([0e313c8](https://github.com/JSONbored/loopover/commit/0e313c8735bc02036a769845c8d0e70427329582))
* **engine:** add selfLoopAutonomy to AmsPolicySpec ([bd614bf](https://github.com/JSONbored/loopover/commit/bd614bf2fccabceb7b0bc84ec0095c3a73742894))
* **engine:** add selfLoopAutonomy to AmsPolicySpec ([880b973](https://github.com/JSONbored/loopover/commit/880b97362d793afc2fc6d5e0803204019869b457)), closes [#6559](https://github.com/JSONbored/loopover/issues/6559)
* **mcp:** CLI mirror for loopover_draft_pr_body ([#6974](https://github.com/JSONbored/loopover/issues/6974)) ([13bd48b](https://github.com/JSONbored/loopover/commit/13bd48bb9342f993916b8deb79cf287994b41aaf))
* **mcp:** CLI mirror for loopover_explain_gate_disposition ([#6966](https://github.com/JSONbored/loopover/issues/6966)) ([4966070](https://github.com/JSONbored/loopover/commit/4966070447dd45fcd4d5a2549a7e0713ad10c678))
* **miner:** add read-only chat grounding over the existing miner MCP tools ([#6570](https://github.com/JSONbored/loopover/issues/6570)) ([ed16fef](https://github.com/JSONbored/loopover/commit/ed16fef8508753b232bca4ec76fa504f33da3600)), closes [#6517](https://github.com/JSONbored/loopover/issues/6517)
* **miner:** consult selfLoopAutonomy in decideNextAction's pass-to-handoff step ([#6581](https://github.com/JSONbored/loopover/issues/6581)) ([7a275c7](https://github.com/JSONbored/loopover/commit/7a275c7558c712a49a334397cef98a0509778c6f)), closes [#6560](https://github.com/JSONbored/loopover/issues/6560)
* **orb:** trust-gate inbound federated bundles per the [#6477](https://github.com/JSONbored/loopover/issues/6477) key-trust design ([#6649](https://github.com/JSONbored/loopover/issues/6649)) ([729254a](https://github.com/JSONbored/loopover/commit/729254ad01459f2e51bd4a4936cbc5b2fb0b398b))
* **review:** bridge a submitter's AMS track record into ORB reputation, upgrade-only ([#6566](https://github.com/JSONbored/loopover/issues/6566)) ([97a1938](https://github.com/JSONbored/loopover/commit/97a19380a0f52a92991625805c76318da5b57418)), closes [#6485](https://github.com/JSONbored/loopover/issues/6485)
* **selfhost:** make LOOPOVER_SWEEP_WATCHDOG and LOOPOVER_PR_RECONCILIATION .loopover.yml-controllable ([3ac9501](https://github.com/JSONbored/loopover/commit/3ac9501e1cc48f913f236b6bbe9335e794f0b848))
* **selfhost:** make LOOPOVER_SWEEP_WATCHDOG and LOOPOVER_PR_RECONCILIATION .loopover.yml-controllable ([7ca394a](https://github.com/JSONbored/loopover/commit/7ca394a1eb650518e8ef324aa35caacd8070bfbb)), closes [#6558](https://github.com/JSONbored/loopover/issues/6558)


### Fixes

* **advisory:** redact the check-run leak terms sanitizePublicComment already caught ([39a431b](https://github.com/JSONbored/loopover/commit/39a431bdda222283c46808fbb1d964aaa3deaf42))
* **advisory:** redact the check-run leak terms sanitizePublicComment already caught ([3b956f4](https://github.com/JSONbored/loopover/commit/3b956f4675bbdd265ad7dacc65c6ed17b7a01679)), closes [#7074](https://github.com/JSONbored/loopover/issues/7074)
* **config:** recognize federatedIntelligence manifest block in lint and preview ([95ba59a](https://github.com/JSONbored/loopover/commit/95ba59aa2731dc3802ca90ea9326c9ca8f7e2916))
* **config:** recognize federatedIntelligence manifest block in lint and preview ([1c80fb8](https://github.com/JSONbored/loopover/commit/1c80fb84b88c2ce4028e8435056025bfca4da914))
* correct four stale 'improvementSignal not wired yet' comments ([#6691](https://github.com/JSONbored/loopover/issues/6691)) ([2d493cd](https://github.com/JSONbored/loopover/commit/2d493cd833059981e69d9008e771f970c5cc6f21))
* **discovery-index:** cap the untrusted response candidate list ([#6774](https://github.com/JSONbored/loopover/issues/6774)) ([ff46459](https://github.com/JSONbored/loopover/commit/ff464596ec7c2f07ffe597ca79c5cf2685090e1f))
* **discovery-index:** cap the untrusted response candidate list ([#6774](https://github.com/JSONbored/loopover/issues/6774)) ([ca5c81a](https://github.com/JSONbored/loopover/commit/ca5c81afb97a1a8ac5e183ef0239799c50ed9b51))
* **engine:** align predicted-gate collision risk with live-gate twin ([#6671](https://github.com/JSONbored/loopover/issues/6671)) ([2df475c](https://github.com/JSONbored/loopover/commit/2df475c942048e687be3c4065cb60a66c129b965)), closes [#6629](https://github.com/JSONbored/loopover/issues/6629)
* **engine:** cap predicted-gate's local linked-issue extractor at the canonical 50 ([#6771](https://github.com/JSONbored/loopover/issues/6771)) ([fcf41bc](https://github.com/JSONbored/loopover/commit/fcf41bc27eb05fc9382216086f2cc97ed6b1342c))
* **engine:** cap predicted-gate's local linked-issue extractor at the canonical 50 ([#6771](https://github.com/JSONbored/loopover/issues/6771)) ([0fe3e99](https://github.com/JSONbored/loopover/commit/0fe3e99f213fa84e0fe8f9d28614f414b62ab022))
* **engine:** exclude inline code spans in predicted-gate extractLinkedIssueNumbers ([e6ef456](https://github.com/JSONbored/loopover/commit/e6ef4569ba6f970e0105bed678bfdf096dd5c1e8))
* **engine:** exclude inline code spans in predicted-gate extractLinkedIssueNumbers ([#6630](https://github.com/JSONbored/loopover/issues/6630)) ([6ac8c1f](https://github.com/JSONbored/loopover/commit/6ac8c1fed33a58ccea3846551bc74c6cdadbe275))
* **engine:** filter maintainer-authored manifest fields out of public findings ([99aeead](https://github.com/JSONbored/loopover/commit/99aeeadb23f5d5360d8d5f9bcd16d7bd0a967209))
* **engine:** filter maintainer-authored manifest fields out of public findings ([5f5a6fc](https://github.com/JSONbored/loopover/commit/5f5a6fca9b4fa844476d3cbf0ce15f683e1865d5)), closes [#6770](https://github.com/JSONbored/loopover/issues/6770)
* **engine:** floor percentComplete at 0 so it stays in its documented 0-100 range ([#6773](https://github.com/JSONbored/loopover/issues/6773)) ([ab9cb63](https://github.com/JSONbored/loopover/commit/ab9cb638bcbb363583b942da634ce5ead1346632))
* **engine:** floor percentComplete at 0 so it stays in its documented 0-100 range ([#6773](https://github.com/JSONbored/loopover/issues/6773)) ([84543ed](https://github.com/JSONbored/loopover/commit/84543ed574cf452a8dc27db895304986e0dda0bc))
* **engine:** honor no-issue rationale in predicted preflight ([#6645](https://github.com/JSONbored/loopover/issues/6645)) ([8b20ad6](https://github.com/JSONbored/loopover/commit/8b20ad63a80cce0f1bac6cf4a1e1226a830dbed8)), closes [#6628](https://github.com/JSONbored/loopover/issues/6628)
* **engine:** treat non-finite calibration inputs as cold-start / safe clamp ([#6651](https://github.com/JSONbored/loopover/issues/6651)) ([d4b5a81](https://github.com/JSONbored/loopover/commit/d4b5a814a326a5a80c4d4cb64aea6f312c635a18)), closes [#6627](https://github.com/JSONbored/loopover/issues/6627)
* **miner:** forward HOME and the real coding-agent credential to CLI subprocesses ([4a852de](https://github.com/JSONbored/loopover/commit/4a852de548963d6e8c5b858af8c36880d3132ab6))
* **miner:** forward HOME and the real coding-agent credential to CLI subprocesses ([e327370](https://github.com/JSONbored/loopover/commit/e327370d963ae2d2a34988bdf5b10d2cee6a79e4)), closes [#6875](https://github.com/JSONbored/loopover/issues/6875)
* **miner:** grant the claude-cli driver Read/Bash access, not just edits ([615dd46](https://github.com/JSONbored/loopover/commit/615dd4669c3b22774fe5a393be810946e722f2d4))
* **miner:** grant the claude-cli driver Read/Bash access, not just edits ([664aebe](https://github.com/JSONbored/loopover/commit/664aebe79f0570f904bc93964f40b2c3e18c4e51)), closes [#6840](https://github.com/JSONbored/loopover/issues/6840)
* **signals:** make shouldPublishPrIntelligenceComment respect commentMode for oss_maintainer ([#6776](https://github.com/JSONbored/loopover/issues/6776)) ([#6853](https://github.com/JSONbored/loopover/issues/6853)) ([fa8f577](https://github.com/JSONbored/loopover/commit/fa8f577de65390863248380707a85b6d5b776b28))
* **test:** update grafana dashboard assertions for the historical-continuity query rewrite ([8cd0b24](https://github.com/JSONbored/loopover/commit/8cd0b2489e1b4f1803a310951f53f25d94ff6ddb))
* **track-record:** exempt the GitHub login line from the public-field blocklist scan ([#6772](https://github.com/JSONbored/loopover/issues/6772)) ([4328d08](https://github.com/JSONbored/loopover/commit/4328d080f6ba3d5b0a1287861554409ba8ea8d24))
* **track-record:** exempt the GitHub login line from the public-field blocklist scan ([#6772](https://github.com/JSONbored/loopover/issues/6772)) ([7ed6328](https://github.com/JSONbored/loopover/commit/7ed6328482b76325f8674b05c537829cc06f3bef))

## [3.3.0](https://github.com/JSONbored/loopover/compare/engine-v3.2.3...engine-v3.3.0) (2026-07-18)


### Chores

* **engine:** Synchronize engine-and-dependents versions

## [3.2.3](https://github.com/JSONbored/loopover/compare/engine-v3.2.2...engine-v3.2.3) (2026-07-18)


### Fixes

* **advisory:** redact the check-run leak terms sanitizePublicComment already caught ([39a431b](https://github.com/JSONbored/loopover/commit/39a431bdda222283c46808fbb1d964aaa3deaf42))
* **advisory:** redact the check-run leak terms sanitizePublicComment already caught ([3b956f4](https://github.com/JSONbored/loopover/commit/3b956f4675bbdd265ad7dacc65c6ed17b7a01679)), closes [#7074](https://github.com/JSONbored/loopover/issues/7074)
* **config:** recognize federatedIntelligence manifest block in lint and preview ([95ba59a](https://github.com/JSONbored/loopover/commit/95ba59aa2731dc3802ca90ea9326c9ca8f7e2916))
* **config:** recognize federatedIntelligence manifest block in lint and preview ([1c80fb8](https://github.com/JSONbored/loopover/commit/1c80fb84b88c2ce4028e8435056025bfca4da914))

## [3.2.2](https://github.com/JSONbored/loopover/compare/engine-v3.2.1...engine-v3.2.2) (2026-07-17)


### Fixes

* **advisory:** redact the check-run leak terms sanitizePublicComment already caught ([39a431b](https://github.com/JSONbored/loopover/commit/39a431bdda222283c46808fbb1d964aaa3deaf42))
* **advisory:** redact the check-run leak terms sanitizePublicComment already caught ([3b956f4](https://github.com/JSONbored/loopover/commit/3b956f4675bbdd265ad7dacc65c6ed17b7a01679)), closes [#7074](https://github.com/JSONbored/loopover/issues/7074)
* **config:** recognize federatedIntelligence manifest block in lint and preview ([95ba59a](https://github.com/JSONbored/loopover/commit/95ba59aa2731dc3802ca90ea9326c9ca8f7e2916))
* **config:** recognize federatedIntelligence manifest block in lint and preview ([1c80fb8](https://github.com/JSONbored/loopover/commit/1c80fb84b88c2ce4028e8435056025bfca4da914))

## [3.2.1](https://github.com/JSONbored/loopover/compare/engine-v3.2.0...engine-v3.2.1) (2026-07-17)


### Fixes

* **config:** recognize federatedIntelligence manifest block in lint and preview ([95ba59a](https://github.com/JSONbored/loopover/commit/95ba59aa2731dc3802ca90ea9326c9ca8f7e2916))
* **config:** recognize federatedIntelligence manifest block in lint and preview ([1c80fb8](https://github.com/JSONbored/loopover/commit/1c80fb84b88c2ce4028e8435056025bfca4da914))

## [3.2.0](https://github.com/JSONbored/loopover/compare/engine-v3.1.1...engine-v3.2.0) (2026-07-17)


### Features

* **api:** add a REST route + CLI mirror for loopover_check_test_evidence ([#6810](https://github.com/JSONbored/loopover/issues/6810)) ([d45d8fd](https://github.com/JSONbored/loopover/commit/d45d8fd6eb12c1f85b66912097d1a562e900ad13)), closes [#6749](https://github.com/JSONbored/loopover/issues/6749)
* **config:** make sweepWatchdog staleness threshold configurable ([#6594](https://github.com/JSONbored/loopover/issues/6594)) ([#6639](https://github.com/JSONbored/loopover/issues/6639)) ([0e313c8](https://github.com/JSONbored/loopover/commit/0e313c8735bc02036a769845c8d0e70427329582))
* **engine:** add a stable, versioned getTrackRecordSummary read API ([2958302](https://github.com/JSONbored/loopover/commit/2958302ccc0dedbc7665ca3d19e6333a110bff4b))
* **engine:** add selfLoopAutonomy to AmsPolicySpec ([bd614bf](https://github.com/JSONbored/loopover/commit/bd614bf2fccabceb7b0bc84ec0095c3a73742894))
* **engine:** add selfLoopAutonomy to AmsPolicySpec ([880b973](https://github.com/JSONbored/loopover/commit/880b97362d793afc2fc6d5e0803204019869b457)), closes [#6559](https://github.com/JSONbored/loopover/issues/6559)
* **engine:** define a shared TrustSignal type for ORB/AMS reputation bridging ([7ee0670](https://github.com/JSONbored/loopover/commit/7ee067095cc28f97b6a18de7a84e8b1089266bc1))
* **engine:** define a shared TrustSignal type for ORB/AMS reputation bridging ([145a279](https://github.com/JSONbored/loopover/commit/145a279ebcb03056d6d17bfc9e48f03e4f9c3922))
* **mcp:** CLI mirror for loopover_draft_pr_body ([#6974](https://github.com/JSONbored/loopover/issues/6974)) ([13bd48b](https://github.com/JSONbored/loopover/commit/13bd48bb9342f993916b8deb79cf287994b41aaf))
* **mcp:** CLI mirror for loopover_explain_gate_disposition ([#6966](https://github.com/JSONbored/loopover/issues/6966)) ([4966070](https://github.com/JSONbored/loopover/commit/4966070447dd45fcd4d5a2549a7e0713ad10c678))
* **mcp:** validate .loopover.yml offline by extracting buildFocusManifestValidation into @loopover/engine ([#6425](https://github.com/JSONbored/loopover/issues/6425)) ([22faecf](https://github.com/JSONbored/loopover/commit/22faecfe8eceb3a1762509b81ac9c6b26606d374)), closes [#6269](https://github.com/JSONbored/loopover/issues/6269)
* **miner:** add read-only chat grounding over the existing miner MCP tools ([#6570](https://github.com/JSONbored/loopover/issues/6570)) ([ed16fef](https://github.com/JSONbored/loopover/commit/ed16fef8508753b232bca4ec76fa504f33da3600)), closes [#6517](https://github.com/JSONbored/loopover/issues/6517)
* **miner:** consult selfLoopAutonomy in decideNextAction's pass-to-handoff step ([#6581](https://github.com/JSONbored/loopover/issues/6581)) ([7a275c7](https://github.com/JSONbored/loopover/commit/7a275c7558c712a49a334397cef98a0509778c6f)), closes [#6560](https://github.com/JSONbored/loopover/issues/6560)
* **orb:** add the opt-in federated collector transport client (push/pull) ([#6537](https://github.com/JSONbored/loopover/issues/6537)) ([8ab3472](https://github.com/JSONbored/loopover/commit/8ab3472d4465a8a722e3267b0af2e233ff567e6b)), closes [#6479](https://github.com/JSONbored/loopover/issues/6479)
* **orb:** export a signed, anonymized federated calibration bundle (opt-in) ([#6505](https://github.com/JSONbored/loopover/issues/6505)) ([53ce7b2](https://github.com/JSONbored/loopover/commit/53ce7b2cfe1a4a59c3a11a6a51add350469ffe7b)), closes [#6478](https://github.com/JSONbored/loopover/issues/6478)
* **orb:** trust-gate inbound federated bundles per the [#6477](https://github.com/JSONbored/loopover/issues/6477) key-trust design ([#6649](https://github.com/JSONbored/loopover/issues/6649)) ([729254a](https://github.com/JSONbored/loopover/commit/729254ad01459f2e51bd4a4936cbc5b2fb0b398b))
* **review:** bridge a submitter's AMS track record into ORB reputation, upgrade-only ([#6566](https://github.com/JSONbored/loopover/issues/6566)) ([97a1938](https://github.com/JSONbored/loopover/commit/97a19380a0f52a92991625805c76318da5b57418)), closes [#6485](https://github.com/JSONbored/loopover/issues/6485)
* **review:** give LOOPOVER_REVIEW_PLANNER a per-repo config override ([b429292](https://github.com/JSONbored/loopover/commit/b42929212f5f2b6f257f15491f62848d00568e80))
* **review:** give LOOPOVER_REVIEW_PLANNER a per-repo config override ([73eb87d](https://github.com/JSONbored/loopover/commit/73eb87d3116777ddeaa6d034d2615a6e5011d468))
* **selfhost:** make LOOPOVER_REVIEW_DRAFT and LOOPOVER_AUTO_FILE_DRIFT_ISSUES .loopover.yml-controllable ([85e8301](https://github.com/JSONbored/loopover/commit/85e8301aa93c8c5ee6831255ced389a0bda180ce))
* **selfhost:** make LOOPOVER_REVIEW_DRAFT and LOOPOVER_AUTO_FILE_DRIFT_ISSUES .loopover.yml-controllable ([0d3f4cb](https://github.com/JSONbored/loopover/commit/0d3f4cb06c6f3ea160f94a35ffa9b25d5bab7bea))
* **selfhost:** make LOOPOVER_REVIEW_OPS and LOOPOVER_PUBLIC_STATS .loopover.yml-controllable ([87c3e6b](https://github.com/JSONbored/loopover/commit/87c3e6bd60899a0f6c717d6ca4af7713809772e4))
* **selfhost:** make LOOPOVER_REVIEW_OPS and LOOPOVER_PUBLIC_STATS .loopover.yml-controllable ([bc2f899](https://github.com/JSONbored/loopover/commit/bc2f899e0bace0d8035c96db434f2eb70e7bd00f))
* **selfhost:** make LOOPOVER_SWEEP_WATCHDOG and LOOPOVER_PR_RECONCILIATION .loopover.yml-controllable ([3ac9501](https://github.com/JSONbored/loopover/commit/3ac9501e1cc48f913f236b6bbe9335e794f0b848))
* **selfhost:** make LOOPOVER_SWEEP_WATCHDOG and LOOPOVER_PR_RECONCILIATION .loopover.yml-controllable ([7ca394a](https://github.com/JSONbored/loopover/commit/7ca394a1eb650518e8ef324aa35caacd8070bfbb)), closes [#6558](https://github.com/JSONbored/loopover/issues/6558)


### Fixes

* **config:** scrub remaining pre-rename gittensory references ([23152da](https://github.com/JSONbored/loopover/commit/23152dafcc1bbb329bdc63606dee311cdb4267cf))
* **config:** scrub remaining pre-rename gittensory references ([e4b0f8c](https://github.com/JSONbored/loopover/commit/e4b0f8cd4e24cbc7c14b157e7d660f73adca2115))
* correct four stale 'improvementSignal not wired yet' comments ([#6691](https://github.com/JSONbored/loopover/issues/6691)) ([2d493cd](https://github.com/JSONbored/loopover/commit/2d493cd833059981e69d9008e771f970c5cc6f21))
* **discovery-index:** cap the untrusted response candidate list ([#6774](https://github.com/JSONbored/loopover/issues/6774)) ([ff46459](https://github.com/JSONbored/loopover/commit/ff464596ec7c2f07ffe597ca79c5cf2685090e1f))
* **discovery-index:** cap the untrusted response candidate list ([#6774](https://github.com/JSONbored/loopover/issues/6774)) ([ca5c81a](https://github.com/JSONbored/loopover/commit/ca5c81afb97a1a8ac5e183ef0239799c50ed9b51))
* **engine:** align predicted-gate collision risk with live-gate twin ([#6671](https://github.com/JSONbored/loopover/issues/6671)) ([2df475c](https://github.com/JSONbored/loopover/commit/2df475c942048e687be3c4065cb60a66c129b965)), closes [#6629](https://github.com/JSONbored/loopover/issues/6629)
* **engine:** cap predicted-gate's local linked-issue extractor at the canonical 50 ([#6771](https://github.com/JSONbored/loopover/issues/6771)) ([fcf41bc](https://github.com/JSONbored/loopover/commit/fcf41bc27eb05fc9382216086f2cc97ed6b1342c))
* **engine:** cap predicted-gate's local linked-issue extractor at the canonical 50 ([#6771](https://github.com/JSONbored/loopover/issues/6771)) ([0fe3e99](https://github.com/JSONbored/loopover/commit/0fe3e99f213fa84e0fe8f9d28614f414b62ab022))
* **engine:** exclude inline code spans in predicted-gate extractLinkedIssueNumbers ([e6ef456](https://github.com/JSONbored/loopover/commit/e6ef4569ba6f970e0105bed678bfdf096dd5c1e8))
* **engine:** exclude inline code spans in predicted-gate extractLinkedIssueNumbers ([#6630](https://github.com/JSONbored/loopover/issues/6630)) ([6ac8c1f](https://github.com/JSONbored/loopover/commit/6ac8c1fed33a58ccea3846551bc74c6cdadbe275))
* **engine:** exclude lockfiles and dependency manifests from trivial-churn detection ([ed882b7](https://github.com/JSONbored/loopover/commit/ed882b76e57af0212298805dc0cede66d6e4d62b))
* **engine:** exclude lockfiles and dependency manifests from trivial-churn detection ([a2d8306](https://github.com/JSONbored/loopover/commit/a2d8306debbc3c0aabb09751a4eea90333d598d5))
* **engine:** exempt generated/vendored/minified files from missing-test-evidence signal ([2c59771](https://github.com/JSONbored/loopover/commit/2c59771a4bfc5a81a897619c3331e1f72ccb616b))
* **engine:** exempt generated/vendored/minified files from the missing-test-evidence signal ([203e7c7](https://github.com/JSONbored/loopover/commit/203e7c76bed2acaedf6f236928b0da33703c14c4))
* **engine:** filter maintainer-authored manifest fields out of public findings ([99aeead](https://github.com/JSONbored/loopover/commit/99aeeadb23f5d5360d8d5f9bcd16d7bd0a967209))
* **engine:** filter maintainer-authored manifest fields out of public findings ([5f5a6fc](https://github.com/JSONbored/loopover/commit/5f5a6fca9b4fa844476d3cbf0ce15f683e1865d5)), closes [#6770](https://github.com/JSONbored/loopover/issues/6770)
* **engine:** floor percentComplete at 0 so it stays in its documented 0-100 range ([#6773](https://github.com/JSONbored/loopover/issues/6773)) ([ab9cb63](https://github.com/JSONbored/loopover/commit/ab9cb638bcbb363583b942da634ce5ead1346632))
* **engine:** floor percentComplete at 0 so it stays in its documented 0-100 range ([#6773](https://github.com/JSONbored/loopover/issues/6773)) ([84543ed](https://github.com/JSONbored/loopover/commit/84543ed574cf452a8dc27db895304986e0dda0bc))
* **engine:** honor no-issue rationale in predicted preflight ([#6645](https://github.com/JSONbored/loopover/issues/6645)) ([8b20ad6](https://github.com/JSONbored/loopover/commit/8b20ad63a80cce0f1bac6cf4a1e1226a830dbed8)), closes [#6628](https://github.com/JSONbored/loopover/issues/6628)
* **engine:** stop the collision report using unscoped issue.linkedPrs for risk escalation ([d95d4a6](https://github.com/JSONbored/loopover/commit/d95d4a6b5b6eb9a4cfc713dbca290df0cd2943dd))
* **engine:** stop unscoped issue.linkedPrs from inflating collision risk ([38fec26](https://github.com/JSONbored/loopover/commit/38fec26826bc1d5f95fe1ececc2eb11870a601af))
* **engine:** treat non-finite calibration inputs as cold-start / safe clamp ([#6651](https://github.com/JSONbored/loopover/issues/6651)) ([d4b5a81](https://github.com/JSONbored/loopover/commit/d4b5a814a326a5a80c4d4cb64aea6f312c635a18)), closes [#6627](https://github.com/JSONbored/loopover/issues/6627)
* **miner:** forward HOME and the real coding-agent credential to CLI subprocesses ([4a852de](https://github.com/JSONbored/loopover/commit/4a852de548963d6e8c5b858af8c36880d3132ab6))
* **miner:** forward HOME and the real coding-agent credential to CLI subprocesses ([e327370](https://github.com/JSONbored/loopover/commit/e327370d963ae2d2a34988bdf5b10d2cee6a79e4)), closes [#6875](https://github.com/JSONbored/loopover/issues/6875)
* **miner:** grant the claude-cli driver Read/Bash access, not just edits ([615dd46](https://github.com/JSONbored/loopover/commit/615dd4669c3b22774fe5a393be810946e722f2d4))
* **miner:** grant the claude-cli driver Read/Bash access, not just edits ([664aebe](https://github.com/JSONbored/loopover/commit/664aebe79f0570f904bc93964f40b2c3e18c4e51)), closes [#6840](https://github.com/JSONbored/loopover/issues/6840)
* **review:** close cohort/score gaps in public-comment sanitizers ([b2c66d7](https://github.com/JSONbored/loopover/commit/b2c66d7296a62b24323e80bb5ab551e1cf17f532))
* **review:** correlate screenshot-table presence-mode evidence to the PR head SHA ([9bf58f6](https://github.com/JSONbored/loopover/commit/9bf58f6e2adf01833928c91249d09f95011219bc))
* **review:** correlate screenshot-table presence-mode evidence to the PR head SHA ([8c5230a](https://github.com/JSONbored/loopover/commit/8c5230a1832d3090ac9f2bcff46bdfa999ca4936))
* **review:** redact cohort/miner-originated/human-originated/raw-trust and bare score in public sanitizers ([77fd09e](https://github.com/JSONbored/loopover/commit/77fd09efa6ab1799e4267226b8d618fe8622a32a))
* **signals:** make shouldPublishPrIntelligenceComment respect commentMode for oss_maintainer ([#6776](https://github.com/JSONbored/loopover/issues/6776)) ([#6853](https://github.com/JSONbored/loopover/issues/6853)) ([fa8f577](https://github.com/JSONbored/loopover/commit/fa8f577de65390863248380707a85b6d5b776b28))
* **track-record:** exempt the GitHub login line from the public-field blocklist scan ([#6772](https://github.com/JSONbored/loopover/issues/6772)) ([4328d08](https://github.com/JSONbored/loopover/commit/4328d080f6ba3d5b0a1287861554409ba8ea8d24))
* **track-record:** exempt the GitHub login line from the public-field blocklist scan ([#6772](https://github.com/JSONbored/loopover/issues/6772)) ([7ed6328](https://github.com/JSONbored/loopover/commit/7ed6328482b76325f8674b05c537829cc06f3bef))

## [3.1.1](https://github.com/JSONbored/loopover/compare/engine-v3.1.0...engine-v3.1.1) (2026-07-14)


### Fixes

* **review:** restore engine-parity after gittensory rename drift ([#5892](https://github.com/JSONbored/loopover/issues/5892)) ([f7004b9](https://github.com/JSONbored/loopover/commit/f7004b9afeb81e9b4c3290482a71dda43e850590))

## [3.1.0](https://github.com/JSONbored/loopover/compare/engine-v3.0.0...engine-v3.1.0) (2026-07-14)


### Features

* **engine:** add a load-testing harness for iterate-loop under concurrent load ([#5781](https://github.com/JSONbored/loopover/issues/5781)) ([4b6b5c6](https://github.com/JSONbored/loopover/commit/4b6b5c67f79b8c7610f1132e37779ca2bf1cdc8e)), closes [#5224](https://github.com/JSONbored/loopover/issues/5224)
* **engine:** extract content-lane's pure leaf modules to loopover-engine ([#5775](https://github.com/JSONbored/loopover/issues/5775)) ([60ed3cd](https://github.com/JSONbored/loopover/commit/60ed3cd70560caa01fc633ab53df2d22eaf6ecec)), closes [#4880](https://github.com/JSONbored/loopover/issues/4880)
* **engine:** extract settings leaf modules to loopover-engine ([#5779](https://github.com/JSONbored/loopover/issues/5779)) ([b570c11](https://github.com/JSONbored/loopover/commit/b570c114431bc4e94caec1dfc4473325cabddc93)), closes [#4879](https://github.com/JSONbored/loopover/issues/4879)
* **engine:** per-tenant configuration layer ([#5804](https://github.com/JSONbored/loopover/issues/5804)) ([1fd8519](https://github.com/JSONbored/loopover/commit/1fd851902bfd5f59b8b064c58e1a880f29eac8bf)), closes [#4787](https://github.com/JSONbored/loopover/issues/4787)
* **engine:** per-tenant resource quota evaluation ([#5801](https://github.com/JSONbored/loopover/issues/5801)) ([db74aa3](https://github.com/JSONbored/loopover/commit/db74aa3fd73c8ffab9d2230ba43ef8addc847085)), closes [#4796](https://github.com/JSONbored/loopover/issues/4796)
* **mcp:** add the idea-intake bridge and loopover_intake_idea tool ([#5792](https://github.com/JSONbored/loopover/issues/5792)) ([d60481e](https://github.com/JSONbored/loopover/commit/d60481ec33c6004d8f59857a406ffd69695c9917)), closes [#4798](https://github.com/JSONbored/loopover/issues/4798)
* **mcp:** deliver a completed loop iteration as a customer results payload ([#5797](https://github.com/JSONbored/loopover/issues/5797)) ([9b3f4b2](https://github.com/JSONbored/loopover/commit/9b3f4b276636fd119dcf973aa71003bd50df4d7e)), closes [#4801](https://github.com/JSONbored/loopover/issues/4801)
* **mcp:** evaluate when a rented loop should escalate to a human ([#5806](https://github.com/JSONbored/loopover/issues/5806)) ([90f477e](https://github.com/JSONbored/loopover/commit/90f477e9e060b15244f9aa47d81665bfd87fd664))
* **mcp:** route ideas through intake into a loop claim plan ([#5795](https://github.com/JSONbored/loopover/issues/5795)) ([48d2a39](https://github.com/JSONbored/loopover/commit/48d2a3970e7dffb6c93dba1d0538fe401ec308a9)), closes [#4799](https://github.com/JSONbored/loopover/issues/4799)
* **mcp:** stream loop progress to the customer via a progress snapshot ([#5798](https://github.com/JSONbored/loopover/issues/5798)) ([96b8c42](https://github.com/JSONbored/loopover/commit/96b8c426ce5057b7884e19146be35c569568da36)), closes [#4800](https://github.com/JSONbored/loopover/issues/4800)
* **miner:** honor kill-switch mid-attempt during iterate-loop ([#5799](https://github.com/JSONbored/loopover/issues/5799)) ([3525e95](https://github.com/JSONbored/loopover/commit/3525e95a4afd0a9827e64fc00a20919d9a222f82))


### Fixes

* **engine:** clamp rate-limit retryAfterMs to at most one window on a backward clock ([#5855](https://github.com/JSONbored/loopover/issues/5855)) ([f35e354](https://github.com/JSONbored/loopover/commit/f35e354747fcd959ff8be848d9e96fe0a5b3559e)), closes [#5829](https://github.com/JSONbored/loopover/issues/5829)
* **rebrand:** full-cutover rename miner/AMS per-repo and operator config filenames ([#5765](https://github.com/JSONbored/loopover/issues/5765)) ([c93569d](https://github.com/JSONbored/loopover/commit/c93569dcd977ec7a6ec78157b6b40374f85f12cc))
* **rebrand:** full-cutover rename remaining internal gittensory runtime identifiers ([#5761](https://github.com/JSONbored/loopover/issues/5761)) ([75450f1](https://github.com/JSONbored/loopover/commit/75450f1d597dbc54c46d6005ed540dad8512b071))
* **signals:** require a code file before manifest_missing_tests fires ([#5852](https://github.com/JSONbored/loopover/issues/5852)) ([ad011d3](https://github.com/JSONbored/loopover/commit/ad011d377721b235e168e911738264df5eda45ca))

## [3.0.0](https://github.com/JSONbored/gittensory/compare/engine-v2.0.0...engine-v3.0.0) (2026-07-14)


### ⚠ BREAKING CHANGES

* **build:** every gittensory-prefixed directory under apps/ and packages/ is now loopover-prefixed, and the two extension packages' npm names changed from @jsonbored/gittensory-* to @loopover/*. No dual-path/alias, per the epic's full-cutover mandate.

### Features

* **build:** Phase 5 - full-cutover rename all gittensory-* directories to loopover-* ([#5743](https://github.com/JSONbored/gittensory/issues/5743)) ([81e4ac3](https://github.com/JSONbored/gittensory/commit/81e4ac34dfb4dee9c3cadefcc27a515617462da9))

## [2.0.0](https://github.com/JSONbored/gittensory/compare/engine-v1.0.0...engine-v2.0.0) (2026-07-14)


### ⚠ BREAKING CHANGES

* **miner:** the miner's default config directory and every gittensory_miner_* Prometheus metric name changed; no dual-read/alias, per the epic's full-cutover mandate ([#5705](https://github.com/JSONbored/gittensory/issues/5705)). A self-hoster's existing ~/.config/gittensory-miner state does not migrate automatically.
* **github:** the bot no longer recognizes @gittensory as a command trigger anywhere -- only @loopover works. Any saved PR-comment template, bookmark, or muscle-memory referencing @gittensory <command> must be updated to @loopover <command>.
* **miner:** every LOOPOVER_MINER_*/LOOPOVER_API_TOKEN_FILE/ LOOPOVER_MCP_TOKEN_FILE/LOOPOVER_MEM_LIMIT/LOOPOVER_REPORTING_* env var an existing self-hosted AMS/miner deployment sets must be renamed to its LOOPOVER_ equivalent -- the old names are no longer read.
* remove gittensory-engine's settings.gateCheckMode yml back-compat parsing ([#5373](https://github.com/JSONbored/gittensory/issues/5373)) (#5463)

### Features

* **commands:** add [@gittensory](https://github.com/gittensory) chat &lt;question&gt; — grounded LLM Q&A via local Ollama ([#4985](https://github.com/JSONbored/gittensory/issues/4985)) ([a086033](https://github.com/JSONbored/gittensory/commit/a086033f8b49dab2b1003b8f158bb0dc39ed4957)), closes [#4595](https://github.com/JSONbored/gittensory/issues/4595)
* **commands:** intent-classification router for unrecognized [@gittensory](https://github.com/gittensory) mentions ([#5036](https://github.com/JSONbored/gittensory/issues/5036)) ([f8f281b](https://github.com/JSONbored/gittensory/commit/f8f281b87f4c966c7feb8dc30b6be360e532dab3))
* **commands:** let a PR's own author use chat when rate limiting is active ([#5087](https://github.com/JSONbored/gittensory/issues/5087)) ([9b307d8](https://github.com/JSONbored/gittensory/commit/9b307d8a66398b93cf3ed6eeff2166819461a25a)), closes [#5084](https://github.com/JSONbored/gittensory/issues/5084)
* **commands:** make [@gittensory](https://github.com/gittensory) chat's frontier fallback configurable ([#4595](https://github.com/JSONbored/gittensory/issues/4595) follow-up) ([#5015](https://github.com/JSONbored/gittensory/issues/5015)) ([9429030](https://github.com/JSONbored/gittensory/commit/94290306182d2fdcd5c4264b7a32a5361270a826))
* **github:** rename the [@gittensory](https://github.com/gittensory) bot mention command to [@loopover](https://github.com/loopover) ([#5715](https://github.com/JSONbored/gittensory/issues/5715)) ([40e6cdf](https://github.com/JSONbored/gittensory/commit/40e6cdf7b07ddf7588421622c0ab29351f26c77f))
* **miner-governor:** build a real production runSlopAssessment implementation ([#5133](https://github.com/JSONbored/gittensory/issues/5133)) ([#5140](https://github.com/JSONbored/gittensory/issues/5140)) ([e7d95a9](https://github.com/JSONbored/gittensory/commit/e7d95a9041a9f9292622b54ae5591a2343df1d0d))
* **miner-governor:** closed-loop discovery re-entry trigger ([#2338](https://github.com/JSONbored/gittensory/issues/2338)) ([#5051](https://github.com/JSONbored/gittensory/issues/5051)) ([d7e38d6](https://github.com/JSONbored/gittensory/commit/d7e38d6981fa973f61a320cf426dec293675f13e))
* **miner-governor:** dry-run-by-default enforcement + fail-closed chokepoint ([#2342](https://github.com/JSONbored/gittensory/issues/2342), [#2340](https://github.com/JSONbored/gittensory/issues/2340)) ([#5014](https://github.com/JSONbored/gittensory/issues/5014)) ([4719f2c](https://github.com/JSONbored/gittensory/commit/4719f2c2cb7a53e6f0288aedaea2ed205a59e347))
* **miner-governor:** enforce non-convergence + budget/turn/termination halts ([#2347](https://github.com/JSONbored/gittensory/issues/2347)) ([#4989](https://github.com/JSONbored/gittensory/issues/4989)) ([51208ce](https://github.com/JSONbored/gittensory/commit/51208ce443a5372e1234e7f7baedfdb4bb6e8864))
* **miner-governor:** gated-submission trigger requiring predicted-gate PASS + slop-under-threshold ([#5045](https://github.com/JSONbored/gittensory/issues/5045)) ([e6efe87](https://github.com/JSONbored/gittensory/commit/e6efe872ecac5650b960a93bbefdf731fb33045c))
* **miner-governor:** global + per-repo kill-switch ([#2341](https://github.com/JSONbored/gittensory/issues/2341)) ([#5012](https://github.com/JSONbored/gittensory/issues/5012)) ([dcc1601](https://github.com/JSONbored/gittensory/commit/dcc1601cfb017164c6134d0e333ca74e69d95e78))
* **miner-governor:** iterate-loop stop/abandon/handoff policy ([#5040](https://github.com/JSONbored/gittensory/issues/5040)) ([e446f0c](https://github.com/JSONbored/gittensory/commit/e446f0c58233dc9a5dd99cbf7cea5880e5213a5a))
* **miner-governor:** kill-switch propagation into the manage/loop subsystem ([#2339](https://github.com/JSONbored/gittensory/issues/2339)) ([#5057](https://github.com/JSONbored/gittensory/issues/5057)) ([a21a8ad](https://github.com/JSONbored/gittensory/commit/a21a8ad8dce8a69880e2110bf48ad6fae6e645a2))
* **miner-governor:** local create-&gt;score-&gt;self-review-&gt;decide iterate-loop orchestrator ([#2333](https://github.com/JSONbored/gittensory/issues/2333)) ([#5044](https://github.com/JSONbored/gittensory/issues/5044)) ([c51fe41](https://github.com/JSONbored/gittensory/commit/c51fe41b7f498538bd49db8e90c7263b84b5f16a))
* **miner-governor:** self-plagiarism throttle across the miner's own repos ([#4972](https://github.com/JSONbored/gittensory/issues/4972)) ([f0fa765](https://github.com/JSONbored/gittensory/commit/f0fa76523340d956c2408d14fc8ce31513017391))
* **miner-governor:** self-reputation throttle from own outcome history ([#4983](https://github.com/JSONbored/gittensory/issues/4983)) ([7bbf529](https://github.com/JSONbored/gittensory/commit/7bbf529b524ff734b04e4c432116aeb518e9a519)), closes [#2346](https://github.com/JSONbored/gittensory/issues/2346)
* **miner-governor:** self-review adapter wiring diffs through predicted-gate + slop ([#2334](https://github.com/JSONbored/gittensory/issues/2334)) ([#5034](https://github.com/JSONbored/gittensory/issues/5034)) ([214b4c3](https://github.com/JSONbored/gittensory/commit/214b4c34f21a7944f40532d9aca6075f0b3f321b))
* **miner-governor:** wire rate-limit + jittered backoff into live write enforcement ([#2344](https://github.com/JSONbored/gittensory/issues/2344)) ([#4984](https://github.com/JSONbored/gittensory/issues/4984)) ([f175e0c](https://github.com/JSONbored/gittensory/commit/f175e0c028c2803f0d9410599d12ec4590e03c39))
* **miner-hands:** parse Claude Code's JSON error envelope in the CLI-subprocess driver ([#5168](https://github.com/JSONbored/gittensory/issues/5168)) ([#5256](https://github.com/JSONbored/gittensory/issues/5256)) ([45a3741](https://github.com/JSONbored/gittensory/commit/45a3741c43ea103f36e0f13f6bacca0e542fef42))
* **miner-hands:** parse Codex's JSONL stdout for its real error object in the CLI-subprocess driver ([#5169](https://github.com/JSONbored/gittensory/issues/5169)) ([#5262](https://github.com/JSONbored/gittensory/issues/5262)) ([183e655](https://github.com/JSONbored/gittensory/commit/183e65528c48aa6ae211f76eb4b852aaf6abcdb7))
* **miner-hands:** two-tier stalled-output fast-fail timeout for the CLI-subprocess driver ([#5167](https://github.com/JSONbored/gittensory/issues/5167)) ([#5251](https://github.com/JSONbored/gittensory/issues/5251)) ([cae277e](https://github.com/JSONbored/gittensory/commit/cae277e00eda15bd1e9f1e2694a102aadae062f0))
* **miner-hands:** wire real self-plagiarism data into the Governor chokepoint ([#5706](https://github.com/JSONbored/gittensory/issues/5706)) ([40ce138](https://github.com/JSONbored/gittensory/commit/40ce138e607d0c71ad2fa7a93cfc9f59ce9a4f86)), closes [#5676](https://github.com/JSONbored/gittensory/issues/5676)
* **miner:** add .gittensory-ams.yml operator execution-policy config ([#5249](https://github.com/JSONbored/gittensory/issues/5249)) ([f92b298](https://github.com/JSONbored/gittensory/commit/f92b2982bac4d32000aabea366805bb008f52e0e))
* **miner:** build a real SelfReviewContext fetcher ([#5145](https://github.com/JSONbored/gittensory/issues/5145)) ([#5235](https://github.com/JSONbored/gittensory/issues/5235)) ([7a423be](https://github.com/JSONbored/gittensory/commit/7a423be3648342232e9274e39ef39c691feca967))
* **miner:** extract and persist real coding-agent token usage ([#5658](https://github.com/JSONbored/gittensory/issues/5658)) ([1e0ac6c](https://github.com/JSONbored/gittensory/commit/1e0ac6c9b1d932f2f83b34efdfea24710988c606))
* **miner:** persist coding-agent provider + real cost on the attempt log ([#5637](https://github.com/JSONbored/gittensory/issues/5637)) ([941c300](https://github.com/JSONbored/gittensory/commit/941c300691982c65b534e86bdedf03a85f8712b4))
* **miner:** rename LOOPOVER_MINER_*/LOOPOVER_* env vars to LOOPOVER_MINER_*/LOOPOVER_* ([#5707](https://github.com/JSONbored/gittensory/issues/5707)) ([6714f0c](https://github.com/JSONbored/gittensory/commit/6714f0cac5ab37477c7f56332cde969788c7996e)), closes [#5705](https://github.com/JSONbored/gittensory/issues/5705)
* **miner:** wire attempt-metering.ts into the iterate loop for a real mid-attempt budget abort ([#5437](https://github.com/JSONbored/gittensory/issues/5437)) ([30a6ffb](https://github.com/JSONbored/gittensory/commit/30a6ffbc7b7625d0fdc4ce01320ca7a5da4c986b))
* **miner:** wire claim-conflict resolution end-to-end ([#5480](https://github.com/JSONbored/gittensory/issues/5480)) ([7109bf2](https://github.com/JSONbored/gittensory/commit/7109bf267eba84733c441fa8e137c1a5d310983d))
* **miner:** wire the real runMinerAttempt call into attempt-cli.js ([#5261](https://github.com/JSONbored/gittensory/issues/5261)) ([f3f1f2b](https://github.com/JSONbored/gittensory/commit/f3f1f2b59565fc83ce2f7f84d3b186a533221087))
* **rees:** add real before/after complexity-delta analyzer ([#4758](https://github.com/JSONbored/gittensory/issues/4758)) ([6af9d77](https://github.com/JSONbored/gittensory/commit/6af9d77337e5383f6bb5041de9df06942ebddaf7))
* remove gittensory-engine's settings.gateCheckMode yml back-compat parsing ([#5373](https://github.com/JSONbored/gittensory/issues/5373)) ([#5463](https://github.com/JSONbored/gittensory/issues/5463)) ([afd0318](https://github.com/JSONbored/gittensory/commit/afd0318190cb163f1314d5c872f6374c297f1b1e))
* **review:** add improvementSignal converged-feature activation ([#4753](https://github.com/JSONbored/gittensory/issues/4753)) ([c3ea28f](https://github.com/JSONbored/gittensory/commit/c3ea28f7baa4914e0e4333ac3595676e73271a04))
* **review:** decouple e2e-test-gen auto-trigger and widen checkbox auth ([#4199](https://github.com/JSONbored/gittensory/issues/4199)) ([#4757](https://github.com/JSONbored/gittensory/issues/4757)) ([2dbfc46](https://github.com/JSONbored/gittensory/commit/2dbfc465c066c721ea61fcd6434f63a42344721b))
* **review:** let repos opt out of the built-in hard-guardrail floor ([#5708](https://github.com/JSONbored/gittensory/issues/5708)) ([5059538](https://github.com/JSONbored/gittensory/commit/505953890bb4780093ab11959202baba6da8cc4a))
* **review:** make gittensor subnet integration an opt-in experimental plugin ([#5030](https://github.com/JSONbored/gittensory/issues/5030)) ([0344da0](https://github.com/JSONbored/gittensory/commit/0344da02063fea608fa3f060c8d653d78ae0f60f))
* **review:** personalize predicted-gate readiness by contributor calibration history ([#2349](https://github.com/JSONbored/gittensory/issues/2349)) ([#5069](https://github.com/JSONbored/gittensory/issues/5069)) ([bc0e16d](https://github.com/JSONbored/gittensory/commit/bc0e16d1858d4c9fb44e8c4b43e11e677470894e))
* **review:** surface the improvement signal in the PR panel ([#4954](https://github.com/JSONbored/gittensory/issues/4954)) ([c178616](https://github.com/JSONbored/gittensory/commit/c1786161c3baba781fafdc124182877c6080b360))
* **review:** vision-verify screenshot-table PRs with the local VLM ([#4691](https://github.com/JSONbored/gittensory/issues/4691)) ([269dbd7](https://github.com/JSONbored/gittensory/commit/269dbd772f17074f6d9999a7895594d75236fe1a))
* **ui:** slop + duplicate trend card on maintainer dashboard ([#2202](https://github.com/JSONbored/gittensory/issues/2202)) ([#5635](https://github.com/JSONbored/gittensory/issues/5635)) ([cdfc14b](https://github.com/JSONbored/gittensory/commit/cdfc14b3811f185259c2b5c2ec6af2cad33bdd69))


### Fixes

* **commands:** require an open, non-draft PR for chat's pr_author grant ([#5094](https://github.com/JSONbored/gittensory/issues/5094)) ([eb3d641](https://github.com/JSONbored/gittensory/commit/eb3d641473dea0f7c44c81e1529c3673e23f6bc7)), closes [#5092](https://github.com/JSONbored/gittensory/issues/5092)
* **config:** warn on ambiguous gate.enabled without gate.checkMode ([#5355](https://github.com/JSONbored/gittensory/issues/5355)) ([#5375](https://github.com/JSONbored/gittensory/issues/5375)) ([af05e48](https://github.com/JSONbored/gittensory/commit/af05e488dca9089692a1eb654660e4e74249805c))
* **engine:** keep soft-claim payload public-safe ([#4650](https://github.com/JSONbored/gittensory/issues/4650)) ([0d88a52](https://github.com/JSONbored/gittensory/commit/0d88a522941ae67dc9e8753245269b522eb03084))
* **github:** finish [@gittensory](https://github.com/gittensory) -&gt; [@loopover](https://github.com/loopover) cutover in gittensory-engine + regen openapi.json ([#5718](https://github.com/JSONbored/gittensory/issues/5718)) ([b30406b](https://github.com/JSONbored/gittensory/commit/b30406b74672ef2cdd6e644f5c621178189f4644))
* **miner-governor:** disambiguate self-plagiarism ties across repos ([#5104](https://github.com/JSONbored/gittensory/issues/5104)) ([d88d6d4](https://github.com/JSONbored/gittensory/commit/d88d6d460b9d24920bb7f8dc59811af5f919300b))
* **miner-governor:** require global live opt-in ([#5231](https://github.com/JSONbored/gittensory/issues/5231)) ([14c75e2](https://github.com/JSONbored/gittensory/commit/14c75e29c8f4e25f50e8a30af94e47f9df0a3234))
* **miner:** bound repo-map parsing to prevent resource exhaustion ([#4646](https://github.com/JSONbored/gittensory/issues/4646)) ([976f42e](https://github.com/JSONbored/gittensory/commit/976f42e4e79d66d61dfa0500b02c4d3475006451))
* **miner:** close_pr runs unconditionally before its best-effort comment ([#5494](https://github.com/JSONbored/gittensory/issues/5494)) ([68ce986](https://github.com/JSONbored/gittensory/commit/68ce986ed319eca62b8bc3a4c840346cc1ee6e97))
* **miner:** derive sdk changed files from git ([#5362](https://github.com/JSONbored/gittensory/issues/5362)) ([20dc547](https://github.com/JSONbored/gittensory/commit/20dc547551b89b375a2f023b24bf644f19937716))
* **miner:** fail closed for CLI drivers when house-rule hooks are explicitly requested ([#5142](https://github.com/JSONbored/gittensory/issues/5142)) ([029ada8](https://github.com/JSONbored/gittensory/commit/029ada80de3f5688231a077fb97cd2bdd2217f91))
* **miner:** full-cutover rename gittensory-miner config dir + Prometheus metric names ([#5721](https://github.com/JSONbored/gittensory/issues/5721)) ([8496b4f](https://github.com/JSONbored/gittensory/commit/8496b4f4cf6a0215852ca4e40841bd31fd85b796))
* **miner:** honor iterate loop execution mode ([#5108](https://github.com/JSONbored/gittensory/issues/5108)) ([bac7d4a](https://github.com/JSONbored/gittensory/commit/bac7d4a55f591f775e9e0d6f8162047beead4caf))
* **miner:** isolate cli agent credential paths ([#4981](https://github.com/JSONbored/gittensory/issues/4981)) ([ff2d468](https://github.com/JSONbored/gittensory/commit/ff2d468848f757def6dbf7032e2818a346a73063))
* **miner:** keep AMS policy operator-local ([#5351](https://github.com/JSONbored/gittensory/issues/5351)) ([5f28519](https://github.com/JSONbored/gittensory/commit/5f2851923071506f1c67cb0b79933be43e7a5d1b))
* **miner:** use claude/codex's real non-interactive CLI argv ([#5382](https://github.com/JSONbored/gittensory/issues/5382)) ([b4175d6](https://github.com/JSONbored/gittensory/commit/b4175d684dd35505c6c03ae213efd7c382ffa41a))
* **miner:** wire real dollar-cost tracking into the loop's budgetSpent ([#5356](https://github.com/JSONbored/gittensory/issues/5356)) ([7935bb4](https://github.com/JSONbored/gittensory/commit/7935bb4a2c7c5398b3480a59252ad3ad855734e6))
* **miner:** wire recordOwnSubmission's write side into the real attempt pipeline ([#5678](https://github.com/JSONbored/gittensory/issues/5678)) ([ebb540d](https://github.com/JSONbored/gittensory/commit/ebb540d51c5ffa67581fb7e018e2ce9d439b8a30))
* **review:** avoid overlapping screenshot table extraction ([#4993](https://github.com/JSONbored/gittensory/issues/4993)) ([acb4f6c](https://github.com/JSONbored/gittensory/commit/acb4f6cc05467189d635bb7adb501bc60229bd92))
* **review:** fold linkedIssuePolicy into linkedIssueGateMode's promotion ([#4618](https://github.com/JSONbored/gittensory/issues/4618)) ([#4755](https://github.com/JSONbored/gittensory/issues/4755)) ([3ae7ece](https://github.com/JSONbored/gittensory/commit/3ae7ece6aa588c453e1dd0f2cd71bd15ba0002a2))
* **review:** keep recap cohorts private ([#5204](https://github.com/JSONbored/gittensory/issues/5204)) ([c772d74](https://github.com/JSONbored/gittensory/commit/c772d74a9e4ba19db4f4566e85d2ee76ae96e8b7))
* **review:** stop the deterministic type-label mislabel from [#5233](https://github.com/JSONbored/gittensory/issues/5233)'s broken closure check ([#5407](https://github.com/JSONbored/gittensory/issues/5407)) ([e58f00c](https://github.com/JSONbored/gittensory/commit/e58f00cab51e9d65c329c359f1ec5af7034afd36)), closes [#5385](https://github.com/JSONbored/gittensory/issues/5385)

## [1.0.0](https://github.com/JSONbored/gittensory/compare/engine-v0.2.0...engine-v1.0.0) (2026-07-10)


### ⚠ BREAKING CHANGES

* **engine:** bound miner-goal-spec list scanning, remove the orphaned duplicate parser ([#4318](https://github.com/JSONbored/gittensory/issues/4318))

### Features

* **commands:** add the maintainer-only [@gittensory](https://github.com/gittensory) generate-tests command ([#4211](https://github.com/JSONbored/gittensory/issues/4211)) ([e3b83c8](https://github.com/JSONbored/gittensory/commit/e3b83c8e9cd4e6b5912b279f5119229605eaf484))
* **engine:** extract buildIssueRagQuery to gittensory-engine ([#4342](https://github.com/JSONbored/gittensory/issues/4342)) ([c823f9c](https://github.com/JSONbored/gittensory/commit/c823f9c5cf59fb8d596f3c93f1749127622b25a8)), closes [#4254](https://github.com/JSONbored/gittensory/issues/4254)
* **engine:** extract computeLocalScorerTokens to gittensory-engine ([#4371](https://github.com/JSONbored/gittensory/issues/4371)) ([d276cde](https://github.com/JSONbored/gittensory/commit/d276cde5ea21214b45b67a3567a2ab4289a1298a)), closes [#4253](https://github.com/JSONbored/gittensory/issues/4253)
* **engine:** extract isFailingCheckSummary to gittensory-engine ([#4256](https://github.com/JSONbored/gittensory/issues/4256)) ([#4377](https://github.com/JSONbored/gittensory/issues/4377)) ([1eeef60](https://github.com/JSONbored/gittensory/commit/1eeef606207657773734a5291ad9cbc23e7206ed))
* **engine:** extract path-matchers.ts's pure classifier family to gittensory-engine ([#4252](https://github.com/JSONbored/gittensory/issues/4252)) ([#4444](https://github.com/JSONbored/gittensory/issues/4444)) ([6a4f54c](https://github.com/JSONbored/gittensory/commit/6a4f54cc5b950b7b5293599340374fb882814725))
* **governor:** add budget/turn/termination cap calculator ([#4374](https://github.com/JSONbored/gittensory/issues/4374)) ([c8f8316](https://github.com/JSONbored/gittensory/commit/c8f83165f59458c83d1d7f72c853c0420d268ab5)), closes [#4288](https://github.com/JSONbored/gittensory/issues/4288)
* **miner-concurrency:** add git-worktree-per-attempt pool allocator ([#4297](https://github.com/JSONbored/gittensory/issues/4297)) ([#4598](https://github.com/JSONbored/gittensory/issues/4598)) ([14c3a25](https://github.com/JSONbored/gittensory/commit/14c3a2590afa54351863458f3fbd45e56cf70b4a))
* **miner-config:** parse a feasibilityGate policy block from .gittensory-miner.yml ([a6c33b6](https://github.com/JSONbored/gittensory/commit/a6c33b69a8bdec80251dd676d7531c68a4319aa4))
* **miner-config:** parse a feasibilityGate policy block from .gittensory-miner.yml ([#4275](https://github.com/JSONbored/gittensory/issues/4275)) ([f044dc5](https://github.com/JSONbored/gittensory/commit/f044dc5144ecd44915d4597e5df9a8cbeae67a52))
* **miner-discovery-plane:** add anonymized telemetry event schema for the hosted plane ([#4301](https://github.com/JSONbored/gittensory/issues/4301)) ([#4438](https://github.com/JSONbored/gittensory/issues/4438)) ([4daceaa](https://github.com/JSONbored/gittensory/commit/4daceaaa16da484d4eb55972bba0dff037fdd918))
* **miner-discovery-plane:** add the client-side soft-claim coordination request builder ([#4443](https://github.com/JSONbored/gittensory/issues/4443)) ([58e08e9](https://github.com/JSONbored/gittensory/commit/58e08e9a352bc7ad3082218fb22fc0b30db644e5)), closes [#4302](https://github.com/JSONbored/gittensory/issues/4302)
* **miner-discovery-plane:** define the public-data-only discovery-index API contract ([#4436](https://github.com/JSONbored/gittensory/issues/4436)) ([e021f2a](https://github.com/JSONbored/gittensory/commit/e021f2a06deca542ecd0ff6e448a6310d86d7694)), closes [#4300](https://github.com/JSONbored/gittensory/issues/4300)
* **miner-hands:** add coding-agent dry-run mode and driver seam ([#4313](https://github.com/JSONbored/gittensory/issues/4313)) ([#4347](https://github.com/JSONbored/gittensory/issues/4347)) ([feb2ba8](https://github.com/JSONbored/gittensory/commit/feb2ba8a2d60c03da84160364761f8eda6fbfb9f))
* **miner-hands:** add driver attempt log persistence and JSONL export ([#4294](https://github.com/JSONbored/gittensory/issues/4294)) ([#4576](https://github.com/JSONbored/gittensory/issues/4576)) ([97e91d4](https://github.com/JSONbored/gittensory/commit/97e91d44b4a30302acf8d82292c4ec7c6e028fa8))
* **miner-hands:** add pure per-attempt cost/turn metering to gittensory-engine ([564a27c](https://github.com/JSONbored/gittensory/commit/564a27c8cf7694bbd49aa140870f187b42e6d877))
* **miner-hands:** add pure per-attempt cost/turn metering to gittensory-engine ([d928849](https://github.com/JSONbored/gittensory/commit/d9288498b795c0a611ccfaf815b3000d781bf4f5)), closes [#4311](https://github.com/JSONbored/gittensory/issues/4311)
* **miner-hands:** add shared subprocess redaction/env-allowlist helper to gittensory-engine ([#4284](https://github.com/JSONbored/gittensory/issues/4284)) ([9796e9c](https://github.com/JSONbored/gittensory/commit/9796e9c282b8bfa6fde5d19a7be71c1147505ce3))
* **miner-hands:** add shared subprocess redaction/env-allowlist helper to gittensory-engine ([#4284](https://github.com/JSONbored/gittensory/issues/4284)) ([eaea6c9](https://github.com/JSONbored/gittensory/commit/eaea6c9edbb6141cc7452c7666f72764e30a05ec))
* **miner-hands:** Agent-SDK CodingAgentDriver (query() loop) ([#4548](https://github.com/JSONbored/gittensory/issues/4548)) ([8f492f2](https://github.com/JSONbored/gittensory/commit/8f492f226207aec9ec6cb3069c5fe553caa53b1e))
* **miner-hands:** CLI-subprocess CodingAgentDriver ([#4531](https://github.com/JSONbored/gittensory/issues/4531)) ([b7a4477](https://github.com/JSONbored/gittensory/commit/b7a4477f7e4caa2d8cd9963355b31237e391e942)), closes [#4266](https://github.com/JSONbored/gittensory/issues/4266)
* **miner-hands:** CodingAgentDriver factory + provider-style config resolution ([#4289](https://github.com/JSONbored/gittensory/issues/4289)) ([#4633](https://github.com/JSONbored/gittensory/issues/4633)) ([30b62ae](https://github.com/JSONbored/gittensory/commit/30b62ae47707f049851dfdaa7c917e6ea2e48465))
* **miner-hands:** compose an immutable per-attempt acceptance-criteria document ([#4449](https://github.com/JSONbored/gittensory/issues/4449)) ([861e8b7](https://github.com/JSONbored/gittensory/commit/861e8b710fc0d25990dc5be39f98a840bee11db5)), closes [#4271](https://github.com/JSONbored/gittensory/issues/4271)
* **miner-hands:** git-worktree-per-attempt isolation primitive ([#4547](https://github.com/JSONbored/gittensory/issues/4547)) ([69bd6c2](https://github.com/JSONbored/gittensory/commit/69bd6c2626c268378883878a6defef57f453ebac)), closes [#4269](https://github.com/JSONbored/gittensory/issues/4269)
* **miner-hands:** lint-guarded edit wrapper for coding-agent drivers ([#4276](https://github.com/JSONbored/gittensory/issues/4276)) ([#4486](https://github.com/JSONbored/gittensory/issues/4486)) ([ed96eca](https://github.com/JSONbored/gittensory/commit/ed96eca6435a6787d99f7633795992bcbb97f01b))
* **miner-hands:** tree-sitter-based repo map builder ([#4542](https://github.com/JSONbored/gittensory/issues/4542)) ([604d971](https://github.com/JSONbored/gittensory/commit/604d9714b2df551bc75aeb6d8617be3b91ec57a4)), closes [#4280](https://github.com/JSONbored/gittensory/issues/4280)
* **miner-plan:** issue-to-plan decomposition heuristic ([#4292](https://github.com/JSONbored/gittensory/issues/4292)) ([#4339](https://github.com/JSONbored/gittensory/issues/4339)) ([e580525](https://github.com/JSONbored/gittensory/commit/e58052599b290df32aa4e85cbc7f4118e49476c9))
* **miner-portfolio:** add pure non-convergence detector to gittensory-engine ([4ce12f8](https://github.com/JSONbored/gittensory/commit/4ce12f86856c5d44c9a938ed360a545716a69148))
* **miner-portfolio:** add pure non-convergence detector to gittensory-engine ([883c333](https://github.com/JSONbored/gittensory/commit/883c3337b499145aba3171c5717b76ce65242479)), closes [#4286](https://github.com/JSONbored/gittensory/issues/4286)
* **miner-scale:** add fleet run-manifest for multi-repo worktree scheduling ([4cf2adb](https://github.com/JSONbored/gittensory/commit/4cf2adb4151265f54c01350b71f33e40b420e7be))
* **miner-scale:** add fleet run-manifest for multi-repo worktree scheduling ([e6ef86c](https://github.com/JSONbored/gittensory/commit/e6ef86cf055c06c65a7d4162debc04c841667a96)), closes [#4299](https://github.com/JSONbored/gittensory/issues/4299)
* **miner-selfimprove:** calibration accuracy-trend view over a snapshot series ([#4639](https://github.com/JSONbored/gittensory/issues/4639)) ([2e9bbb6](https://github.com/JSONbored/gittensory/commit/2e9bbb60910e2c6110a07356a58aeca6d73889e5)), closes [#4268](https://github.com/JSONbored/gittensory/issues/4268)
* **miner-selfimprove:** engine-parity drift detector ([#4260](https://github.com/JSONbored/gittensory/issues/4260)) ([06ce0a1](https://github.com/JSONbored/gittensory/commit/06ce0a162ea54d61552408e721f39dc0a6e56250))
* **miner-selfimprove:** engine-parity drift detector ([#4260](https://github.com/JSONbored/gittensory/issues/4260)) ([df22953](https://github.com/JSONbored/gittensory/commit/df229537c83c3ad3c178aba9b218078a3c245a63))
* **miner-selfimprove:** read-only calibration dashboard view ([#4504](https://github.com/JSONbored/gittensory/issues/4504)) ([363305c](https://github.com/JSONbored/gittensory/commit/363305c297971ba2df99d710046b3584994b0cea)), closes [#4261](https://github.com/JSONbored/gittensory/issues/4261)
* **miner-selfimprove:** render prediction-calibration Prometheus metrics ([#4461](https://github.com/JSONbored/gittensory/issues/4461)) ([da9952f](https://github.com/JSONbored/gittensory/commit/da9952f13d6b65bce22e18d7b562684736affcdd)), closes [#4264](https://github.com/JSONbored/gittensory/issues/4264)
* **notifications:** config-as-code overrides for the maintainer recap cadence ([d38239a](https://github.com/JSONbored/gittensory/commit/d38239a9e2d7687cbe83bb6bb898b0b62c82cc6f))
* **notifications:** config-as-code overrides for the maintainer recap cadence ([6773ff8](https://github.com/JSONbored/gittensory/commit/6773ff8cbb3c32ee98c7e16cf68107137f59969b))
* **review:** one-shot AI review cadence, configurable globally + per repo ([#4657](https://github.com/JSONbored/gittensory/issues/4657)) ([aa1ffb8](https://github.com/JSONbored/gittensory/commit/aa1ffb8ff46c80e71bba1046cb4156a4e43ed68a))
* **review:** push generated E2E tests as a real PR-branch commit ([#4197](https://github.com/JSONbored/gittensory/issues/4197), [#4201](https://github.com/JSONbored/gittensory/issues/4201)) ([#4245](https://github.com/JSONbored/gittensory/issues/4245)) ([7b35640](https://github.com/JSONbored/gittensory/commit/7b35640a4dabf934fbb51e693cdec4f7fbd1ded1))
* **review:** register e2eTests as the sixth converged-feature key ([#4206](https://github.com/JSONbored/gittensory/issues/4206)) ([0cb6854](https://github.com/JSONbored/gittensory/commit/0cb6854aef4d54a98f3e2e978dcfc451d273e7b9))
* **review:** reuse review.instructions/pathInstructions for E2E test generation ([#4208](https://github.com/JSONbored/gittensory/issues/4208)) ([24d058a](https://github.com/JSONbored/gittensory/commit/24d058a5b9986730abf8abe42bbdc188c011ac07))
* **review:** viewport x theme completeness matrix for the screenshot-table gate ([#4545](https://github.com/JSONbored/gittensory/issues/4545)) ([afd731e](https://github.com/JSONbored/gittensory/commit/afd731ec57833a3ab6b88c56f4d7cfca8bcdbf94))
* **selfhost:** local-inference binding for advisory-tier AI capabilities (AI_ADVISORY) ([#4388](https://github.com/JSONbored/gittensory/issues/4388)) ([dc37aea](https://github.com/JSONbored/gittensory/commit/dc37aea37d204dea7071422ba7311a1e252abf44))
* **settings:** per-repo override of the global agent-freeze kill-switch ([#4375](https://github.com/JSONbored/gittensory/issues/4375)) ([1b6fa8c](https://github.com/JSONbored/gittensory/commit/1b6fa8c3ecf78261daf6c3dcbad927ad60a2a5df))


### Fixes

* **#4260:** rebase on main and address review blockers ([f256671](https://github.com/JSONbored/gittensory/commit/f25667101f1a2c1091565ce373b50b308dfb0f02))
* **engine:** bound miner-goal-spec list scanning, remove the orphaned duplicate parser ([#4318](https://github.com/JSONbored/gittensory/issues/4318)) ([d329591](https://github.com/JSONbored/gittensory/commit/d329591ce287e11a91eb25d877e41f68dd1c99a8))
* **engine:** consolidate duplicate-winner.ts byte-identical copies ([#4251](https://github.com/JSONbored/gittensory/issues/4251)) ([#4373](https://github.com/JSONbored/gittensory/issues/4373)) ([e44918d](https://github.com/JSONbored/gittensory/commit/e44918d2fe6134961f261bceafa8763ffc4719b7))
* **engine:** correct Cartfile.resolved regex and cover it with parity checks ([#4638](https://github.com/JSONbored/gittensory/issues/4638)) ([a23acba](https://github.com/JSONbored/gittensory/commit/a23acba75a1f3d1a2e648e07710241a7cf52812f))
* **engine:** defer repo-map's createRequire past module scope to unbreak the api Worker deploy ([#4590](https://github.com/JSONbored/gittensory/issues/4590)) ([8f9f2cb](https://github.com/JSONbored/gittensory/commit/8f9f2cb6272fa80a3ef266d4fc47f17ef64e1c27))
* **engine:** resync linked-issue-label-propagation comment drift ([e53472e](https://github.com/JSONbored/gittensory/commit/e53472ef35423020668e9075072a2b161fa41211))
* **manifest:** keep freeze override operator-only ([#4391](https://github.com/JSONbored/gittensory/issues/4391)) ([c52fdb9](https://github.com/JSONbored/gittensory/commit/c52fdb98f2a75bdbf14c5a37e6f7b7b1158c5c3c))
* **manifest:** restore agentGlobalFreezeOverride for the operator-private config source ([#4410](https://github.com/JSONbored/gittensory/issues/4410)) ([9ab4146](https://github.com/JSONbored/gittensory/commit/9ab41467af673575bdb768baf02969dda95495c5))
* **miner-hands:** reject malformed attempt metering numbers ([#4488](https://github.com/JSONbored/gittensory/issues/4488)) ([906d183](https://github.com/JSONbored/gittensory/commit/906d183a5dabb2e677bde2abd28503f7656c9210))
* **miner:** reject unsafe telemetry metric names ([#4487](https://github.com/JSONbored/gittensory/issues/4487)) ([c074efd](https://github.com/JSONbored/gittensory/commit/c074efd8638470d32dc77e3209c40a4e5a4f05ae))
* **review:** append the contributor skill-file link without losing the specific rejection reason ([#4556](https://github.com/JSONbored/gittensory/issues/4556)) ([39f5213](https://github.com/JSONbored/gittensory/commit/39f52130b551fcfb7d03cc7cf5ae7324089021b8))
* **review:** let a reward mapping opt into maintainer-authored-issue trust ([f13706f](https://github.com/JSONbored/gittensory/commit/f13706f54147e7729ca5b2dee89b570b5dd2d3e3))
* **review:** let a reward mapping opt into maintainer-authored-issue trust ([304e88c](https://github.com/JSONbored/gittensory/commit/304e88c7c209fcba7ce9fc35d8804d3dd339d7c7))
* **review:** per-repo review.visual.production_url override for bot-capture ([#4564](https://github.com/JSONbored/gittensory/issues/4564)) ([e063f55](https://github.com/JSONbored/gittensory/commit/e063f55ff1ebf8402da565a5034b1f5b201106bd))
* **review:** resolve dead aiReviewCloseConfidence floor with a configurable disposition ([#4656](https://github.com/JSONbored/gittensory/issues/4656)) ([3a3cd7f](https://github.com/JSONbored/gittensory/commit/3a3cd7f816b259e21923dd9e0040194da36040e3))

## [0.2.0](https://github.com/JSONbored/gittensory/compare/engine-v0.1.0...engine-v0.2.0) (2026-07-08)


### Features

* **review:** add REES complexity and Go/Python error-defect analyzers ([#4155](https://github.com/JSONbored/gittensory/issues/4155)) ([f5c5c52](https://github.com/JSONbored/gittensory/commit/f5c5c5237da04910688369dbf0cf2a1d9371593e))
* **review:** per-repo opt-in to let a confident AI-judgment blocker gate the merge ([#4171](https://github.com/JSONbored/gittensory/issues/4171)) ([4664ad2](https://github.com/JSONbored/gittensory/commit/4664ad25f4c729ded6a37c3d5d6d5a56857d73e7))


### Fixes

* **engine:** fix stale test fixtures, wire the suite into test:ci ([#4150](https://github.com/JSONbored/gittensory/issues/4150)) ([5a4de69](https://github.com/JSONbored/gittensory/commit/5a4de69a67ae0d1704284d6237cd70d34ee2461a))

## Changelog

## engine-v0.1.0 - 2026-07-01

### Features
- Scaffold the shared deterministic engine package skeleton (#2275)
