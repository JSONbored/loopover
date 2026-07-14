# Changelog

## [2.0.0](https://github.com/JSONbored/gittensory/compare/engine-v1.0.0...engine-v2.0.0) (2026-07-14)


### ⚠ BREAKING CHANGES

* **miner:** the miner's default config directory and every gittensory_miner_* Prometheus metric name changed; no dual-read/alias, per the epic's full-cutover mandate ([#5705](https://github.com/JSONbored/gittensory/issues/5705)). A self-hoster's existing ~/.config/gittensory-miner state does not migrate automatically.
* **github:** the bot no longer recognizes @gittensory as a command trigger anywhere -- only @loopover works. Any saved PR-comment template, bookmark, or muscle-memory referencing @gittensory <command> must be updated to @loopover <command>.
* **miner:** every GITTENSORY_MINER_*/GITTENSORY_API_TOKEN_FILE/ GITTENSORY_MCP_TOKEN_FILE/GITTENSORY_MEM_LIMIT/GITTENSORY_REPORTING_* env var an existing self-hosted AMS/miner deployment sets must be renamed to its LOOPOVER_ equivalent -- the old names are no longer read.
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
* **miner:** rename GITTENSORY_MINER_*/GITTENSORY_* env vars to LOOPOVER_MINER_*/LOOPOVER_* ([#5707](https://github.com/JSONbored/gittensory/issues/5707)) ([6714f0c](https://github.com/JSONbored/gittensory/commit/6714f0cac5ab37477c7f56332cde969788c7996e)), closes [#5705](https://github.com/JSONbored/gittensory/issues/5705)
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
