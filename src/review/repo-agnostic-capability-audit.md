# Repo-agnostic capability audit — review / signals / rules stack

Audit of the review/merge-authority stack (`src/review/`, `src/signals/`, `src/rules/`) for hardcoded
or implicitly gittensory-specific assumptions that would need to become per-tenant configuration before
the review/merge authority model can be handed to an arbitrary rented repository. This is the checklist
deliverable for **#5744**; a follow-up implementation issue would turn each open item below into config,
gittensory's own values surviving only as the default. It mirrors the shape of the miner-side audit in
[`packages/gittensory-miner/docs/repo-agnostic-capability-audit.md`](../../packages/gittensory-miner/docs/repo-agnostic-capability-audit.md)
(the #4780 audit that #4784 resolved). Audit-and-document only — no code changes here.

## Summary

The review/signals/rules stack is **already largely repo-agnostic on its scoring and label surfaces**:
the type-label taxonomy is per-repo config with a gittensory default, label propagation is driven by a
configurable mapping (not hardcoded `gittensor:*` literals), and the rules layer delegates its gate
logic wholesale to `@loopover/engine`. The remaining assumptions fall into three buckets:

1. **GitHub as the only forge** — several review sub-systems (RAG index/grounding fetch, the visual-capture
   Actions fallback and preview-URL prober, and the PR/user link builders) hardcode `api.github.com`,
   GitHub's REST paths, the `x-github-api-version: 2022-11-28` header, and `github.com` web URLs. This is
   the single largest gap for a non-GitHub tenant, and it is spread across more modules than the miner side.
2. **Engine-delegated gittensory *defaults*** — the type-label taxonomy defaults to `gittensor:*` via the
   engine's `DEFAULT_TYPE_LABELS` when a tenant supplies neither a DB setting nor a focus-manifest override.
   It is fully overridable (`#label-modularity`), but the gittensory values are the out-of-the-box default.
3. **Branding / namespace constants** — check-run names ("LoopOver Context", "LoopOver Orb Review Agent"),
   the R2 object namespace (`loopover`), a fetch `User-Agent`, the parity shadow-writer name (`gittensory`),
   and the maintainer-recap actor (`gittensory`) are baked in. These are cosmetic per-tenant strings, not
   behavioural, so they are low priority — but they are still tenant-visible identity.

Everything else audited is already parameterized (see the "Already parameterized" section) and needs no
follow-up work.

## Findings by file / module

### `src/review/rag-index.ts` — repo-tree / file-contents fetch for the review RAG index

| Line | Assumption | Category | Should become |
| --- | --- | --- | --- |
| 97 | `"x-github-api-version": "2022-11-28"` | (2) forge protocol | Per-forge API version header (no override today). |
| 111 | `` `https://api.github.com/repos/${owner}/${name}/git/trees/${ref}?recursive=1` `` | (6) endpoint / (5) query construction | Per-forge base URL + repo-tree path template. |
| 113 | `application/vnd.github+json` accept header (`ghHeaders`) | (2) forge protocol | Per-forge request headers (a forge adapter). |
| 182 | `` `https://api.github.com/repos/${owner}/${name}/contents/${path...}` `` | (6) endpoint | Per-forge file-contents path template. |

### `src/review/grounding-wire.ts` — grounding file-contents fetch

| Line | Assumption | Category | Should become |
| --- | --- | --- | --- |
| 175 | `` `https://api.github.com/repos/${owner}/${name}/contents/${path...}` `` | (6) endpoint | Per-forge file-contents path template (duplicates `rag-index.ts:182`). |
| 191 | `"x-github-api-version": "2022-11-28"` | (2) forge protocol | Per-forge API version header. |

### `src/review/visual/actions-fallback.ts` — GitHub Actions visual-capture fallback

| Line | Assumption | Category | Should become |
| --- | --- | --- | --- |
| 41 | `const API_VERSION = "2022-11-28"` | (2) forge protocol | Per-forge API version. |
| 95, 377 | `` `https://api.github.com/repos/${repo.owner}/${repo.repo}` `` | (6) endpoint | Per-forge base URL + repo path. |
| 98, 360 | `accept: "application/vnd.github+json"` | (2) forge protocol | Per-forge headers. |
| 101, 362 | `x-github-api-version: API_VERSION` | (2) forge protocol | Per-forge headers. |
| 46 | `FALLBACK_WORKFLOW_NAME = "LoopOver Visual Capture Fallback"` | (7) branding | Per-tenant workflow name (cosmetic). |

Note: the visual-capture path is a whole GitHub-Actions-specific sub-system (dispatching a workflow and
polling run artifacts). Beyond the header/URL swaps above, its *mechanism* assumes GitHub Actions; a
non-GitHub tenant would need a forge-native equivalent, not just a base-URL change. Flag for scope review.

### `src/review/visual/preview-url.ts` — deployment-preview URL prober

| Line | Assumption | Category | Should become |
| --- | --- | --- | --- |
| 48 | `accept: "application/vnd.github+json"` | (2) forge protocol | Per-forge headers. |
| 50 | `x-github-api-version` (default `"2022-11-28"`) | (2) forge protocol | Already accepts `init.apiVersion`; the *default* is GitHub's. |
| 91, 176, 217, 249 | `` `https://api.github.com/repos/${repo.owner}/${repo.repo}` `` | (6) endpoint | Per-forge base URL + repo path (repeated four times). |

### `src/review/visual/capture.ts` — visual capture orchestration

| Line | Assumption | Category | Should become |
| --- | --- | --- | --- |
| 489 | `const apiVersion = "2022-11-28"` | (2) forge protocol | Per-forge API version. |
| 34 | `const NAMESPACE = "loopover"` (R2 object prefix) | (7) branding | Per-tenant storage namespace (cosmetic; see `shot.ts:446`). |

### `src/review/visual/shot.ts` — screenshot storage

| Line | Assumption | Category | Should become |
| --- | --- | --- | --- |
| 446 | `` `${opts.namespace ?? "loopover"}/shots/` `` | (7) branding | Per-tenant storage namespace default. Override exists (`opts.namespace`); default is `loopover`. |

### `src/review/alerts.ts` and `src/review/changed-files-diff-link.ts` — web link builders

| Location | Assumption | Category | Should become |
| --- | --- | --- | --- |
| `alerts.ts:154` | `` `https://github.com/${t.repo}/pull/${t.number}` `` (Discord embed PR link) | (6) endpoint | Per-forge web base URL for PR permalinks. |
| `changed-files-diff-link.ts:23` | `` `https://github.com/${repoFullName}/pull/${pullNumber}/files#diff-${anchor}` `` | (6) endpoint | Per-forge web diff-anchor URL scheme (the `#diff-` fragment is GitHub-specific). |

### `src/signals/engine.ts` — signals engine

| Line | Assumption | Category | Should become |
| --- | --- | --- | --- |
| 5297 | `` `https://github.com/${login}` `` (user-profile URL) | (6) endpoint | Per-forge user-profile web URL. |

Note: `engine.ts:1642`'s maintainer-lane check (`owner`/`org_member`/`collaborator`/`repo_maintainer`)
is a generic role vocabulary, not a gittensory assumption — no change needed.

### `src/signals/focus-manifest.ts` — effective-settings resolver (label taxonomy default)

| Line | Assumption | Category | Should become |
| --- | --- | --- | --- |
| 82, 550 | `DEFAULT_TYPE_LABELS` (`gittensor:bug`/`gittensor:feature`/`gittensor:priority`) is the fallback when neither a DB `typeLabels` value nor a focus-manifest override is present | (1) label names | **Already overridable** per repo via the focus manifest's sparse merge (`#label-modularity`); the gittensory taxonomy is only the default. A follow-up should confirm hosted tenants are given (or required to supply) their own taxonomy rather than silently inheriting `gittensor:*`. This is the same class of finding #4784 explicitly **deferred** to the review path — it lands here. |

### `src/signals/focus-manifest-loader.ts` — remote focus-manifest fetch

| Line | Assumption | Category | Should become |
| --- | --- | --- | --- |
| 86 | `"User-Agent": "loopover"` on the manifest fetch | (7) branding | Configurable UA string (cosmetic, low priority). |

### `src/review/maintainer-recap-wire.ts`, `parity-wire.ts`, `parity.ts`, `stats.ts` — actor / shadow-writer identity

| Location | Assumption | Category | Should become |
| --- | --- | --- | --- |
| `maintainer-recap-wire.ts:203` | `actor: "gittensory"` | (7) branding | Per-tenant actor identity string. |
| `parity.ts:254`, `stats.ts:112`, `parity-wire.ts:218` | shadow-writer default `"gittensory"` (parity self-join compares `reviewbot` vs `gittensory`) | (7) branding | Per-tenant shadow-writer name; the parity comparison is otherwise generic. |

### `src/review/check-names.ts` and `src/review/unified-comment*.ts` — check-run + comment branding

| Location | Assumption | Category | Should become |
| --- | --- | --- | --- |
| `check-names.ts:3-4` | `"LoopOver Context"` / `"LoopOver Orb Review Agent"` check-run names | (7) branding | Per-tenant check-run display names (behaviourally load-bearing as the check *identity*, so a rename needs a cutover like the LoopOver rebrand's own — see the retired pre-rebrand constants in the same file). |
| `unified-comment.ts:641,797`, `unified-comment-bridge.ts:270,339,839` | brand defaults `"LoopOver review"` / `"LoopOver"` / reviewer model `"LoopOver AI review"` | (7) branding | Per-tenant comment brand. Override already exists (`ctx.brand`); default is LoopOver. |

### `src/review/content-lane/content-repo-spec.ts` — content-registry lane host/allowlist

| Line | Assumption | Category | Should become |
| --- | --- | --- | --- |
| 89 | `domainOnlyExclusions` set (`github.com`, `npmjs.com`, `pypi.org`, `registry.npmjs.org`, ...) | (5) query construction | Registry-lane host allowlist. **Confirm scope:** this is the awesome-claude *content* registry lane, which may be legitimately gittensory-registry-specific rather than a per-rented-repo concern. Flag for the follow-up to decide whether the content lane is in Wave 5's reuse boundary at all. |
| 93-97 | Hardcoded multi-entry catalog URLs (`github.com/awslabs/mcp`, `microsoft/mcp`, `modelcontextprotocol/servers`, ...) | (5) query construction | Same scope question as above; these are content-registry curation constants, not review-authority config. |

## Already parameterized — no follow-up change needed

These were checked and are already tenant-agnostic / config-driven; call them out so the follow-up
implementation issue doesn't redo them:

- **`src/rules/` gate logic** — `predicted-gate.ts` re-exports the engine's `predicted-gate.js` wholesale,
  and `advisory.ts` contains only generic gate-decision logic (the `gittensory`/`loopover` mentions at
  `advisory.ts:563/895/911/945` are explanatory comments, not hardcoded identity). The rules layer is
  already repo-agnostic.
- **Label propagation** — `linked-issue-label-propagation.ts` / `-fetch.ts` drive their mappings from a
  configurable `linkedIssueLabelPropagation` setting (`DEFAULT_LINKED_ISSUE_LABEL_PROPAGATION` fallback);
  every `gittensor:priority`/`gittensor:bug` mention in those files is a **comment example**, not a
  hardcoded literal in the matching logic. No `gittensor:*` string is compared at runtime here.
- **Type-label *mechanism*** — the `focus-manifest.ts` sparse-merge (`{ ...dbSettings.typeLabels, ...override }`)
  already generalizes the taxonomy to an arbitrary per-repo key set; only the *default value* is gittensory
  (the finding above), not the mechanism.
- **Signals maintainer-lane / role model** — `signals/engine.ts:1642` uses a generic forge role vocabulary
  (`owner`/`org_member`/`collaborator`/`repo_maintainer`), not gittensory-specific roles.
- **`cutover-gate.ts` repo list** — the `"JSONbored/gittensory,..."` string at `cutover-gate.ts:8` is a
  comment example of the `owner/repo` env format; the actual list is env-supplied, not hardcoded.

## Prioritized checklist for the follow-up implementation issue

- [ ] **High — forge abstraction (read/API surfaces):** move the `api.github.com` base URL, the
  `2022-11-28` API version, the `application/vnd.github+json` accept header, and the repo-tree /
  file-contents path templates behind a per-tenant forge adapter (mirroring the miner side's
  `lib/forge-config.js` from #4784). Covers `rag-index.ts` (97/111/113/182), `grounding-wire.ts`
  (175/191), `visual/preview-url.ts` (48/50/91/176/217/249), and `visual/capture.ts:489`. Keep GitHub as
  the default.
- [ ] **High — forge web-URL builders:** route the `https://github.com/.../pull/...` PR permalink
  (`alerts.ts:154`), the `#diff-` diff-anchor URL (`changed-files-diff-link.ts:23`), and the user-profile
  URL (`signals/engine.ts:5297`) through a per-forge web-base-URL + URL-scheme helper (the `#diff-`
  fragment in particular is GitHub-specific).
- [ ] **High — visual-capture mechanism scope:** decide whether the GitHub-Actions-dispatch visual-capture
  fallback (`visual/actions-fallback.ts`) is in Wave 5's reuse boundary; if so it needs a forge-native
  capture path, not just header/URL swaps.
- [ ] **Medium — type-label taxonomy default (`focus-manifest.ts:550`, engine `DEFAULT_TYPE_LABELS`):**
  ensure hosted tenants supply (or are required to supply) their own taxonomy instead of silently
  inheriting `gittensor:*`. This is #4784's explicitly-deferred review-path item.
- [ ] **Low — branding / namespace constants:** make the R2 namespace (`visual/capture.ts:34`,
  `visual/shot.ts:446`), the fetch User-Agent (`focus-manifest-loader.ts:86`), the parity shadow-writer
  and maintainer-recap actor names (`parity.ts:254`, `stats.ts:112`, `maintainer-recap-wire.ts:203`), and
  the comment brand default (`unified-comment*.ts`) per-tenant. Note the check-run names
  (`check-names.ts:3-4`) are load-bearing identity — renaming them needs a cutover like the LoopOver
  rebrand's own hard cutover, not a silent default change.
- [ ] **Confirm scope — content-registry lane (`content-lane/content-repo-spec.ts`):** decide whether the
  awesome-claude content registry lane is a per-rented-repo concern at all before treating its host
  allowlist / catalog URLs as tenant config.
