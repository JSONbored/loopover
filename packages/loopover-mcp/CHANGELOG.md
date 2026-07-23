# Changelog

## mcp-v3.1.1 - 2026-07-17

### Fixes
- Blunt slop-risk / issue-slop REST + CLI to match the MCP tools (#6990) (#7052)

## [3.8.0](https://github.com/JSONbored/loopover/compare/mcp-v3.7.0...mcp-v3.8.0) (2026-07-23)


### Chores

* **mcp:** Synchronize engine-and-dependents versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @loopover/engine bumped from ^3.7.0 to ^3.8.0

## [3.7.0](https://github.com/JSONbored/loopover/compare/mcp-v3.6.0...mcp-v3.7.0) (2026-07-23)


### Chores

* **mcp:** Synchronize engine-and-dependents versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @loopover/engine bumped from ^3.6.0 to ^3.7.0

## [3.6.0](https://github.com/JSONbored/loopover/compare/mcp-v3.5.0...mcp-v3.6.0) (2026-07-23)


### Chores

* **mcp:** Synchronize engine-and-dependents versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @loopover/engine bumped from ^3.5.0 to ^3.6.0

## [3.5.0](https://github.com/JSONbored/loopover/compare/mcp-v3.4.0...mcp-v3.5.0) (2026-07-23)


### Features

* **api:** REST + CLI mirror for loopover_watch_issues ([#7153](https://github.com/JSONbored/loopover/issues/7153)) ([13cb8a3](https://github.com/JSONbored/loopover/commit/13cb8a3909d31e2f1b95963e734073ae985646b7)), closes [#6746](https://github.com/JSONbored/loopover/issues/6746)
* **engine:** represent idea targetRepo as an existing-vs-provision union ([#7710](https://github.com/JSONbored/loopover/issues/7710)) ([d7042ef](https://github.com/JSONbored/loopover/commit/d7042efdee08029c91e37995db34f83bb4d604fe)), closes [#7635](https://github.com/JSONbored/loopover/issues/7635)
* **mcp:** add remote + stdio + CLI surfaces for the selftune override audit ([#7997](https://github.com/JSONbored/loopover/issues/7997)) ([050f8cb](https://github.com/JSONbored/loopover/commit/050f8cb3ae7df3850147375b288e4b9762929c21))
* **mcp:** add remote + stdio MCP tool surfaces for loopover_get_activation_preview ([#7887](https://github.com/JSONbored/loopover/issues/7887)) ([e8e5d89](https://github.com/JSONbored/loopover/commit/e8e5d893a82cba53ac6b7a328bc7842d9942f863)), closes [#7799](https://github.com/JSONbored/loopover/issues/7799)
* **mcp:** add remote + stdio surfaces for loopover_get_ams_miner_cohort ([#7935](https://github.com/JSONbored/loopover/issues/7935)) ([4f87f1a](https://github.com/JSONbored/loopover/commit/4f87f1a5296069fb72b9a96d3255268cd9879218))
* **mcp:** add remote + stdio surfaces for loopover_get_gate_config_effective ([#7928](https://github.com/JSONbored/loopover/issues/7928)) ([03f9d9c](https://github.com/JSONbored/loopover/commit/03f9d9cbe124ab95883ea6f5d375aa29f4fdcfde)), closes [#7800](https://github.com/JSONbored/loopover/issues/7800)
* **mcp:** add remote + stdio surfaces for loopover_get_live_gate_thresholds ([#7924](https://github.com/JSONbored/loopover/issues/7924)) ([510d25b](https://github.com/JSONbored/loopover/commit/510d25bc268ca07c01f698b7723321c3a8ba7276)), closes [#7801](https://github.com/JSONbored/loopover/issues/7801)
* **mcp:** add remote + stdio surfaces for loopover_get_pr_maintainer_packet ([#7926](https://github.com/JSONbored/loopover/issues/7926)) ([1257c20](https://github.com/JSONbored/loopover/commit/1257c204f8314042205fdbbc1e0bb5641f9d0452)), closes [#7802](https://github.com/JSONbored/loopover/issues/7802)
* **mcp:** add remote + stdio surfaces for loopover_get_registry_snapshot ([#7917](https://github.com/JSONbored/loopover/issues/7917)) ([f27b9f0](https://github.com/JSONbored/loopover/commit/f27b9f0cf197cdc4eb45c527c266a60903343994))
* **mcp:** add remote + stdio surfaces for loopover_get_repo_focus_manifest ([#7943](https://github.com/JSONbored/loopover/issues/7943)) ([bc042ed](https://github.com/JSONbored/loopover/commit/bc042edc30d2418382e8b717c7e07518ac879027))
* **mcp:** add remote + stdio surfaces for loopover_get_upstream_ruleset ([#7921](https://github.com/JSONbored/loopover/issues/7921)) ([a97dd18](https://github.com/JSONbored/loopover/commit/a97dd18b6d11e390befb15441537909bf663f96c)), closes [#7807](https://github.com/JSONbored/loopover/issues/7807)
* **mcp:** add REST route, CLI command, and stdio tool for loopover_plan_repo_issues ([#7890](https://github.com/JSONbored/loopover/issues/7890)) ([b3e1bc3](https://github.com/JSONbored/loopover/commit/b3e1bc359c10802eb22b86e69a443e2e70828b4a)), closes [#7764](https://github.com/JSONbored/loopover/issues/7764)
* **mcp:** register loopover_check_improvement_potential stdio tool ([#7963](https://github.com/JSONbored/loopover/issues/7963)) ([a4c15d6](https://github.com/JSONbored/loopover/commit/a4c15d6484a778d9bc86c0fee92f2e5f4fbb09b1))
* **mcp:** register loopover_generate_contributor_issue_drafts as a local stdio tool ([#7989](https://github.com/JSONbored/loopover/issues/7989)) ([6a55b8d](https://github.com/JSONbored/loopover/commit/6a55b8d324a24279a42b8adde3314a45ce2a4d88))
* **mcp:** register loopover_get_agent_audit_feed as a local stdio tool ([#7971](https://github.com/JSONbored/loopover/issues/7971)) ([84a7878](https://github.com/JSONbored/loopover/commit/84a7878c67e1c79dbec92a702617a65e54b6f6c9))
* **mcp:** register loopover_get_automation_state as a local stdio tool ([#7966](https://github.com/JSONbored/loopover/issues/7966)) ([ca738de](https://github.com/JSONbored/loopover/commit/ca738dec7ce840cc9b1ae03a61c0067c58bcb450))
* **mcp:** register loopover_get_contributor_profile as a local stdio tool ([#7760](https://github.com/JSONbored/loopover/issues/7760)) ([#7958](https://github.com/JSONbored/loopover/issues/7958)) ([3790ecd](https://github.com/JSONbored/loopover/commit/3790ecde79469af12309183ae22b04656e27d3c5))
* **mcp:** register loopover_get_outcome_calibration as a local stdio tool ([#7877](https://github.com/JSONbored/loopover/issues/7877)) ([0af9f49](https://github.com/JSONbored/loopover/commit/0af9f49186a38526a99324dfd2fcceeece2b1295))
* **mcp:** register loopover_get_repo_onboarding_pack as a local  ([#7977](https://github.com/JSONbored/loopover/issues/7977)) ([b9aa25f](https://github.com/JSONbored/loopover/commit/b9aa25f60d2cc63ba889dd2ef1ea619e1cb1ec81))
* **mcp:** register loopover_list_notifications as a local stdio tool ([#7761](https://github.com/JSONbored/loopover/issues/7761)) ([#7965](https://github.com/JSONbored/loopover/issues/7965)) ([8c2950c](https://github.com/JSONbored/loopover/commit/8c2950c3f063785d6896030cc4dcf3d08697801c))
* **mcp:** register loopover_mark_notifications_read as a local stdio tool ([#7950](https://github.com/JSONbored/loopover/issues/7950)) ([fa3581d](https://github.com/JSONbored/loopover/commit/fa3581dec91dddb9b6c94f5814a8ef354cd2b92e)), closes [#7762](https://github.com/JSONbored/loopover/issues/7762)
* **mcp:** register loopover_propose_action as a local stdio tool ([#7991](https://github.com/JSONbored/loopover/issues/7991)) ([7c1a21e](https://github.com/JSONbored/loopover/commit/7c1a21effb2e5725ec4d4ecdec41d42f990162f4))
* **mcp:** register loopover_refresh_repo_docs as a local stdio tool ([#7974](https://github.com/JSONbored/loopover/issues/7974)) ([4dccaa6](https://github.com/JSONbored/loopover/commit/4dccaa6dde04064ea0a87583380ea6ef3de4fd92)), closes [#7754](https://github.com/JSONbored/loopover/issues/7754)
* **mcp:** register loopover_watch_issues as a local stdio tool ([#7961](https://github.com/JSONbored/loopover/issues/7961)) ([43099df](https://github.com/JSONbored/loopover/commit/43099df099a044db30d402601c7ffa84f72a55f5)), closes [#7763](https://github.com/JSONbored/loopover/issues/7763)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @loopover/engine bumped from ^3.4.0 to ^3.5.0

## [3.4.0](https://github.com/JSONbored/loopover/compare/mcp-v3.3.0...mcp-v3.4.0) (2026-07-18)


### Features

* **api:** add a REST route + CLI mirror for loopover_check_test_evidence ([#6810](https://github.com/JSONbored/loopover/issues/6810)) ([d45d8fd](https://github.com/JSONbored/loopover/commit/d45d8fd6eb12c1f85b66912097d1a562e900ad13)), closes [#6749](https://github.com/JSONbored/loopover/issues/6749)
* **api:** add a REST route + CLI mirror for loopover_evaluate_escalation ([#6805](https://github.com/JSONbored/loopover/issues/6805)) ([f8d1628](https://github.com/JSONbored/loopover/commit/f8d1628e440211c5717b122c60f0124c563d4c92)), closes [#6754](https://github.com/JSONbored/loopover/issues/6754)
* **api:** add a REST route + CLI mirror for loopover_get_pr_ai_review_findings ([#6676](https://github.com/JSONbored/loopover/issues/6676)) ([885336a](https://github.com/JSONbored/loopover/commit/885336a240623e56f0581f609e837cada2cbb5f0)), closes [#6619](https://github.com/JSONbored/loopover/issues/6619)
* **api:** add a REST route + CLI mirror for loopover_simulate_open_pr_pressure ([#6915](https://github.com/JSONbored/loopover/issues/6915)) ([68b8694](https://github.com/JSONbored/loopover/commit/68b8694e278d9bb72cb78ae58a0778bd40a3be0e)), closes [#6751](https://github.com/JSONbored/loopover/issues/6751)
* **api:** add a REST route + CLI mirror for loopover_suggest_boundary_tests ([80869bd](https://github.com/JSONbored/loopover/commit/80869bd99b08681541862392712b4511011451b5))
* **api:** add a REST route + CLI mirror for loopover_suggest_boundary_tests ([4d5212e](https://github.com/JSONbored/loopover/commit/4d5212ed794a3a2aba6a22f4c6fcfdb6b10fee0f)), closes [#6750](https://github.com/JSONbored/loopover/issues/6750)
* **api:** add GET /v1/repos/:owner/:repo/automation-state + CLI mirror ([#6742](https://github.com/JSONbored/loopover/issues/6742)) ([#6964](https://github.com/JSONbored/loopover/issues/6964)) ([c566906](https://github.com/JSONbored/loopover/commit/c56690697dd99c9688bfd133bdb4429f9e57eaf6))
* **api:** add POST /v1/repos/:owner/:repo/repo-docs/refresh + CLI mirror ([#6973](https://github.com/JSONbored/loopover/issues/6973)) ([f1e9632](https://github.com/JSONbored/loopover/commit/f1e96320cb1abe2dfaed5020249f608de7c7ec38))
* **api:** mirror loopover_propose_action to REST and the CLI ([#6744](https://github.com/JSONbored/loopover/issues/6744)) ([#7030](https://github.com/JSONbored/loopover/issues/7030)) ([a752b8f](https://github.com/JSONbored/loopover/commit/a752b8f7b9a04c37043c41ff855f18ee7eea7759))
* **api:** REST + CLI mirror for contributor notifications ([#6745](https://github.com/JSONbored/loopover/issues/6745)) ([#7018](https://github.com/JSONbored/loopover/issues/7018)) ([447ee82](https://github.com/JSONbored/loopover/commit/447ee826553ad98ef4d8d179100196e88882d202))
* **api:** REST + CLI mirror for loopover_build_results_payload ([#6904](https://github.com/JSONbored/loopover/issues/6904)) ([7f7ea50](https://github.com/JSONbored/loopover/commit/7f7ea500420f5cb88a073d668168f711b1fdaefd)), closes [#6752](https://github.com/JSONbored/loopover/issues/6752)
* **api:** REST + CLI mirror for loopover_check_improvement_potential ([#6955](https://github.com/JSONbored/loopover/issues/6955)) ([27c7c59](https://github.com/JSONbored/loopover/commit/27c7c59154be89a1eed39941124a22aa34af4744))
* **api:** REST + CLI mirror for loopover_explain_review_risk ([#6980](https://github.com/JSONbored/loopover/issues/6980)) ([#7026](https://github.com/JSONbored/loopover/issues/7026)) ([15715dc](https://github.com/JSONbored/loopover/commit/15715dc0c9bf7964964b7b22a884ec4c1a9202ae))
* **api:** REST + CLI mirror for loopover_intake_idea ([#6916](https://github.com/JSONbored/loopover/issues/6916)) ([f1fb812](https://github.com/JSONbored/loopover/commit/f1fb81209ddbd1381982f6bfaa972f50b3a10dab)), closes [#6755](https://github.com/JSONbored/loopover/issues/6755)
* **api:** REST + CLI mirror for loopover_pr_outcome ([#6747](https://github.com/JSONbored/loopover/issues/6747)) ([748acee](https://github.com/JSONbored/loopover/commit/748acee09f2bb097c6d80d4d054db7fcdd5b7c40))
* **api:** REST + CLI mirror for loopover_pr_outcome ([#6747](https://github.com/JSONbored/loopover/issues/6747)) ([efbe09c](https://github.com/JSONbored/loopover/commit/efbe09c4efb37dcf2e060c141c922cb022b75595))
* **api:** REST + CLI mirror for loopover_watch_issues ([#7153](https://github.com/JSONbored/loopover/issues/7153)) ([13cb8a3](https://github.com/JSONbored/loopover/commit/13cb8a3909d31e2f1b95963e734073ae985646b7)), closes [#6746](https://github.com/JSONbored/loopover/issues/6746)
* **api:** REST + stdio mirror for loopover_build_progress_snapshot ([#6943](https://github.com/JSONbored/loopover/issues/6943)) ([d6cf892](https://github.com/JSONbored/loopover/commit/d6cf8925ddffd622c91e83c25ab1079e80371484))
* **api:** REST + stdio mirror for loopover_plan_idea_claims ([#6952](https://github.com/JSONbored/loopover/issues/6952)) ([8fa47d1](https://github.com/JSONbored/loopover/commit/8fa47d1511add3073a316a98f4f69b49767e77c1)), closes [#6756](https://github.com/JSONbored/loopover/issues/6756)
* **mcp:** add a contributor-profile CLI command ([#6961](https://github.com/JSONbored/loopover/issues/6961)) ([484c9c8](https://github.com/JSONbored/loopover/commit/484c9c8d7ea0769e7e05db112be6404e82fb7304))
* **mcp:** add a loopover_get_bounty_advisory CLI mirror ([#6954](https://github.com/JSONbored/loopover/issues/6954)) ([7733371](https://github.com/JSONbored/loopover/commit/77333710e881f8c3848513bec6e4410b0f3f4634))
* **mcp:** add a loopover_get_maintainer_lane CLI mirror ([#6942](https://github.com/JSONbored/loopover/issues/6942)) ([71bc183](https://github.com/JSONbored/loopover/commit/71bc1833f6c35f4bbcd34f61492203edad290937))
* **mcp:** add a maintain audit-feed CLI mirror for loopover_get_agent_audit_feed ([#6733](https://github.com/JSONbored/loopover/issues/6733)) ([#6933](https://github.com/JSONbored/loopover/issues/6933)) ([5347291](https://github.com/JSONbored/loopover/commit/5347291b63dbf6d45f47ed19da530b2371078554))
* **mcp:** add a maintain outcome-calibration CLI mirror ([#6960](https://github.com/JSONbored/loopover/issues/6960)) ([a4310f1](https://github.com/JSONbored/loopover/commit/a4310f1ca34fd22758275a8033247f537f1dc6a7))
* **mcp:** add maintain onboarding-pack CLI mirror ([#6913](https://github.com/JSONbored/loopover/issues/6913)) ([96ee9c4](https://github.com/JSONbored/loopover/commit/96ee9c4a7c34da2fe987e1c2e92f101570e4dd39))
* **mcp:** CLI mirror for loopover_draft_pr_body ([#6974](https://github.com/JSONbored/loopover/issues/6974)) ([13bd48b](https://github.com/JSONbored/loopover/commit/13bd48bb9342f993916b8deb79cf287994b41aaf))
* **mcp:** CLI mirror for loopover_explain_gate_disposition ([#6966](https://github.com/JSONbored/loopover/issues/6966)) ([4966070](https://github.com/JSONbored/loopover/commit/4966070447dd45fcd4d5a2549a7e0713ad10c678))
* **mcp:** CLI stdio mirror for loopover_get_repo_outcome_patterns ([#6962](https://github.com/JSONbored/loopover/issues/6962)) ([244988b](https://github.com/JSONbored/loopover/commit/244988bf1a9773644069ea1b3c759434159187ce))
* **mcp:** mirror contributor-issue-draft generation to an MCP tool + maintain CLI ([#7019](https://github.com/JSONbored/loopover/issues/7019)) ([bd4c172](https://github.com/JSONbored/loopover/commit/bd4c172ebfb4fe707898aaa29584235f897341d4)), closes [#6757](https://github.com/JSONbored/loopover/issues/6757)
* **mcp:** mirror loopover_monitor_open_prs to the stdio wrapper and CLI ([#6789](https://github.com/JSONbored/loopover/issues/6789)) ([544cb31](https://github.com/JSONbored/loopover/commit/544cb3157bb5ef56aeebfa712438cccf6d4f04b6))
* **mcp:** register loopover_close_pr write-tool in both MCP surfaces ([#6615](https://github.com/JSONbored/loopover/issues/6615)) ([#6715](https://github.com/JSONbored/loopover/issues/6715)) ([3f6591d](https://github.com/JSONbored/loopover/commit/3f6591d6ca3523357446f5e1e62510d401e7aa12))
* **mcp:** REST route + CLI mirror for loopover_get_eligibility_plan ([#6692](https://github.com/JSONbored/loopover/issues/6692)) ([bb028ec](https://github.com/JSONbored/loopover/commit/bb028ec06a0e5a3581049deb99eab534d5456836)), closes [#6621](https://github.com/JSONbored/loopover/issues/6621)
* **mcp:** REST routes + CLI resource mirrors for finding-taxonomy and enrichment-analyzers ([#6709](https://github.com/JSONbored/loopover/issues/6709)) ([b0677cd](https://github.com/JSONbored/loopover/commit/b0677cd5ca13998d88071ae71437feb6c18574e4)), closes [#6620](https://github.com/JSONbored/loopover/issues/6620)


### Fixes

* **api:** blunt slop-risk / issue-slop REST + CLI to match the MCP tools ([#6990](https://github.com/JSONbored/loopover/issues/6990)) ([#7052](https://github.com/JSONbored/loopover/issues/7052)) ([9971476](https://github.com/JSONbored/loopover/commit/99714764769db457ad7e9ae4ef7ffa97b3895fed))
* **apps:** update remaining gittensory references across loopover-miner-ui, loopover-ui, and loopover-miner-extension ([af6b16c](https://github.com/JSONbored/loopover/commit/af6b16c9feefdf68172be53899fcc8de4f97bb14))
* **apps:** update remaining gittensory references across loopover-miner-ui, loopover-ui, and loopover-miner-extension ([3287ab3](https://github.com/JSONbored/loopover/commit/3287ab3a49781b30279c8305df8c8f1be6e56fd1))
* **auth:** give device-flow polling its own rate-limit budget ([0244058](https://github.com/JSONbored/loopover/commit/0244058bd0779f767861c742c9988ac8ce8cf528))
* **auth:** give device-flow polling its own rate-limit budget ([1c566a0](https://github.com/JSONbored/loopover/commit/1c566a0c80e61ca2922b6fefe79e4c9c20b63f3e)), closes [#6792](https://github.com/JSONbored/loopover/issues/6792)
* **mcp:** honor --help on the contributor-profile CLI command ([4ac395a](https://github.com/JSONbored/loopover/commit/4ac395aa27b1af7e567d0e29af1b770178484261))
* **mcp:** honor --help on the contributor-profile CLI command ([dee57ea](https://github.com/JSONbored/loopover/commit/dee57ea42da094eecc28a3628f64c8368fedb1e5)), closes [#6992](https://github.com/JSONbored/loopover/issues/6992)
* **mcp:** list maintain and contributor-profile in --help ([#7036](https://github.com/JSONbored/loopover/issues/7036)) ([b153047](https://github.com/JSONbored/loopover/commit/b153047f7a14574f85de7cb6d94edf5cfc96189c))
* **mcp:** rename enrichment-analyzers resource URI to loopover:// ([feec18c](https://github.com/JSONbored/loopover/commit/feec18c286fcced9b72fe471728a1acfe6baf93c))
* **mcp:** rename enrichment-analyzers resource URI to loopover:// ([4d9d6c4](https://github.com/JSONbored/loopover/commit/4d9d6c42dbbe60050e7b2b8600fee6316632f324))
* **release:** scope MCP publish validation to its own package ([86ee117](https://github.com/JSONbored/loopover/commit/86ee11744f7c7d2f76c9d64345391f61651256c8))
* **test:** update grafana dashboard assertions for the historical-continuity query rewrite ([8cd0b24](https://github.com/JSONbored/loopover/commit/8cd0b2489e1b4f1803a310951f53f25d94ff6ddb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @loopover/engine bumped from ^3.3.0 to ^3.4.0

## [3.3.0](https://github.com/JSONbored/loopover/compare/mcp-v3.2.3...mcp-v3.3.0) (2026-07-18)


### Features

* **api:** REST + CLI mirror for loopover_watch_issues ([#7153](https://github.com/JSONbored/loopover/issues/7153)) ([13cb8a3](https://github.com/JSONbored/loopover/commit/13cb8a3909d31e2f1b95963e734073ae985646b7)), closes [#6746](https://github.com/JSONbored/loopover/issues/6746)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @loopover/engine bumped from ^3.2.3 to ^3.3.0

## [3.2.3](https://github.com/JSONbored/loopover/compare/mcp-v3.2.2...mcp-v3.2.3) (2026-07-18)


### Fixes

* **api:** blunt slop-risk / issue-slop REST + CLI to match the MCP tools ([#6990](https://github.com/JSONbored/loopover/issues/6990)) ([#7052](https://github.com/JSONbored/loopover/issues/7052)) ([9971476](https://github.com/JSONbored/loopover/commit/99714764769db457ad7e9ae4ef7ffa97b3895fed))
* **release:** scope MCP publish validation to its own package ([86ee117](https://github.com/JSONbored/loopover/commit/86ee11744f7c7d2f76c9d64345391f61651256c8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @loopover/engine bumped from ^3.2.2 to ^3.2.3

## [3.2.2](https://github.com/JSONbored/loopover/compare/mcp-v3.2.1...mcp-v3.2.2) (2026-07-17)


### Fixes

* **api:** blunt slop-risk / issue-slop REST + CLI to match the MCP tools ([#6990](https://github.com/JSONbored/loopover/issues/6990)) ([#7052](https://github.com/JSONbored/loopover/issues/7052)) ([9971476](https://github.com/JSONbored/loopover/commit/99714764769db457ad7e9ae4ef7ffa97b3895fed))
* **release:** scope MCP publish validation to its own package ([86ee117](https://github.com/JSONbored/loopover/commit/86ee11744f7c7d2f76c9d64345391f61651256c8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @loopover/engine bumped from ^3.2.1 to ^3.2.2

## [3.2.1](https://github.com/JSONbored/loopover/compare/mcp-v3.1.1...mcp-v3.2.1) (2026-07-17)


### Fixes

* **api:** blunt slop-risk / issue-slop REST + CLI to match the MCP tools ([#6990](https://github.com/JSONbored/loopover/issues/6990)) ([#7052](https://github.com/JSONbored/loopover/issues/7052)) ([9971476](https://github.com/JSONbored/loopover/commit/99714764769db457ad7e9ae4ef7ffa97b3895fed))
* **release:** scope MCP publish validation to its own package ([86ee117](https://github.com/JSONbored/loopover/commit/86ee11744f7c7d2f76c9d64345391f61651256c8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @loopover/engine bumped from ^3.0.0 to ^3.2.1

## [3.1.0](https://github.com/JSONbored/loopover/compare/mcp-v3.0.0...mcp-v3.1.0) (2026-07-17)


### Features

* **api:** add a REST route + CLI mirror for loopover_check_test_evidence ([#6810](https://github.com/JSONbored/loopover/issues/6810)) ([d45d8fd](https://github.com/JSONbored/loopover/commit/d45d8fd6eb12c1f85b66912097d1a562e900ad13)), closes [#6749](https://github.com/JSONbored/loopover/issues/6749)
* **api:** add a REST route + CLI mirror for loopover_evaluate_escalation ([#6805](https://github.com/JSONbored/loopover/issues/6805)) ([f8d1628](https://github.com/JSONbored/loopover/commit/f8d1628e440211c5717b122c60f0124c563d4c92)), closes [#6754](https://github.com/JSONbored/loopover/issues/6754)
* **api:** add a REST route + CLI mirror for loopover_get_pr_ai_review_findings ([#6676](https://github.com/JSONbored/loopover/issues/6676)) ([885336a](https://github.com/JSONbored/loopover/commit/885336a240623e56f0581f609e837cada2cbb5f0)), closes [#6619](https://github.com/JSONbored/loopover/issues/6619)
* **api:** add a REST route + CLI mirror for loopover_simulate_open_pr_pressure ([#6915](https://github.com/JSONbored/loopover/issues/6915)) ([68b8694](https://github.com/JSONbored/loopover/commit/68b8694e278d9bb72cb78ae58a0778bd40a3be0e)), closes [#6751](https://github.com/JSONbored/loopover/issues/6751)
* **api:** add a REST route + CLI mirror for loopover_suggest_boundary_tests ([80869bd](https://github.com/JSONbored/loopover/commit/80869bd99b08681541862392712b4511011451b5))
* **api:** add a REST route + CLI mirror for loopover_suggest_boundary_tests ([4d5212e](https://github.com/JSONbored/loopover/commit/4d5212ed794a3a2aba6a22f4c6fcfdb6b10fee0f)), closes [#6750](https://github.com/JSONbored/loopover/issues/6750)
* **api:** add GET /v1/repos/:owner/:repo/automation-state + CLI mirror ([#6742](https://github.com/JSONbored/loopover/issues/6742)) ([#6964](https://github.com/JSONbored/loopover/issues/6964)) ([c566906](https://github.com/JSONbored/loopover/commit/c56690697dd99c9688bfd133bdb4429f9e57eaf6))
* **api:** add POST /v1/repos/:owner/:repo/repo-docs/refresh + CLI mirror ([#6973](https://github.com/JSONbored/loopover/issues/6973)) ([f1e9632](https://github.com/JSONbored/loopover/commit/f1e96320cb1abe2dfaed5020249f608de7c7ec38))
* **api:** mirror loopover_propose_action to REST and the CLI ([#6744](https://github.com/JSONbored/loopover/issues/6744)) ([#7030](https://github.com/JSONbored/loopover/issues/7030)) ([a752b8f](https://github.com/JSONbored/loopover/commit/a752b8f7b9a04c37043c41ff855f18ee7eea7759))
* **api:** REST + CLI mirror for contributor notifications ([#6745](https://github.com/JSONbored/loopover/issues/6745)) ([#7018](https://github.com/JSONbored/loopover/issues/7018)) ([447ee82](https://github.com/JSONbored/loopover/commit/447ee826553ad98ef4d8d179100196e88882d202))
* **api:** REST + CLI mirror for loopover_build_results_payload ([#6904](https://github.com/JSONbored/loopover/issues/6904)) ([7f7ea50](https://github.com/JSONbored/loopover/commit/7f7ea500420f5cb88a073d668168f711b1fdaefd)), closes [#6752](https://github.com/JSONbored/loopover/issues/6752)
* **api:** REST + CLI mirror for loopover_check_improvement_potential ([#6955](https://github.com/JSONbored/loopover/issues/6955)) ([27c7c59](https://github.com/JSONbored/loopover/commit/27c7c59154be89a1eed39941124a22aa34af4744))
* **api:** REST + CLI mirror for loopover_explain_review_risk ([#6980](https://github.com/JSONbored/loopover/issues/6980)) ([#7026](https://github.com/JSONbored/loopover/issues/7026)) ([15715dc](https://github.com/JSONbored/loopover/commit/15715dc0c9bf7964964b7b22a884ec4c1a9202ae))
* **api:** REST + CLI mirror for loopover_intake_idea ([#6916](https://github.com/JSONbored/loopover/issues/6916)) ([f1fb812](https://github.com/JSONbored/loopover/commit/f1fb81209ddbd1381982f6bfaa972f50b3a10dab)), closes [#6755](https://github.com/JSONbored/loopover/issues/6755)
* **api:** REST + CLI mirror for loopover_pr_outcome ([#6747](https://github.com/JSONbored/loopover/issues/6747)) ([748acee](https://github.com/JSONbored/loopover/commit/748acee09f2bb097c6d80d4d054db7fcdd5b7c40))
* **api:** REST + CLI mirror for loopover_pr_outcome ([#6747](https://github.com/JSONbored/loopover/issues/6747)) ([efbe09c](https://github.com/JSONbored/loopover/commit/efbe09c4efb37dcf2e060c141c922cb022b75595))
* **api:** REST + stdio mirror for loopover_build_progress_snapshot ([#6943](https://github.com/JSONbored/loopover/issues/6943)) ([d6cf892](https://github.com/JSONbored/loopover/commit/d6cf8925ddffd622c91e83c25ab1079e80371484))
* **api:** REST + stdio mirror for loopover_plan_idea_claims ([#6952](https://github.com/JSONbored/loopover/issues/6952)) ([8fa47d1](https://github.com/JSONbored/loopover/commit/8fa47d1511add3073a316a98f4f69b49767e77c1)), closes [#6756](https://github.com/JSONbored/loopover/issues/6756)
* **mcp:** add a contributor-profile CLI command ([#6961](https://github.com/JSONbored/loopover/issues/6961)) ([484c9c8](https://github.com/JSONbored/loopover/commit/484c9c8d7ea0769e7e05db112be6404e82fb7304))
* **mcp:** add a loopover_get_bounty_advisory CLI mirror ([#6954](https://github.com/JSONbored/loopover/issues/6954)) ([7733371](https://github.com/JSONbored/loopover/commit/77333710e881f8c3848513bec6e4410b0f3f4634))
* **mcp:** add a loopover_get_maintainer_lane CLI mirror ([#6942](https://github.com/JSONbored/loopover/issues/6942)) ([71bc183](https://github.com/JSONbored/loopover/commit/71bc1833f6c35f4bbcd34f61492203edad290937))
* **mcp:** add a maintain audit-feed CLI mirror for loopover_get_agent_audit_feed ([#6733](https://github.com/JSONbored/loopover/issues/6733)) ([#6933](https://github.com/JSONbored/loopover/issues/6933)) ([5347291](https://github.com/JSONbored/loopover/commit/5347291b63dbf6d45f47ed19da530b2371078554))
* **mcp:** add a maintain outcome-calibration CLI mirror ([#6960](https://github.com/JSONbored/loopover/issues/6960)) ([a4310f1](https://github.com/JSONbored/loopover/commit/a4310f1ca34fd22758275a8033247f537f1dc6a7))
* **mcp:** add a typed PostHog wrapper module for packages/loopover-mcp ([7152db6](https://github.com/JSONbored/loopover/commit/7152db66465311cf807fbecc0d2e56e4ec99e8ab))
* **mcp:** add maintain onboarding-pack CLI mirror ([#6913](https://github.com/JSONbored/loopover/issues/6913)) ([96ee9c4](https://github.com/JSONbored/loopover/commit/96ee9c4a7c34da2fe987e1c2e92f101570e4dd39))
* **mcp:** CLI mirror for loopover_draft_pr_body ([#6974](https://github.com/JSONbored/loopover/issues/6974)) ([13bd48b](https://github.com/JSONbored/loopover/commit/13bd48bb9342f993916b8deb79cf287994b41aaf))
* **mcp:** CLI mirror for loopover_explain_gate_disposition ([#6966](https://github.com/JSONbored/loopover/issues/6966)) ([4966070](https://github.com/JSONbored/loopover/commit/4966070447dd45fcd4d5a2549a7e0713ad10c678))
* **mcp:** CLI stdio mirror for loopover_get_repo_outcome_patterns ([#6962](https://github.com/JSONbored/loopover/issues/6962)) ([244988b](https://github.com/JSONbored/loopover/commit/244988bf1a9773644069ea1b3c759434159187ce))
* **mcp:** mirror contributor-issue-draft generation to an MCP tool + maintain CLI ([#7019](https://github.com/JSONbored/loopover/issues/7019)) ([bd4c172](https://github.com/JSONbored/loopover/commit/bd4c172ebfb4fe707898aaa29584235f897341d4)), closes [#6757](https://github.com/JSONbored/loopover/issues/6757)
* **mcp:** mirror loopover_monitor_open_prs to the stdio wrapper and CLI ([#6789](https://github.com/JSONbored/loopover/issues/6789)) ([544cb31](https://github.com/JSONbored/loopover/commit/544cb3157bb5ef56aeebfa712438cccf6d4f04b6))
* **mcp:** record local stdio tool calls at the dispatch chokepoint ([#6432](https://github.com/JSONbored/loopover/issues/6432)) ([45fe399](https://github.com/JSONbored/loopover/commit/45fe39900bd9715baf7fbc330dff7c3b447a51e6)), closes [#6238](https://github.com/JSONbored/loopover/issues/6238)
* **mcp:** register loopover_close_pr write-tool in both MCP surfaces ([#6615](https://github.com/JSONbored/loopover/issues/6615)) ([#6715](https://github.com/JSONbored/loopover/issues/6715)) ([3f6591d](https://github.com/JSONbored/loopover/commit/3f6591d6ca3523357446f5e1e62510d401e7aa12))
* **mcp:** register plan-DAG tools + local scorer in packages/loopover-mcp ([1aa6603](https://github.com/JSONbored/loopover/commit/1aa66037568c31e3f00f0379542f66d4836d166c))
* **mcp:** register plan-DAG tools + local scorer in packages/loopover-mcp ([f096969](https://github.com/JSONbored/loopover/commit/f09696971fbf7b6dda7d261fc1ea0f790942629f)), closes [#6150](https://github.com/JSONbored/loopover/issues/6150)
* **mcp:** register the 8 miner write-tools on the local stdio server ([#6390](https://github.com/JSONbored/loopover/issues/6390)) ([9197680](https://github.com/JSONbored/loopover/commit/9197680e355634629ec7cae5a0bd193ec6ca2eb7)), closes [#6149](https://github.com/JSONbored/loopover/issues/6149)
* **mcp:** register the maintain REST surface as local stdio tools ([#6382](https://github.com/JSONbored/loopover/issues/6382)) ([aa83a48](https://github.com/JSONbored/loopover/commit/aa83a48886ded90a8f3c7e264b1fa1d1589884d5)), closes [#6152](https://github.com/JSONbored/loopover/issues/6152)
* **mcp:** REST route + CLI mirror for loopover_get_eligibility_plan ([#6692](https://github.com/JSONbored/loopover/issues/6692)) ([bb028ec](https://github.com/JSONbored/loopover/commit/bb028ec06a0e5a3581049deb99eab534d5456836)), closes [#6621](https://github.com/JSONbored/loopover/issues/6621)
* **mcp:** REST routes + CLI resource mirrors for finding-taxonomy and enrichment-analyzers ([#6709](https://github.com/JSONbored/loopover/issues/6709)) ([b0677cd](https://github.com/JSONbored/loopover/commit/b0677cd5ca13998d88071ae71437feb6c18574e4)), closes [#6620](https://github.com/JSONbored/loopover/issues/6620)
* **mcp:** validate .loopover.yml offline by extracting buildFocusManifestValidation into @loopover/engine ([#6425](https://github.com/JSONbored/loopover/issues/6425)) ([22faecf](https://github.com/JSONbored/loopover/commit/22faecfe8eceb3a1762509b81ac9c6b26606d374)), closes [#6269](https://github.com/JSONbored/loopover/issues/6269)


### Fixes

* **apps:** update remaining gittensory references across loopover-miner-ui, loopover-ui, and loopover-miner-extension ([af6b16c](https://github.com/JSONbored/loopover/commit/af6b16c9feefdf68172be53899fcc8de4f97bb14))
* **apps:** update remaining gittensory references across loopover-miner-ui, loopover-ui, and loopover-miner-extension ([3287ab3](https://github.com/JSONbored/loopover/commit/3287ab3a49781b30279c8305df8c8f1be6e56fd1))
* **auth:** give device-flow polling its own rate-limit budget ([0244058](https://github.com/JSONbored/loopover/commit/0244058bd0779f767861c742c9988ac8ce8cf528))
* **auth:** give device-flow polling its own rate-limit budget ([1c566a0](https://github.com/JSONbored/loopover/commit/1c566a0c80e61ca2922b6fefe79e4c9c20b63f3e)), closes [#6792](https://github.com/JSONbored/loopover/issues/6792)
* **ci:** derive version-copy floor from single source of truth ([e449499](https://github.com/JSONbored/loopover/commit/e449499ca59ed8be64449faef35611b39469b8ff))
* **ci:** derive version-copy floor from single source of truth ([ab11e8b](https://github.com/JSONbored/loopover/commit/ab11e8b83d520d9fb3f0fb7242c2b4d08972c328)), closes [#6292](https://github.com/JSONbored/loopover/issues/6292)
* **config:** scrub remaining pre-rename gittensory references ([23152da](https://github.com/JSONbored/loopover/commit/23152dafcc1bbb329bdc63606dee311cdb4267cf))
* **config:** scrub remaining pre-rename gittensory references ([e4b0f8c](https://github.com/JSONbored/loopover/commit/e4b0f8cd4e24cbc7c14b157e7d660f73adca2115))
* **mcp:** honor --help on the contributor-profile CLI command ([4ac395a](https://github.com/JSONbored/loopover/commit/4ac395aa27b1af7e567d0e29af1b770178484261))
* **mcp:** honor --help on the contributor-profile CLI command ([dee57ea](https://github.com/JSONbored/loopover/commit/dee57ea42da094eecc28a3628f64c8368fedb1e5)), closes [#6992](https://github.com/JSONbored/loopover/issues/6992)
* **mcp:** list maintain and contributor-profile in --help ([#7036](https://github.com/JSONbored/loopover/issues/7036)) ([b153047](https://github.com/JSONbored/loopover/commit/b153047f7a14574f85de7cb6d94edf5cfc96189c))
* **mcp:** redact a parenthesis/bracket/colon-prefixed local path in redactLocalPath ([97e3e6b](https://github.com/JSONbored/loopover/commit/97e3e6bc9b490034dbabc7cefc9809f27445a0cf))
* **mcp:** rename enrichment-analyzers resource URI to loopover:// ([feec18c](https://github.com/JSONbored/loopover/commit/feec18c286fcced9b72fe471728a1acfe6baf93c))
* **mcp:** rename enrichment-analyzers resource URI to loopover:// ([4d9d6c4](https://github.com/JSONbored/loopover/commit/4d9d6c42dbbe60050e7b2b8600fee6316632f324))
* **mcp:** sanitize every terminal path that prints API-controlled text ([436c6c1](https://github.com/JSONbored/loopover/commit/436c6c1349c6bd382b35e8fb9bade8a58b57d399))
* **mcp:** sanitize every terminal path that prints API-controlled text ([7506cda](https://github.com/JSONbored/loopover/commit/7506cdad2ffa9e6442f58464f0bddf7bc238e73c)), closes [#6261](https://github.com/JSONbored/loopover/issues/6261)
* **test:** update grafana dashboard assertions for the historical-continuity query rewrite ([8cd0b24](https://github.com/JSONbored/loopover/commit/8cd0b2489e1b4f1803a310951f53f25d94ff6ddb))

## [3.0.0](https://github.com/JSONbored/loopover/compare/mcp-v2.0.1...mcp-v3.0.0) (2026-07-14)


### ⚠ BREAKING CHANGES

* **config:** every GITTENSORY_* environment variable is now LOOPOVER_*. No dual-read/alias, per the epic's full-cutover mandate. Operators must rename these in their .env / secrets before deploying this change.
* **build:** every gittensory-prefixed directory under apps/ and packages/ is now loopover-prefixed, and the two extension packages' npm names changed from @jsonbored/gittensory-* to @loopover/*. No dual-path/alias, per the epic's full-cutover mandate.

### Features

* **build:** Phase 5 - full-cutover rename all gittensory-* directories to loopover-* ([#5743](https://github.com/JSONbored/loopover/issues/5743)) ([81e4ac3](https://github.com/JSONbored/loopover/commit/81e4ac34dfb4dee9c3cadefcc27a515617462da9))
* **config:** Phase 6 - full-cutover rename internal GITTENSORY_* constants to LOOPOVER_* ([#5750](https://github.com/JSONbored/loopover/issues/5750)) ([12958f4](https://github.com/JSONbored/loopover/commit/12958f4f36cbf1f9f1ac732e718a4316e91cb103)), closes [#5705](https://github.com/JSONbored/loopover/issues/5705)

## [2.0.0](https://github.com/JSONbored/loopover/compare/mcp-v1.0.0...mcp-v2.0.0) (2026-07-14)


### ⚠ BREAKING CHANGES

* **config:** every GITTENSORY_* environment variable is now LOOPOVER_*. No dual-read/alias, per the epic's full-cutover mandate. Operators must rename these in their .env / secrets before deploying this change.
* **build:** every gittensory-prefixed directory under apps/ and packages/ is now loopover-prefixed, and the two extension packages' npm names changed from @jsonbored/gittensory-* to @loopover/*. No dual-path/alias, per the epic's full-cutover mandate.

### Features

* **build:** Phase 5 - full-cutover rename all gittensory-* directories to loopover-* ([#5743](https://github.com/JSONbored/loopover/issues/5743)) ([81e4ac3](https://github.com/JSONbored/loopover/commit/81e4ac34dfb4dee9c3cadefcc27a515617462da9))
* **config:** Phase 6 - full-cutover rename internal GITTENSORY_* constants to LOOPOVER_* ([#5750](https://github.com/JSONbored/loopover/issues/5750)) ([12958f4](https://github.com/JSONbored/loopover/commit/12958f4f36cbf1f9f1ac732e718a4316e91cb103)), closes [#5705](https://github.com/JSONbored/loopover/issues/5705)

## [1.0.0](https://github.com/JSONbored/gittensory/compare/mcp-v0.9.0...mcp-v1.0.0) (2026-07-14)


### ⚠ BREAKING CHANGES

* **cli:** `gittensory-miner`, `gittensory-miner-mcp`, and `gittensory-mcp` no longer exist as installed binaries; use `loopover-miner`, `loopover-miner-mcp`, and `loopover-mcp`. No dual-read/alias, per the epic's full-cutover mandate. A global npm install/link of the old package names must be reinstalled.

### Features

* **cli:** Phase 3 - full-cutover rename CLI binaries to loopover-* ([#5728](https://github.com/JSONbored/gittensory/issues/5728)) ([f2ee2ad](https://github.com/JSONbored/gittensory/commit/f2ee2ad24e0bf01d0a2dfd8f39421bb80aa527b6))

## [0.9.0](https://github.com/JSONbored/gittensory/compare/mcp-v0.8.1...mcp-v0.9.0) (2026-07-14)


### Features

* **mcp:** wire gittensory_feasibility_gate's claimStatus to the local claim ledger ([#5157](https://github.com/JSONbored/gittensory/issues/5157)) ([#5389](https://github.com/JSONbored/gittensory/issues/5389)) ([91b235d](https://github.com/JSONbored/gittensory/commit/91b235dbc4c9e3c818ff0a76e98f087c1f3ec8c2))

## [0.8.0](https://github.com/JSONbored/gittensory/compare/mcp-v0.7.1...mcp-v0.8.0) (2026-07-14)


### Features

* **mcp:** wire gittensory_feasibility_gate's claimStatus to the local claim ledger ([#5157](https://github.com/JSONbored/gittensory/issues/5157)) ([#5389](https://github.com/JSONbored/gittensory/issues/5389)) ([91b235d](https://github.com/JSONbored/gittensory/commit/91b235dbc4c9e3c818ff0a76e98f087c1f3ec8c2))

## [0.7.1](https://github.com/JSONbored/gittensory/compare/mcp-v0.7.0...mcp-v0.7.1) (2026-07-08)


### Fixes

* **release:** sync package-lock.json via script, not release-please extra-files ([#4179](https://github.com/JSONbored/gittensory/issues/4179)) ([b614317](https://github.com/JSONbored/gittensory/commit/b614317e506fab3b30bf7fc366d67e268952ba02))

## Changelog

## mcp-v0.7.0 - 2026-07-08

### Features
- LoopOver_explain_score_breakdown (#649)
- LoopOver_remediation_plan (#650)
- Expose gate.mergeReadiness + gate.firstTimeContributorGrace in .loopover.yml (#822) (#826)
- Focus-manifest policy as enforceable gate input (#555) (#827)
- Autonomy-levels framework (#773) (#840)
- AutoMaintain config block + dashboard (#774) (#841)
- Kill-switch + dry-run + action audit (#776) (#842)
- Deterministic local scorer MCP tool (#782) (#847)
- Miner write-tools — local-execution action specs (#780) (#848)
- Multi-step plan DAG tools (#783) (#849)
- Harness adapter — miner-auto-dev profile + driving loop (#781) (#850)
- MCP automation-state read tool (advances #784) (#851)
- Maintainer CLI controls — maintain status/approve/reject/pause/resume (#852)
- CLI set-level + MCP propose-action — non-dashboard #784 surfaces (#854)
- Wire issue-discovery/issue-spam scoring constants into engine (#835)
- Audit repository-settings flag enforcement (Fixes #797) (#915)
- Approval-queue control tools — list + decide pending agent actions (#784) (#934)
- Agent audit feed — surface executed actions + approval decisions (#784) (#937)
- Slop signal — generic/empty commit message (#564) (#938)
- Slop signal — no linked issue without rationale (#562) (#962)
- Model upstream review-collateral and non-code caps (Fi… (#1049)
- Expose outcome calibration via gittensory_get_outcome_calibration (#1174)
- Add draft-PR awareness to classification and queue health (#1189)
- Add selfAuthoredLinkedIssueGateMode with config-as-code parity (#1198)
- DB-backed global kill-switch (instant freeze, no redeploy) (#1243)
- Surface fleet calibration analytics via dashboard + MCP (#1268)
- Add .loopover.yml review.profile (chill / balanced / assertive) (#review-profile) (#1347)
- Add .loopover.yml review.path_instructions (per-path AI review rules) (#review-path-instructions) (#1350)
- Add .loopover.yml review.exclude_paths (skip files from AI review) (#review-exclude-paths) (#1353)
- Add .loopover.yml review.pre_merge_checks (deterministic pre-merge assertions) (#review-pre-merge-checks) (#1357)
- Add container-private per-repo config dir (#1390)
- Predict the manifest path policy + path-gated pre-merge checks via changedPaths (#1413)
- Add the per-repo contributor blacklist config layer (#1425) (#1429)
- Add configurable per-repo blacklistLabel (#1425) (#1430)
- Wire contributor validity floors into score preview (#808) (#1284)
- Delegate isTestFile to test-evidence isTestPath (#1306)
- Reward-risk severity taxonomy, opportunity factors, eligibility gap (#816) (#1351)
- Expose maintainer queue-noise triage via gittensory_get_maintainer_noise (#1414)
- Emit structured inline review findings + a review.inline_comments toggle (#1525)
- Per-repo feature config + all-authors AI review + RAG embed stack (#1555)
- Make the owner-PR close-exemption per-repo configurable (closeOwnerAuthors) (#1556)
- Per-repo .loopover.yml review.instructions for grounded reviews (#1579)
- Per-repo review CLAUDE.md + skill library from the container-private config dir (#1580)
- Size + guardrail manual-review HOLD in the disposition (advisory-friendly) (#1584)
- Dry-run disposition — render the would-be merge/close/manual verdict without enforcing (#1588)
- Expose maintainer-lane triage via gittensory_get_maintainer_lane (#1456)
- Gate AI close on a calibrated, configurable confidence threshold (#1599)
- Expose repo label-policy audit via gittensory_get_label_audit (#1461)
- Let doctor --exit-code gate CI with a non-zero exit on failure (#1444)
- Add PowerShell shell completion (#1448)
- Wire Codex reviews and secure observability (#1678)
- Add VS Code host to init-client config (#1770)
- Add cache list to inspect cached decision packs (#1800)
- Suggest the closest command on an unknown command (#1868)
- Surface the non-code line cap in the score breakdown (#1978)
- Surface the saturated base-score value in the score breakdown (#2356)
- Add contributorOpenPrCap/contributorOpenIssueCap config (#2270) (#2467)
- Auto-close a contributor's PR over the open-PR cap (#2270) (#2479)
- Add a review-request nagging cooldown (#2463) (#2530)
- Re-check migration-file collisions against live main before merge (#2550) (#2585)
- Force a fresh rebase + CI recheck immediately before merge when base has advanced (#2616)
- Classify supported-but-outdated MCP clients as stale (#2622)
- Add lint-pr-text CLI for pre-push PR text checks (#2623)
- Add an account-age throttle for ban-evasion (#2642)
- Generalize the review-nag cooldown into a per-command rate limit (#2637)
- Add a security-focused review profile toggle (#2675)
- Add a lockfile-tamper-risk check (#2676)
- Expose dual-AI combine strategy as a per-repo setting (#2677)
- Add slop-risk CLI for pre-push slop self-checks (#2655)
- Cancel in-flight CI runs when a PR is auto-closed for the contributor cap (#2662)
- Add gittensory_find_opportunities to the stdio surface (#2694)
- Add a CLA / license-compatibility gate dimension (#2679)
- Add analyze and prepare plan-DAG templates to the shared engine (#2718)
- Gate priority label on linked-issue label propagation (#2750)
- Add issue-slop CLI for issue-quality self-checks (#2772)
- Add a modular moderation-rules engine with a cross-repo violation ledger (#2746)
- Add review.enrichment analyzer per-lane toggles (#2808)
- Make orb check publication configurable (#2863)
- Add .loopover.yml surface to enable/scope repo-doc generation (#3169)
- Scheduled + on-demand refresh for repo-doc generation (#3202)
- Support arbitrary self-host type labels (#3232)
- Auto-match PRs to open GitHub Milestones in suggest-mode (#3183) (#3256)
- Add Linear backend for project/milestone matching (#3290)
- Add review-evasion protection (#3414)
- Add review.path_filters include/negation globs (#2043) (#3494)
- Add review.auto_review eligibility filters (#1954) (#3499)
- Add auto_pause_after_reviewed_commits knob (#2042) (#3503)
- Add review.tone public-safe voice brief knob (#2044) (#3507)
- Skip ignored auto-review authors (#3508)
- Add review.labeling_rules deterministic label suggestions (#2045) (#3534)
- Hold PRs that solve an unlinked open issue (#3513)
- Add per-repo review.ai_model overrides for claude-code/codex (#3570)
- Render AI-suggested fixes as GitHub suggested-change blocks (#3577)
- Render a deterministic changed-files summary in the unified comment (#1957) (#3604)
- Tag AI review findings with a category taxonomy (#1958) (#3634)
- Add per-repo review.visual capture config (#3644)
- Add review.linkedIssueSatisfaction knob (off/advisory/block, default off) (#2173) (#3665)
- Add deterministic review-effort chip and wire real per-PR minutes (#3666)
- Add review.visual.themes config for dark-mode capture (#3680)
- Skip auto-review when a configured label is present via review.auto_review.skip_labels (#3686)
- Skip auto-review of docs-only PRs via review.auto_review.skip_docs_only (#3690)
- Size-cap eligibility guard for auto-review via max_added_lines / max_files (#3693)
- Post a quiet "review skipped (reason)" status when auto-review eligibility fails (#3694)
- Add scroll-through GIF evidence capture (#3612) (#3688)
- Add review.min_finding_severity display floor for inline findings (#3718)
- Add review.max_findings display caps for blockers/nits (#2049) (#3783)
- Compose preflight, slop-risk, and pr-text-lint into review-pr (#3791)
- Add boundary-safe test-generation advisory (#1972) (#3794)
- Add maintainer review recap digest builder + Discord delivery (#3801)
- Boundary-safe test-generation spec + framework detector (#3795)
- Add review.comment_verbosity output-detail knob (#3804)
- Deterministic impact map (#2182-#2186) (#3796)
- Add cached repo quality-culture profile as AI-review grounding (#3802)
- Add review.fixHandoff toggle (default off) for fix-handoff blocks (#2176) (#3824)
- Add follow-up issue local-write action spec (#2177) (#3836)
- Add suppression-signal data model + memory matcher (#3841)
- Add fix-handoff block renderer + follow-up-issue MCP spec (#3834)
- Add public per-repo review-quality leaderboard (#2568) (#3846)
- Add review.auto_merge_summary read-only knobs surface (#2051) (#3855)
- Validate .loopover.yml against schema (fail clearly pre-review) (#3823)
- Extract scoring preview/model into gittensory-engine (#2282) (#3849)
- Add opt-in oldest-first ordering mode to selectRegateCandidates (#3815) (#3867)
- Add config-driven before/after screenshot-table gate (#3877)
- Per-category inline-comment cap (#2159) (#3874)
- Extract focus-manifest parse/compile core (#2280) (#3891)
- Add gittensory_find_opportunities to hosted Worker (#2308) (#3986)
- Add review.shared_config operator overlay (#2046) (#3995)
- Add gittensory_validate_config tool for .loopover.yml (#4049)
- Wire linked-issue satisfaction into the deterministic gate (#4069)
- Upgrade inlineComments + fixHandoff to full config-as-code substitutes (#4116)

### Fixes
- Report package version 0.6.0 (#751)
- Resolve contributor confirmation for gate prediction (#715)
- Match upstream gittensor constant name + fallback value (#815)
- Authenticate public GitHub profile fetches (#819)
- Require live write access for staged actions (#859)
- Debounce miner dashboard refresh jobs (#867)
- Apply time decay to score breakdown (#881)
- Redact private preflight workspace signals (#885)
- Fail closed on branch eligibility (#891)
- Keep public-safe packets free of private evidence (#892)
- Keep predicted gate on public manifest (#903)
- Avoid request-time burden forecast scans (#906)
- Redact private rerun hints from PR packet (#907)
- Include rejected feedback outcomes (#914)
- Keep PR body draft taxonomy public-safe (#909)
- Count pending approvals accurately (#878)
- Cap contributor graph file path loading (#894)
- Avoid public manifest cache poisoning (#922)
- Wire open-PR pressure scenarios into the branch scenario summary (#348) (#923)
- Scope open PR pressure count to repo (#939)
- Compare local branch repo names case-insensitively (#965)
- Gate approval queue by repo maintainer scope (#941)
- Wire trusted open issue counts (#940)
- Include open issue counts in score breakdown (#971)
- Surface snapshot warnings in previews (#985)
- Apply penalty label multipliers instead of flooring to 1 (#1038)
- Cap non-code explicit totals (#1102)
- Gate non-confirmed contributors normally (eliminate the manual-review backlog) (#1140)
- Blunt slop oracle score output and add per-actor tool rate-limit (#1194)
- Guard credibility against non-finite stale and unlinked counts (#1155)
- Single-source fallbacks from DEFAULT_SCORING_CONSTANTS (Fixes #812) (#1240)
- Linear-time manifest glob matcher (ReDoS) + **/ matches root + glob length cap (#1366)
- Redact /root/ local paths on the public-safety boundary (#1376)
- Protect private policy surfaces (#1405)
- Match labelMultipliers keys as fnmatch globs (#1273) (#1277)
- Truncate per-repo grace_period_hours to int for upstream parity (#1320) (#1326)
- Report real changed line counts for renamed files (#1379)
- Bound predict gate changed paths (#1438)
- Gate maintainer noise behind maintainer access (#1464)
- Preserve segment boundaries for globstar paths (#1426)
- Harden label glob translation (#1450)
- Preserve cached review instructions (#1586)
- Anchor the draft title pattern to genuine markers (#1529)
- Add shared/global contributor blacklist (#1531)
- Redact /root/ and forward-slash Windows paths in the manifest public-safe guard (#1688)
- Preserve repo casing for open PR lookups
- Clamp fixed_base_score and SRC_TOK_SATURATION_SCALE to documented bounds (#1744) (#1745)
- Redact /var/ paths in the manifest public-safe guard (#1749)
- Centralize public local-path redaction across drifted surfaces (#1748)
- Match configured label globs in config quality and label audit (#1769) (#1774)
- Reduce rate-limit retry storms (#1866)
- ParseGitRemote accepts trailing-slash GitHub URLs (#1887)
- Align maintainer digest failing-check detection with readiness classifier (#1902)
- Count focused validation runs as passing evidence (#1912)
- Avoid regex slash trimming in remote parsing (#1947)
- Word-boundary linked-issue closing keywords (#1988)
- Pin gittensory_propose_action to the PR's current head (#2355)
- Scope the static MCP token to an operator-configured repo allowlist (#2274)
- Count cypress/e2e and snapshot paths as test files (#2120)
- Downgrade readiness gate mode block to advisory (#2384)
- Mark gate.firstTimeContributorGrace as reserved/inert (#2411)
- Distinguish an executor error from a clean accept (#2428)
- Honor settings.commandAuthorization in .loopover.yml (#2385)
- Scope LOOPOVER_MCP_TOKEN read access to an operator allowlist (#2464)
- Cap labelPatternToRegExp wildcard groups to prevent ReDoS (#2482)
- Bound label pattern cache (#2513)
- Match label history against config labels case-insensitively (#2580)
- Wire badgeEnabled into the .loopover.yml manifest parser (#2598)
- Parse gate tri-state modes case-insensitively in manifest (#2612)
- Cap review-nag cooldown (#2634)
- Classify .mjs/.cjs/.mts/.cts as code and test files (#2665)
- Scope label automation for one-shot reviews (#2719)
- Decouple taxonomy labels from outcome labels (#2735)
- Derive direct-PR lane preference from public-safe test expectations (#2792)
- Re-sync isTestFile with the server isTestPath (pytest prefix + JVM/C#/Swift) (#2753)
- Count C#/Swift/Groovy source as code files (#2776)
- Re-sync score-preview classifiers with the server test/code conventions (#2822)
- Bind CLA checks to trusted app slug (#2815)
- Keep review queue live and verify configured CI (#2843)
- Classify PHP source files as code (#2845)
- Route repository-settings reads through the resolver, not the raw DB accessor (#2920)
- Make guardrails and review labels configurable (#2943)
- Clamp time-decay override params to their documented bounds (#703) (#2948)
- Reuse test matcher for branch summaries (#2964)
- Keep label classes with a literal dash after a range matchable (#2973)
- Bound lint-pr-text body file reads (#2945)
- Make hard guardrails authoritative (#2974)
- Classify native source for test evidence (#2979)
- Make guardrail paths config-only (#2981)
- Order prerelease identifiers by semver precedence (#3049)
- Use precision-safe numeric comparison in the CLI update-check semver comparator (#3053)
- Tighten reward labels and linked issue gates (#3067)
- Exempt the maintainer lane from the issue-discovery validity floor (#3071)
- Keep focus-areas guidance for the public-safe wanted paths (#3079)
- Classify Dart/Flutter *_test.dart files as tests (#3092)
- Reject non-positive or non-finite label multipliers before they reach the score formula (#3124)
- Classify PHP preview tests (#3223)
- Classify Vue/Svelte/Astro across all code classifiers (#3292)
- Classify .cc and .hpp C++ source across all classifiers (#3301)
- Classify Dart source across all code classifiers (#3316)
- Explain validation and guardrail holds (#3304)
- Bound custom type label cleanup (#3552)
- Clamp visual route capture limit (#3697)
- Move isTestFile/isCodeFile out of local-branch.ts to unbreak ui:typecheck (#3709)
- Hold required AI skips from PR metadata (#3721)
- Exclude generated Dart from code scoring (#3724)
- Sanitize follow-up issue paths (#3970)
- Map review preflight status (#3972)
- Keep boundary suggestions source-free (#3955)
- Apply the no-issue-rationale exemption to all linked-issue findings (#4064)
- Sanitize validate-config terminal output (#4090)
- Bound opportunity target fanout (#4072)
- Build gittensory-engine before the publish gate + switch to workflow_dispatch (#4135)

### Security
- Bound focus manifest ingestion (#890)

### Refactors
- Remove metagraphed-specific hardcoding from the registry-review engine (#2443)
- Extract gate:-to-settings override mapping into its own function (#3373)

### Dependencies
- Update MCP release dependency stack (agents ^0.13.3 -> ^0.17.3)

### Chores
- Update github actions (#997)
- Update github actions to v6 (#1009)
- Update github actions to v7 (#1031)
- Update github actions to v24.18.0 (#1723)

## mcp-v0.6.0 - 2026-06-14

### Features
- Add missing test evidence slop signal (#616)
- LoopOver_validate_linked_issue linked-issue multiplier validator (#622)
- LoopOver_check_before_start pre-start duplicate/solvability check (#621)
- Authoritative .loopover.yml gate config (config-as-code) (#647)
- Dual-AI maintainer review + BYOK (Phase C) (#652)
- Config-as-code provider/model + maintainer self-serve BYOK routes (#664)
- Event→subscription→delivery service + MCP badge feed (closes #536, advances #535) (#707)
- Policy-pack-pluggable gate — gittensor + oss-anti-slop packs (#692) (#710)
- Agent-native pre-submission self-check as a general product (#693) (#712)
- Surface the earn-on-Gittensor path for oss-anti-slop adopters (#694) (#713)
- Miner-facing post-merge reward & outcome attribution (#702) (#714)
- Wire + modernize the deterministic slop score into the gate, context & MCP (#530/#531/#532) (#716)
- AI-assisted advisory slop layer (advisory-only, never blocks) (#724)
- Issue-side slop triage (#533) (#729)
- Model upstream time-decay, applied behind a default-off flag (#703) (#731)
- LoopOver_lint_pr_text commit/PR-body rubric linter (#634)
- Per-repo time-decay hyperparameters + go live (#703) (#733)
- Active issue-watch monitor — gittensory_watch_issues (#699 path B) (#735)
- Slop self-check tools + release @jsonbored/gittensory-mcp v0.6.0 (#745)

### Fixes
- Bound local branch scenario inputs (#614)
- Harden manifest public-safe filter (#659)
- Enforce repo scope for gate prediction (#717)
- Bound mark-read ids (#718)
- Visibility-aware access gate for subscriptions + fan-out (#742)

### Refactors
- Shared public-safe redaction module (#542) (#743)

### Chores
- Add outputSchema to every tool that lacks it (#637)

## mcp-v0.5.0 - 2026-06-12

### Features
- Cache last-good decision packs (#266)
- Add risk-adjusted action portfolio (#219)
- Summarize repo tradeoffs (#323)
- Add multi-account profile support (#263)
- Add agent action explanation cards (#232)
- Add recommendation outcome feedback (#229)
- Add duplicate and stale-work scenario blockers (#346)
- Add structured output schemas for existing tools (#344)
- Add miner planning prompts (#342)
- Define focus-manifest policy schema (#339)
- Persist recommendation outcome events (#334)
- Persist privacy-safe role on product usage events (#355)
- Feed aggregate outcome quality into confidence (#332)
- Add version command and clearer unknown-command guidance (#333)
- Add roots-aware workspace detection (#364)
- Add safe planning elicitation (#371)
- Add recommendation snapshot ids (#374)
- Add counterfactual reasons (#361)
- Add native resources, prompts, and structured output schemas (#360)
- Add queue pressure trend windows (#368)
- Add public-safe PR body drafting command (#382)
- Add shell completion command for bash, zsh, and fish (#400)
- Group doctor onboarding checks (#421)
- Add config command reporting resolved configuration provenance (#335)
- Derive contribution lanes from focus manifests (#337)
- Wire policy compiler into registration readiness (#350)
- Add contribution policy snapshot API (#369)
- Add LoopOver repo focus manifest (#118) (#389)
- Render public-safe scenario summaries (#416)
- Require 0.5.0 as the current supported client

### Fixes
- Surface npm latest across ui (#258)
- Scope decision-pack cache to auth token (#314)
- Remove default profile session cleanly (#327)
- Align registry changes output schema (#366)
- Enforce workspace roots for structured local status
- Include completion command in shell completions
- Shell-quote doctor next commands (#439)
- Report source upload env in config (#441)
- Clamp lane shares to match preview math (#453)
- Base open-PR threshold on merged history only (#455)
- Scope issue-quality reports to repo access (#483)
- Scope MCP repo access (#484)
- Preserve HTTP status for non-JSON errors (#489)
- Keep repo outcome patterns private (#493)
- Bound duplicate detection inputs (#497)
- Require solved-by-PR evidence for linked issues (#506)
- Reject prototype agent profile names (#507)
- Include config in completions (#509)
- Wire duplicate risk preview input (#512)
- Redact windows home paths in public PR packets (#514)
- Subject over-long manifest entries to dedup and list cap (#524)

### Security
- Bound focus manifest ingestion (#494)

## mcp-v0.4.0 - 2026-06-02

### Features
- Add lifecycle watcher signals (#29)
- Add local workspace intelligence v2 (#70)
- Monitor open PRs and wire into decision packs (#72)
- Validate linked issue multiplier (#179)
- Classify control-panel roles (#189)
- Add privacy-safe usage event spine (#182)
- Track MCP compatibility adoption (#185)
- Ingest maintainer focus manifests for repo-specific guidance (#191)
- Learn accepted and rejected PR patterns by repo (#75)
- Model branch eligibility for issue PRs (#178)
- Add recommendation confidence provenance (#226)
- Add contributor evidence graph (#218)
- Require 0.4.0 as the current supported client

### Fixes
- Saturation-model contribution bonus capped at 5 instead of 25 (#181)
- Bound local scorer warning diagnostics (#210)
- Scope open PR monitor public actions (#208)
- Pending-PR projection double-counting merge-ready PRs (#222)

### Security
- Keep maintainer notes out of branch guidance (#213)

### Docs
- Add coverage buffer and contributor test-quality guidance (#55)

### Dependencies
- Update MCP release dependency stack (@modelcontextprotocol/sdk 1.26.0 -> 1.29.0, zod ^3.25.76 -> ^4.4.3, @asteasolutions/zod-to-openapi ^7.3.4 -> ^8.5.0, agents ^0.7.9 -> ^0.13.3)

## mcp-v0.3.0 - 2026-05-31


### Features

- Detect stale installs and API compatibility in doctor and status (#28)

- Generate public-safe pr packets (#53)

- Harden local scorer adapter setup (#27)

- Parse validation command summaries (#121)



### Fixes

- Isolate release write token

- Keep repo root out of API payloads

- Block snake case private PR packet signals


## mcp-v0.2.0 - 2026-05-28


### Features

- Add deterministic base-agent orchestrator (#14)



### Fixes

- Create GitHub releases for MCP tag publishes

- Use first-level api domain

- Ignore stale beta api origins


## mcp-v0.1.4 - 2026-05-26


### Features

- Add public registration polish gates


## mcp-v0.1.3 - 2026-05-26


### Features

- Add install site and mcp diagnostics

- Add situational score projections
