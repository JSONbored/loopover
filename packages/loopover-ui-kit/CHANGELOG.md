# Changelog

## [1.5.1](https://github.com/JSONbored/loopover/compare/ui-kit-v1.5.0...ui-kit-v1.5.1) (2026-07-31)


### Fixes

* **observability:** group AI generations by their real trace, and attribute spend per repo ([#10187](https://github.com/JSONbored/loopover/issues/10187)) ([693aed8](https://github.com/JSONbored/loopover/commit/693aed823b9fb51518ce6649cc610a17ded86e9c)), closes [#10185](https://github.com/JSONbored/loopover/issues/10185)

## [1.5.0](https://github.com/JSONbored/loopover/compare/ui-kit-v1.4.0...ui-kit-v1.5.0) (2026-07-31)


### Features

* **analytics:** complete the PostHog migration — retire Umami, fix the MCP event contract ([#10177](https://github.com/JSONbored/loopover/issues/10177)) ([2cafde3](https://github.com/JSONbored/loopover/commit/2cafde31b127d6a4b5d1083d72e5b1184ed78f7d)), closes [#8293](https://github.com/JSONbored/loopover/issues/8293) [#8299](https://github.com/JSONbored/loopover/issues/8299) [#10175](https://github.com/JSONbored/loopover/issues/10175) [#10176](https://github.com/JSONbored/loopover/issues/10176)


### Fixes

* **ui-kit:** expose PaginationEllipsis More pages outside aria-hidden ([#10136](https://github.com/JSONbored/loopover/issues/10136)) ([291fcd9](https://github.com/JSONbored/loopover/commit/291fcd9b2b7a9107825ff836aca5ad39268eb102)), closes [#10052](https://github.com/JSONbored/loopover/issues/10052)
* **ui-kit:** render chart tooltip zero inside tabular-nums span ([#10114](https://github.com/JSONbored/loopover/issues/10114)) ([21855f2](https://github.com/JSONbored/loopover/commit/21855f2dd6faa493de33b89d379cff7ec5ae807c)), closes [#10051](https://github.com/JSONbored/loopover/issues/10051)
* **ui-kit:** stop useStreamingText cancel() from overwriting a settled status ([#10121](https://github.com/JSONbored/loopover/issues/10121)) ([3d7fdbf](https://github.com/JSONbored/loopover/commit/3d7fdbf4eefb2d5a626b4174ef1bc45e6c0209f1))

## [1.4.0](https://github.com/JSONbored/loopover/compare/ui-kit-v1.3.1...ui-kit-v1.4.0) (2026-07-31)


### Features

* **ui-kit:** relocate streaming-text, use-streaming-text, typing-indicator from miner-ui ([#9239](https://github.com/JSONbored/loopover/issues/9239)) ([f4a0ee0](https://github.com/JSONbored/loopover/commit/f4a0ee0c23b2ec11797d07a0edf825deb53e0e75))


### Dependencies

* **ui-kit:** publish the stranded recharts v3 migration, and guard the class ([#9977](https://github.com/JSONbored/loopover/issues/9977)) ([c6fcee9](https://github.com/JSONbored/loopover/commit/c6fcee9908b9e354cafbf1a188ba3cb889c0dd44))

## [1.3.1](https://github.com/JSONbored/loopover/compare/ui-kit-v1.3.0...ui-kit-v1.3.1) (2026-07-31)


### Dependencies

* **ui-kit:** publish the stranded recharts v3 migration, and guard the class ([#9977](https://github.com/JSONbored/loopover/issues/9977)) ([c6fcee9](https://github.com/JSONbored/loopover/commit/c6fcee9908b9e354cafbf1a188ba3cb889c0dd44))

## [1.3.0](https://github.com/JSONbored/loopover/compare/ui-kit-v1.2.0...ui-kit-v1.3.0) (2026-07-29)


### Features

* **ui-kit:** relocate streaming-text, use-streaming-text, typing-indicator from miner-ui ([#9239](https://github.com/JSONbored/loopover/issues/9239)) ([f4a0ee0](https://github.com/JSONbored/loopover/commit/f4a0ee0c23b2ec11797d07a0edf825deb53e0e75))

## [1.2.0](https://github.com/JSONbored/loopover/compare/ui-kit-v1.1.2...ui-kit-v1.2.0) (2026-07-25)


### Features

* **release:** extend the release-due watcher + tarball pack-check to engine/miner/ui-kit ([#8592](https://github.com/JSONbored/loopover/issues/8592)) ([25e99c2](https://github.com/JSONbored/loopover/commit/25e99c23c591a8fe1583951cf1f9666173d2a61d))

## [1.1.2](https://github.com/JSONbored/loopover/compare/ui-kit-v1.1.1...ui-kit-v1.1.2) (2026-07-24)


### Fixes

* **ui-kit:** don't hijack Cmd/Ctrl+B Bold in text fields (SidebarProvider) ([#8305](https://github.com/JSONbored/loopover/issues/8305)) ([#8341](https://github.com/JSONbored/loopover/issues/8341)) ([2ae66d6](https://github.com/JSONbored/loopover/commit/2ae66d69602f0812a971c0e95ed57cb897f465ba))
* **ui-kit:** give PaginationLink's aria-disabled a real visual/interaction effect ([#8359](https://github.com/JSONbored/loopover/issues/8359)) ([ee7eed6](https://github.com/JSONbored/loopover/commit/ee7eed649ce970a5545e9b68bca90f7a3446eb1b)), closes [#8307](https://github.com/JSONbored/loopover/issues/8307)
* **ui-kit:** move focus ring to focus-visible on Select/Dialog/Sheet/NavigationMenu ([#8335](https://github.com/JSONbored/loopover/issues/8335)) ([3f081c4](https://github.com/JSONbored/loopover/commit/3f081c49abfece478fe937e714d508a8f2be8d51)), closes [#8304](https://github.com/JSONbored/loopover/issues/8304)
* **ui-kit:** respect prefers-reduced-motion across animated ui-kit and miner-ui components ([#8360](https://github.com/JSONbored/loopover/issues/8360)) ([5558575](https://github.com/JSONbored/loopover/commit/55585750e085288a960a0830d0692e30baf8bd31)), closes [#8303](https://github.com/JSONbored/loopover/issues/8303)

## [1.1.1](https://github.com/JSONbored/loopover/compare/ui-kit-v1.1.0...ui-kit-v1.1.1) (2026-07-23)


### Fixes

* **miner-ui:** keep mobile chat sheet mounted so conversation state survives ([#7792](https://github.com/JSONbored/loopover/issues/7792)) ([#7885](https://github.com/JSONbored/loopover/issues/7885)) ([e7e10e7](https://github.com/JSONbored/loopover/commit/e7e10e7f79f094e988034c9fa3e82e0ebab0203b))
* **miner-ui:** stick-to-bottom auto-scroll for chat rail ([#7229](https://github.com/JSONbored/loopover/issues/7229)) ([#7298](https://github.com/JSONbored/loopover/issues/7298)) ([8cbcb53](https://github.com/JSONbored/loopover/commit/8cbcb53799b7a943a9ce2a668263c5c427c530e6))
* **test:** close the Node-version guard's remaining coverage gap ([#7627](https://github.com/JSONbored/loopover/issues/7627)) ([#7629](https://github.com/JSONbored/loopover/issues/7629)) ([9f356fe](https://github.com/JSONbored/loopover/commit/9f356fea0cb0cd499f9339d09cca0c044ce292c1))
* **test:** pin loopover-ui + ui-kit jsdom localStorage over Node 26's broken global ([#7616](https://github.com/JSONbored/loopover/issues/7616)) ([d6477bf](https://github.com/JSONbored/loopover/commit/d6477bfa91ca51f130c7ebae7aa5da8ae6310d72))
* **ui-kit:** edge-trigger StateBoundary failure notifications ([#7505](https://github.com/JSONbored/loopover/issues/7505)) ([fa67da4](https://github.com/JSONbored/loopover/commit/fa67da462511e298c06323a2842869f1a5ddd2d9))

## [1.1.0](https://github.com/JSONbored/loopover/compare/ui-kit-v1.0.0...ui-kit-v1.1.0) (2026-07-17)


### Features

* **ui-kit:** port state-views.tsx primitives into @loopover/ui-kit ([#6539](https://github.com/JSONbored/loopover/issues/6539)) ([8eb1933](https://github.com/JSONbored/loopover/commit/8eb193339db46199b2cfcc5894bd37d056bf0908)), closes [#6506](https://github.com/JSONbored/loopover/issues/6506)


### Fixes

* **config:** scrub remaining pre-rename gittensory references ([23152da](https://github.com/JSONbored/loopover/commit/23152dafcc1bbb329bdc63606dee311cdb4267cf))
* **config:** scrub remaining pre-rename gittensory references ([e4b0f8c](https://github.com/JSONbored/loopover/commit/e4b0f8cd4e24cbc7c14b157e7d660f73adca2115))
* **ui:** add a shared bg-surface-code token for the always-dark code surface ([#6957](https://github.com/JSONbored/loopover/issues/6957)) ([334ee58](https://github.com/JSONbored/loopover/commit/334ee5855fd308807596826ead74b1329b385f01))

## [1.0.0](https://github.com/JSONbored/loopover/compare/ui-kit-v0.2.0...ui-kit-v1.0.0) (2026-07-14)


### ⚠ BREAKING CHANGES

* **build:** every gittensory-prefixed directory under apps/ and packages/ is now loopover-prefixed, and the two extension packages' npm names changed from @jsonbored/gittensory-* to @loopover/*. No dual-path/alias, per the epic's full-cutover mandate.

### Features

* **build:** Phase 5 - full-cutover rename all gittensory-* directories to loopover-* ([#5743](https://github.com/JSONbored/loopover/issues/5743)) ([81e4ac3](https://github.com/JSONbored/loopover/commit/81e4ac34dfb4dee9c3cadefcc27a515617462da9))

## [0.2.0](https://github.com/JSONbored/gittensory/compare/ui-kit-v0.1.0...ui-kit-v0.2.0) (2026-07-14)


### Features

* **ui:** unify gittensory-ui and gittensory-miner-ui on one design system ([#4973](https://github.com/JSONbored/gittensory/issues/4973)) ([8dcbe5b](https://github.com/JSONbored/gittensory/commit/8dcbe5b9c1d479b6921729779f67d89405d0f6e7))
