# Changelog

## [0.2.0](https://github.com/JSONbored/gittensory/compare/engine-v0.1.0...engine-v0.2.0) (2026-07-08)


### Features

* **config:** add review.shared_config operator overlay ([#2046](https://github.com/JSONbored/gittensory/issues/2046)) ([#3995](https://github.com/JSONbored/gittensory/issues/3995)) ([b13b478](https://github.com/JSONbored/gittensory/commit/b13b4783d13c596c67427bd3cde73add04fd0df4))
* **engine:** add bestMetadataOpportunity ([#3365](https://github.com/JSONbored/gittensory/issues/3365)) ([3fb2d1b](https://github.com/JSONbored/gittensory/commit/3fb2d1be6496b11d583a05f916a1f1a28ae01068))
* **engine:** add bestMetadataOpportunityAtOrAboveScore ([#3381](https://github.com/JSONbored/gittensory/issues/3381)) ([28fdc4a](https://github.com/JSONbored/gittensory/commit/28fdc4ab6087e606e9aec6b6de66ac471f589ef4))
* **engine:** add bestRankedOpportunity ([#3368](https://github.com/JSONbored/gittensory/issues/3368)) ([39e9377](https://github.com/JSONbored/gittensory/commit/39e93770cb4263eddeec5c79262ef2f4ffdb4d94))
* **engine:** add bestRankedOpportunityAtOrAboveScore ([#3377](https://github.com/JSONbored/gittensory/issues/3377)) ([079ee51](https://github.com/JSONbored/gittensory/commit/079ee519a36946223a58e7233d48785c3e1c5de5))
* **engine:** add countPlanSteps ([#3439](https://github.com/JSONbored/gittensory/issues/3439)) ([f6b9872](https://github.com/JSONbored/gittensory/commit/f6b987264f9d3b48a4cd3ab0b442a31b607a8fc7))
* **engine:** add countPlanStepsByStatus ([#3386](https://github.com/JSONbored/gittensory/issues/3386)) ([884ad5a](https://github.com/JSONbored/gittensory/commit/884ad5a08aaf7cd6fec3df9baf983dd18b080e54))
* **engine:** add ENGINE_VERSION semver pin ([#3475](https://github.com/JSONbored/gittensory/issues/3475)) ([5312a56](https://github.com/JSONbored/gittensory/commit/5312a56c863a878d2d0006502fd82d1b8cda3fee)), closes [#2284](https://github.com/JSONbored/gittensory/issues/2284)
* **engine:** add hasPlanCompletedSteps and document packages ([#3540](https://github.com/JSONbored/gittensory/issues/3540)) ([03f8926](https://github.com/JSONbored/gittensory/commit/03f892654cca7138a98fd18aae404631b27d3a93))
* **engine:** add hasPlanFailedSteps ([#3408](https://github.com/JSONbored/gittensory/issues/3408)) ([f7b53f3](https://github.com/JSONbored/gittensory/commit/f7b53f3e8ea8c389901d442cb1d8a8faf1702510))
* **engine:** add hasPlanPendingSteps ([#3413](https://github.com/JSONbored/gittensory/issues/3413)) ([f5a03bb](https://github.com/JSONbored/gittensory/commit/f5a03bbe65c5865e8871fd870dfa86a7438c3f03))
* **engine:** add hasPlanReadySteps plan DAG helper ([#3578](https://github.com/JSONbored/gittensory/issues/3578)) ([1badf91](https://github.com/JSONbored/gittensory/commit/1badf9121a58a35e70e7b708980bca85ce599402))
* **engine:** add hasPlanRunningSteps ([#3435](https://github.com/JSONbored/gittensory/issues/3435)) ([4af45df](https://github.com/JSONbored/gittensory/commit/4af45dff493f5e65d7adf90f669ebee1aeb20038))
* **engine:** add hasPlanSkippedSteps and document plan DAG helpers ([#3470](https://github.com/JSONbored/gittensory/issues/3470)) ([4fd8c9d](https://github.com/JSONbored/gittensory/commit/4fd8c9dfa3bea3eaf7f82cf6a850d72f7331f280)), closes [#2298](https://github.com/JSONbored/gittensory/issues/2298)
* **engine:** add isPlanBlocked plan DAG helper ([#3559](https://github.com/JSONbored/gittensory/issues/3559)) ([e4ec0ca](https://github.com/JSONbored/gittensory/commit/e4ec0ca6a0f5324855532e8ba890c9874df97279))
* **engine:** add isPlanEmpty ([#3447](https://github.com/JSONbored/gittensory/issues/3447)) ([f96e067](https://github.com/JSONbored/gittensory/commit/f96e067affee641dad394cb8afd566af54ad6072))
* **engine:** add isPlanFullyCompleted ([#3390](https://github.com/JSONbored/gittensory/issues/3390)) ([0507a11](https://github.com/JSONbored/gittensory/commit/0507a11cd8907f5fac1bce1aacc39dbd9028d958))
* **engine:** add isPlanProgressComplete plan DAG helper ([#3562](https://github.com/JSONbored/gittensory/issues/3562)) ([15ace01](https://github.com/JSONbored/gittensory/commit/15ace01c51f00ad4c01721820704c931a167d2e6))
* **engine:** add isPlanTerminated plan DAG helper ([#3587](https://github.com/JSONbored/gittensory/issues/3587)) ([8d6d08a](https://github.com/JSONbored/gittensory/commit/8d6d08a4eb57a4e1a5109695ad9f7678b3626ca2))
* **engine:** add resolvePlanOverallStatus plan DAG helper ([#3567](https://github.com/JSONbored/gittensory/issues/3567)) ([b719945](https://github.com/JSONbored/gittensory/commit/b719945cec2288df6ee4071aa2331c7db26cf0b1))
* **engine:** extract focus-manifest parse/compile core ([#2280](https://github.com/JSONbored/gittensory/issues/2280)) ([#3891](https://github.com/JSONbored/gittensory/issues/3891)) ([34d897e](https://github.com/JSONbored/gittensory/commit/34d897e72251fa90f6e75701ede9b5a7e27dbc2a))
* **miner-foundation:** extract duplicate-winner adjudication into gittensory-engine ([#2278](https://github.com/JSONbored/gittensory/issues/2278)) ([#3870](https://github.com/JSONbored/gittensory/issues/3870)) ([685e2c5](https://github.com/JSONbored/gittensory/commit/685e2c5ed8c9c6717eadacf58a7dcad88535a79b))
* **miner-foundation:** extract predicted-gate types into gittensory-engine ([#2276](https://github.com/JSONbored/gittensory/issues/2276)) ([#3873](https://github.com/JSONbored/gittensory/issues/3873)) ([daef526](https://github.com/JSONbored/gittensory/commit/daef526a24486bba7628a605c970d68973f5f482))
* **miner-foundation:** extract reward-risk scoring into gittensory-engine ([#2281](https://github.com/JSONbored/gittensory/issues/2281)) ([#3985](https://github.com/JSONbored/gittensory/issues/3985)) ([bf4e4fa](https://github.com/JSONbored/gittensory/commit/bf4e4fa146bc3365296093859c16b825bdc3fde9))
* **miner-foundation:** extract scoring preview/model into gittensory-engine ([#2282](https://github.com/JSONbored/gittensory/issues/2282)) ([#3849](https://github.com/JSONbored/gittensory/issues/3849)) ([48f0943](https://github.com/JSONbored/gittensory/commit/48f0943b2085d6d032d40d26bf6d15a85db3718a))
* **miner-foundation:** move buildPredictedGateVerdict into gittensory-engine ([#2283](https://github.com/JSONbored/gittensory/issues/2283)) ([#3882](https://github.com/JSONbored/gittensory/issues/3882)) ([a8a2287](https://github.com/JSONbored/gittensory/commit/a8a228785beb73e72b73b105695195cf910a97ca))
* **miner:** add structured finding-severity calibration signal ([#3375](https://github.com/JSONbored/gittensory/issues/3375)) ([c9b624b](https://github.com/JSONbored/gittensory/commit/c9b624b35448d368af84cdf92bd48e8274d04566))
* **miner:** add structured reviewer-consensus calibration signal ([#3406](https://github.com/JSONbored/gittensory/issues/3406)) ([89854d7](https://github.com/JSONbored/gittensory/commit/89854d71c8099d3ab5b9ead1a210a1937d40fcf7))
* **review:** add per-repo review.selftune force-off for the auto-tune cron ([#4118](https://github.com/JSONbored/gittensory/issues/4118)) ([02ea67d](https://github.com/JSONbored/gittensory/commit/02ea67d7baac46ab705c2e875e2b2fa55ec0705e))
* **review:** add REES complexity and Go/Python error-defect analyzers ([#4155](https://github.com/JSONbored/gittensory/issues/4155)) ([f5c5c52](https://github.com/JSONbored/gittensory/commit/f5c5c5237da04910688369dbf0cf2a1d9371593e))
* **review:** add review.visual.enabled config-as-code toggle ([#4093](https://github.com/JSONbored/gittensory/issues/4093)) ([92dfae1](https://github.com/JSONbored/gittensory/commit/92dfae1bdf18e4d5b38352a701f09dbadccd23fe))
* **review:** GitHub-Actions build-and-serve visual-capture fallback ([#4131](https://github.com/JSONbored/gittensory/issues/4131)) ([ec74858](https://github.com/JSONbored/gittensory/commit/ec7485892023a7de660c6bd98295d6c34d5a2c9f))
* **review:** let a bot-captured before/after satisfy the screenshot-table gate ([#4128](https://github.com/JSONbored/gittensory/issues/4128)) ([c2c6eb3](https://github.com/JSONbored/gittensory/commit/c2c6eb3a378b6d17d02e8b59518ef72649cdbbac))
* **review:** migrate grounding onto the per-repo feature-activation resolver ([#4117](https://github.com/JSONbored/gittensory/issues/4117)) ([3cfe2a9](https://github.com/JSONbored/gittensory/commit/3cfe2a93ef29d97d8cfc66ed16173351026e27f2))
* **review:** per-repo opt-in to let a confident AI-judgment blocker gate the merge ([#4171](https://github.com/JSONbored/gittensory/issues/4171)) ([4664ad2](https://github.com/JSONbored/gittensory/commit/4664ad25f4c729ded6a37c3d5d6d5a56857d73e7))
* **review:** wire linked-issue satisfaction into the deterministic gate ([#4069](https://github.com/JSONbored/gittensory/issues/4069)) ([3356fc6](https://github.com/JSONbored/gittensory/commit/3356fc60533c771df0363e766354bfbfbe1150c7))
* **selfhost:** support per-repo model overrides for ollama/openai/anthropic providers ([#3965](https://github.com/JSONbored/gittensory/issues/3965)) ([583e7b2](https://github.com/JSONbored/gittensory/commit/583e7b252349313815259738c2bafc4125937e50)), closes [#3902](https://github.com/JSONbored/gittensory/issues/3902)


### Fixes

* **engine:** fix stale test fixtures, wire the suite into test:ci ([#4150](https://github.com/JSONbored/gittensory/issues/4150)) ([5a4de69](https://github.com/JSONbored/gittensory/commit/5a4de69a67ae0d1704284d6237cd70d34ee2461a))
* **engine:** reject malformed replay calibration scores ([#3466](https://github.com/JSONbored/gittensory/issues/3466)) ([364024c](https://github.com/JSONbored/gittensory/commit/364024c82249a64da325dfe37a20dd72dd9a86a5))
* **engine:** validate metadata candidate paths ([#3950](https://github.com/JSONbored/gittensory/issues/3950)) ([8d507ae](https://github.com/JSONbored/gittensory/commit/8d507ae291dc87e2c3d6d23ad052caa7ecb74516))
* **miner:** sanitize reviewer consensus ingestion ([#3627](https://github.com/JSONbored/gittensory/issues/3627)) ([d415840](https://github.com/JSONbored/gittensory/commit/d41584097555aadd900be7558840ea803604d884))
* **miner:** sanitize severity calibration ingestion ([#3722](https://github.com/JSONbored/gittensory/issues/3722)) ([42aaf87](https://github.com/JSONbored/gittensory/commit/42aaf87233ae833f202eb295ec7d13d4b2454fbb))
* **review:** add localStorage theme-forcing fallback for visual capture ([#4109](https://github.com/JSONbored/gittensory/issues/4109)) ([#4127](https://github.com/JSONbored/gittensory/issues/4127)) ([1d2cb3f](https://github.com/JSONbored/gittensory/commit/1d2cb3ff32e5642b18b888a8070c59dfea6e67d9))
* **review:** let bug/feature labels propagate from maintainer-authored linked issues ([#3938](https://github.com/JSONbored/gittensory/issues/3938)) ([9707578](https://github.com/JSONbored/gittensory/commit/9707578496ad1ff123ffaf446b15b6d40472cf3c))
* **review:** persist merge train settings paths ([#4130](https://github.com/JSONbored/gittensory/issues/4130)) ([06689bc](https://github.com/JSONbored/gittensory/commit/06689bc1d54c167daac85791539265f9ab084733))
* **review:** preserve invariant guardrails ([#3943](https://github.com/JSONbored/gittensory/issues/3943)) ([95cc974](https://github.com/JSONbored/gittensory/commit/95cc974ead9f70379d76e69effda74ab0ec323ce))
* **review:** prevent backdated duplicate-winner claims ([#3956](https://github.com/JSONbored/gittensory/issues/3956)) ([ddd7e51](https://github.com/JSONbored/gittensory/commit/ddd7e51e99017ea984064bcf25af0033125f661a))
* **settings:** bound contributor open caps ([#3977](https://github.com/JSONbored/gittensory/issues/3977)) ([9195349](https://github.com/JSONbored/gittensory/commit/9195349654f73cc5c7450d2d1c510c761f1d52ef))

## Changelog

## engine-v0.1.0 - 2026-07-01

### Features
- Scaffold the shared deterministic engine package skeleton (#2275)
