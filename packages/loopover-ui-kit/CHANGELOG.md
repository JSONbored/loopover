# Changelog

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
