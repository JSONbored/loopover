# Coverage-safe file moves for the engine-extraction milestone

Verification for **#4878**. Before the extraction phases (`content-lane`, `settings/`, `signals/`, …) move real
modules from `src/` into `packages/loopover-engine/src/`, we need a confirmed answer to one question:

> When a file is moved, does the coverage/diff tooling treat it as a **rename** (preserving its prior coverage
> history), or as a **delete-plus-add** — which would surface the whole file as newly-added lines and force it
> through the `patch` gate, tripping an otherwise-unchanged file?

This matters because the real merge gate is `patch` coverage: per `codecov.yml`, *"changed lines and branches in a
PR must be >=99% covered"* with `threshold: 0%` (no slack). A move that reads as delete-plus-add turns every line
of the moved file into a "changed line," so a single historically-uncovered line would fail the gate and the PR
would be auto-closed.

The answer below is **empirically verified against this repository**, not assumed.

## Finding 1 — git represents a pure move as a 100%-similarity rename

Moving a real content-lane file with a plain `git mv` and no content change, then inspecting the staged diff:

```
$ git mv src/review/content-lane/safe-url.ts packages/loopover-engine/src/content-lane-safe-url.ts

$ git diff --cached --stat -M
 .../safe-url.ts => packages/loopover-engine/src/content-lane-safe-url.ts | 0
 1 file changed, 0 insertions(+), 0 deletions(-)

$ git diff --cached --name-status -M100
 R100  src/review/content-lane/safe-url.ts  packages/loopover-engine/src/content-lane-safe-url.ts
```

With rename detection on, the move is an **`R100` rename: zero insertions, zero deletions.** There are no
"changed lines" for the `patch` gate to measure, so a pure move of an already-passing file cannot trip patch
coverage, and the file's coverage history carries forward under its new path.

## Finding 2 — the risk is real the moment rename detection does not apply

The *same* staged move, viewed with rename detection disabled (which is how the diff degrades if similarity drops
below git's rename threshold — the default is 50% — because the move commit *also* edits the file):

```
$ git diff --cached --numstat --no-renames
 117  0    packages/loopover-engine/src/content-lane-safe-url.ts
 0    117  src/review/content-lane/safe-url.ts
```

Now the new path is **117 added lines** and the old path is 117 deletions. Codecov computes `patch` from the PR
diff, so those 117 lines become newly-added code that must be ≥99% covered. If the moved module had any
uncovered line, the gate fails on a file whose behavior did not change at all. This is precisely the failure
mode #4878 was raised to prevent.

The trigger is content change *in the same commit as the move*: editing imports inside the moved file, inlining
an adapter, or reformatting all lower the similarity index below the rename threshold and collapse the clean
`R100` into a delete-plus-add.

## Finding 3 — the first merged extraction did not depend on rename detection at all

The already-merged extraction **#5762** ("extract the pull-request-target-key parser into loopover-engine") is a
useful control. Its file-level shape:

```
A  packages/loopover-engine/src/parse-pull-request-target-key.ts   (new file)
A  test/unit/parse-pull-request-target-key.test.ts                 (new test)
M  packages/loopover-engine/src/index.ts                           (barrel export)
M  src/db/repositories.ts                                          (old inline code removed)
```

It did **not** `git mv` anything. It re-created the extracted logic as a *new* file and shipped a *new* test that
fully covers it, so the added lines cleared patch-99% on their own merit. This is the second viable strategy, and
notably the safest merged path to date chose it over rename-dependence.

## Recommended protocol for subsequent extraction phases

Two strategies both work; pick per slice.

**Strategy A — pure rename (best for large leaf subtrees like `content-lane/*`, #4880).**
- Move files with a plain `git mv` and **no content edits to the moved files in that commit** — keep them
  byte-identical so the diff stays `R100`. Verify before pushing:
  `git diff --cached --name-status -M` must show `R100` (or `R0??` ≥ the rename threshold) for every moved file.
- Put the Worker adapter/shim and any import-path rewrites in **separate** files (e.g. the existing
  `*-wire.ts` adapter pattern), never by editing the moved file in the same commit.
- If import paths *inside* a moved file must change, do it as a **follow-up commit** after the rename is
  recorded, so the rename and the edit are distinct diffs.

**Strategy B — extract as new (best for small units pulled out of a larger file, as #5762 did).**
- Treat the extracted code as new, and ship a new test alongside it that brings the new file to ≥99% patch
  coverage. Independent of rename detection, so it is immune to the similarity-threshold trap.

**In both cases**
- Confirm the moved/added source is included by the coverage config (not caught by a `codecov.yml` `ignore`
  glob) so it is actually measured under its new path.
- A move mixed with content edits in one blob, without ≥99% coverage on the resulting added lines, is the one
  shape to avoid — it is the only way to fail the gate on unchanged behavior.

## Answer to #4878

A plain `git mv` **is** recognized as a rename (`R100`, zero changed lines) by git's diff, and Codecov's
diff-based `patch` gate has nothing to measure on such a move, so coverage history is preserved and the gate is
not tripped. The rename recognition holds **only while the moved file is byte-identical in that commit**; any
same-commit content change can collapse it to delete-plus-add and re-expose every line to patch-99%. The
established workaround for every subsequent phase is therefore: **move-only commits (Strategy A), or extract-as-new
with a covering test (Strategy B, per merged #5762)** — never a move blended with edits.
