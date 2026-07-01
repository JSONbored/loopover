# @jsonbored/gittensory-engine

Shared, deterministic engine logic for the Gittensory review stack and the `gittensory-miner`.

This package houses pure, side-effect-free logic (scoring preview/model, predicted-gate types, reward-risk,
slop signals, focus-manifest parse/compile core, duplicate-winner adjudication, and their engine-parity
fixtures) so the exact same code runs identically in the hosted review backend and in a local miner. It is
versioned independently of the app and published to npm as `@jsonbored/gittensory-engine`.

The logic is extracted from the app's `src/` in follow-up issues; this skeleton keeps the package buildable in
the meantime. The root `package.json` already globs `packages/*` in its `workspaces` field, so `npm ci`
discovers this package with no additional wiring.

## Build

```
npm run build --workspace @jsonbored/gittensory-engine
```

This runs `tsc -p tsconfig.json`, emitting `dist/` (the only published output alongside `CHANGELOG.md`).
