# Replay-runner image

The reproducible container image for `attested-backtest-run.ts` (#9214, epic #8534): replay a rule's
backtest corpus, collect attestation evidence binding which evaluation ran, and print the outcome as JSON.
Attestation over an unpinned, irreproducible workload is theater — this doc is how a third party checks that
this image is, in fact, pinned and reproducible, and exactly what that claim does and doesn't cover.

## Build and run

```sh
# from the repo root
docker build -f scripts/replay-runner/Dockerfile -t loopover-replay-runner:latest .

docker run --rm --network none \
  -v /path/to/corpus.json:/data/corpus.json:ro \
  loopover-replay-runner:latest \
  --rule-id linked_issue_scope_mismatch --corpus /data/corpus.json \
  --head-sha <40 hex> --base-sha <40 hex> --repo owner/repo --pr 42
```

`--network none` is not just an example flag — the image's default (sample-attester) path genuinely never
touches the network, which you can confirm yourself with the command above. See
`scripts/attested-backtest-run.ts`'s own header comment for the full flag reference (`--attester snp`,
`--runtime-claim tee`, etc.).

No secrets are ever baked into the image: it never holds a GitHub token, a D1/Postgres credential, or an
enrollment secret. The CLI's own `--persist` flag (which shells out to `wrangler d1 execute --remote`) is
deliberately unreachable from this image's default invocation — persistence is a separate, operator-invoked
step outside what this measured image runs.

## Reproduce the digest yourself

`scripts/replay-runner-image-manifest.json` is the committed, checksummed record of exactly what this image
is built from. Recompute it and compare:

```sh
npm ci --ignore-scripts
npm run replay-runner-manifest        # prints a freshly computed manifest to stdout
npm run replay-runner-manifest:check  # exits 0 iff it matches the committed file, else prints every diff
```

`replay-runner-manifest:check` runs on every push to `main` that touches this image (`.github/workflows/replay-runner-image.yml`), alongside an actual `docker build` of the pinned Dockerfile and a real attested run of the built image — so "the manifest matches" and "the image still builds and runs" are both continuously verified, not just asserted here.

## What is and isn't reproducible

The manifest's `digest` field is a **declared-inputs digest**, not a digest of the built Docker image
itself. Concretely, it's a SHA-256 over:

- the pinned base image reference (`baseImageRef`, e.g. `node:22-slim@sha256:...`) — copied verbatim from
  the Dockerfile's `FROM` line, so a base-image bump is a visible manifest diff, never a silent drift;
- the Dockerfile's own text (`dockerfileSha256`);
- the root `package-lock.json`'s text (`packageLockSha256`);
- every source file the image's runtime stage copies in, individually hashed (`sourceFiles`) — currently
  `scripts/attested-backtest-run.ts`, `scripts/attested-backtest-run-core.ts`,
  `scripts/backtest-corpus-export-core.ts`, and `scripts/snp-attester.ts` (see the Dockerfile's own comment
  for why this is an explicit, individually-maintained list rather than a directory glob).

**This is a sound proxy for "rebuilding reproduces the same image"** because both of the operations that
turn these inputs into a running container are themselves deterministic given identical inputs:
`npm ci` resolves dependencies from a lockfile (no version-range re-resolution), and `tsc`'s compilation of
`@loopover/engine` is a pure function of its source tree. If none of the five inputs above have changed, the
build process that consumes them hasn't changed either.

**What this manifest does NOT claim**: that the *built Docker image's own ID*
(`docker inspect --format '{{.Id}}'`) is bit-for-bit reproducible across machines or BuildKit versions. Layer
metadata — file modification times, ownership bits, and BuildKit's own internal caching behavior — is a
known source of non-determinism in container builds generally, and this repo has not attempted to solve it
(no `SOURCE_DATE_EPOCH` normalization, no `--provenance=false` reproducibility tooling). A skeptic who
rebuilds this image on a different machine may get a different `docker inspect` ID even when every declared
input above matches exactly. That is a real, narrower gap than "the image is reproducible" — this manifest
proves the *inputs* never drifted; it does not prove the *build byte stream* is identical everywhere.

If a future need justifies closing that narrower gap (e.g. binding a real TEE launch measurement to something
tighter than "these inputs, believed rebuilt correctly"), that is separate, harder work than this manifest —
raise it against epic #8534 rather than assuming this file already covers it.

## Why a subpath import, not the `@loopover/engine` barrel

`attested-backtest-run.ts` imports from `@loopover/engine/calibration/attester` and
`@loopover/engine/calibration/backtest-corpus`, not the package's default export. The barrel
(`@loopover/engine`'s `dist/index.js`) re-exports `miner/repo-map.ts`, which has a top-level
`import Parser from "web-tree-sitter"` — loading the barrel would pull `web-tree-sitter` (and, via its own
on-disk resolution, `tree-sitter-wasms`) into this image even though nothing here ever calls into
`repo-map.ts`. For an image meant to eventually run measured inside a TEE, keeping its dependency footprint to
exactly what replay needs is a real security property (a smaller trusted computing base), not a size
optimization for its own sake — see `scripts/attested-backtest-run.ts`'s own import comment for the same
rationale in more detail, and `src/db/repositories.ts`'s `@loopover/engine/parse-pull-request-target-key`
import for the established precedent this follows.
