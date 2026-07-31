# Changelog

## [3.20.0](https://github.com/JSONbored/loopover/compare/contract-v3.19.0...contract-v3.20.0) (2026-07-31)


### Features

* **analytics:** complete the PostHog migration — retire Umami, fix the MCP event contract ([#10177](https://github.com/JSONbored/loopover/issues/10177)) ([2cafde3](https://github.com/JSONbored/loopover/commit/2cafde31b127d6a4b5d1083d72e5b1184ed78f7d)), closes [#8293](https://github.com/JSONbored/loopover/issues/8293) [#8299](https://github.com/JSONbored/loopover/issues/8299) [#10175](https://github.com/JSONbored/loopover/issues/10175) [#10176](https://github.com/JSONbored/loopover/issues/10176)


### Fixes

* **observability:** group AI generations by their real trace, and attribute spend per repo ([#10187](https://github.com/JSONbored/loopover/issues/10187)) ([693aed8](https://github.com/JSONbored/loopover/commit/693aed823b9fb51518ce6649cc610a17ded86e9c)), closes [#10185](https://github.com/JSONbored/loopover/issues/10185)

## [3.19.0](https://github.com/JSONbored/loopover/compare/contract-v3.18.4...contract-v3.19.0) (2026-07-31)


### Chores

* **contract:** Synchronize engine-and-dependents versions

## [3.18.4](https://github.com/JSONbored/loopover/compare/contract-v3.18.3...contract-v3.18.4) (2026-07-31)


### Fixes

* **mcp:** compare property schemas in checkInputNarrowing ([#10124](https://github.com/JSONbored/loopover/issues/10124)) ([f8fe08d](https://github.com/JSONbored/loopover/commit/f8fe08daea112e499cdcf521202089fb65c5c60c))

## [3.18.3](https://github.com/JSONbored/loopover/compare/contract-v3.18.2...contract-v3.18.3) (2026-07-31)


### Chores

* **contract:** Synchronize engine-and-dependents versions

## [3.18.2](https://github.com/JSONbored/loopover/compare/contract-v3.18.1...contract-v3.18.2) (2026-07-31)


### Chores

* **contract:** Synchronize engine-and-dependents versions

## [3.18.1](https://github.com/JSONbored/loopover/compare/contract-v3.18.0...contract-v3.18.1) (2026-07-31)


### Chores

* **contract:** Synchronize engine-and-dependents versions

## [3.18.0](https://github.com/JSONbored/loopover/compare/contract-v3.17.0...contract-v3.18.0) (2026-07-30)


### Features

* **fairness:** one-command public verifier + published methodology page ([#9941](https://github.com/JSONbored/loopover/issues/9941)) ([bae7b2f](https://github.com/JSONbored/loopover/commit/bae7b2ffa79102fe1f8ecbd2030c1edc0c3d31d7))
* **gate:** add the block tier, so an enforcing screenshot gate holds a PR instead of destroying it ([#9964](https://github.com/JSONbored/loopover/issues/9964)) ([3ed97dc](https://github.com/JSONbored/loopover/commit/3ed97dc707d551cb20f2a042e58ab344865f7c6e)), closes [#9881](https://github.com/JSONbored/loopover/issues/9881)


### Fixes

* **contract:** restate MAX_PRIORITY_ELIGIBILITY_WINDOW_MINUTES so the generated schemas compile ([#9936](https://github.com/JSONbored/loopover/issues/9936)) ([edf7b37](https://github.com/JSONbored/loopover/commit/edf7b37762e7d9232e8a93e17c271f6074e73067))

## [3.17.0](https://github.com/JSONbored/loopover/compare/contract-v0.1.0...contract-v3.17.0) (2026-07-30)


### Features

* **ams:** migrate the AMS miner MCP server to @loopover/contract ([#9542](https://github.com/JSONbored/loopover/issues/9542)) ([9713f26](https://github.com/JSONbored/loopover/commit/9713f261c38b382b1d79039ae2b745a38565e40f)), closes [#9536](https://github.com/JSONbored/loopover/issues/9536)
* **contract:** add @loopover/contract, the single zod source for tool and API schemas ([#9530](https://github.com/JSONbored/loopover/issues/9530)) ([95f1524](https://github.com/JSONbored/loopover/commit/95f1524035a6785834fd2236ee676a1626ba8854))
* **contract:** give the request schemas, the control plane, and the self-host endpoints one contract ([#9750](https://github.com/JSONbored/loopover/issues/9750)) ([#9757](https://github.com/JSONbored/loopover/issues/9757)) ([5220a35](https://github.com/JSONbored/loopover/commit/5220a359f7cfa82421267212581f161d0085d2cb))
* **contract:** migrate every remote MCP tool contract to @loopover/contract ([#9518](https://github.com/JSONbored/loopover/issues/9518)) ([#9559](https://github.com/JSONbored/loopover/issues/9559)) ([968c731](https://github.com/JSONbored/loopover/commit/968c73171baca6128845e358d9e15a10144791a5))
* **gate:** choose provider, model, effort and self-consistency runs — per repo, and escalated on guarded paths ([#9821](https://github.com/JSONbored/loopover/issues/9821)) ([a65655c](https://github.com/JSONbored/loopover/commit/a65655c9e289175dadab0112b8ffa2d821963a3d))
* **mcp:** discovery surfaces, registry publish, and the stdio gateway ([#9526](https://github.com/JSONbored/loopover/issues/9526)) ([#9735](https://github.com/JSONbored/loopover/issues/9735)) ([983ea31](https://github.com/JSONbored/loopover/commit/983ea31fee115e2f63e5bfbf23c858d50c539012))
* **mcp:** generate every tool, CLI, client, and docs surface from the contract ([#9521](https://github.com/JSONbored/loopover/issues/9521)) ([#9590](https://github.com/JSONbored/loopover/issues/9590)) ([bd139a5](https://github.com/JSONbored/loopover/commit/bd139a5d5d6a95bfd4c38b46ab29ec73b43af8e3))
* **mcp:** migrate the stdio MCP server's 102 tools to @loopover/contract ([#9537](https://github.com/JSONbored/loopover/issues/9537)) ([#9565](https://github.com/JSONbored/loopover/issues/9565)) ([d5a5a8f](https://github.com/JSONbored/loopover/commit/d5a5a8fe5c6cb3b2541689d85baf1c3d0a45c422))
* **mcp:** one registry-driven telemetry contract at all three dispatch chokepoints ([#9525](https://github.com/JSONbored/loopover/issues/9525)) ([#9579](https://github.com/JSONbored/loopover/issues/9579)) ([06a090f](https://github.com/JSONbored/loopover/commit/06a090f9a6ab786165ab76fc741e2697c0ff1ae1))
* **stats:** publish a fleet accuracy trend, so the weekly table means something again ([#9775](https://github.com/JSONbored/loopover/issues/9775)) ([47842ec](https://github.com/JSONbored/loopover/commit/47842ec7bf0a5c0f8c1752d618f6ff963e378572)), closes [#9676](https://github.com/JSONbored/loopover/issues/9676)


### Fixes

* **contract:** close the last duplications and make the .shape trap impossible ([#9762](https://github.com/JSONbored/loopover/issues/9762)) ([#9765](https://github.com/JSONbored/loopover/issues/9765)) ([edbdb58](https://github.com/JSONbored/loopover/commit/edbdb584c7ebcab3f85f11018b7cab25ad056486))
* **contract:** regenerate api-schemas for [#9813](https://github.com/JSONbored/loopover/issues/9813)'s ignoredCheckRuns ([#9837](https://github.com/JSONbored/loopover/issues/9837)) ([8659503](https://github.com/JSONbored/loopover/commit/86595038c3fb690bb5ae75ea4cc4a21f5977f2a3)), closes [#9836](https://github.com/JSONbored/loopover/issues/9836)
* **release:** publish @loopover/contract, and catch this class of break before it ships ([#9749](https://github.com/JSONbored/loopover/issues/9749)) ([#9763](https://github.com/JSONbored/loopover/issues/9763)) ([6dd5791](https://github.com/JSONbored/loopover/commit/6dd5791b4d7c116ae4f272e130ab7e9ece6716e6))
* **review:** split unrecognized human-override verdicts out of confirmed ([#9916](https://github.com/JSONbored/loopover/issues/9916)) ([cd491d2](https://github.com/JSONbored/loopover/commit/cd491d217188c0b17c96e24d63d820740b8b33cc))

## 0.1.0

Initial release. `@loopover/contract` is the single zod source of truth for LoopOver's MCP tool and API
contracts — the schemas, tool metadata, and derived projections every server and client reads.

It is published because it is a **runtime** dependency of `@loopover/mcp` and `@loopover/miner`, which
import it from code that ships (#9749). It must be published *before* any release of those packages that
depends on a new version of it.
