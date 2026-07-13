# Gittensory review config templates

Copy-paste templates for the per-repo review manifest. Every file in this directory uses the
**same schema** whether it lives in a public repo root or a self-host private mount
(`GITTENSORY_REPO_CONFIG_DIR`).

> **Filename note (#4773):** the canonical manifest filename is now **`.loopover.yml`** (LoopOver's
> new brand). The pre-rebrand name, **`.gittensory.yml`**, is still read everywhere `.loopover.yml`
> is — indefinitely, additively, with no expiry — so an existing self-hoster's committed
> `.gittensory.yml` keeps working with zero changes required. When both names are present at the
> same location, the new-brand `.loopover.yml` wins. New setups should name their own file
> `.loopover.yml`; the *template* filenames catalogued below (e.g. `gittensory.minimal.yml`) are a
> separate, unrelated naming concern and are left as-is — see the "Quick start" section for the
> destination filename you actually create.

## Template catalog

| File | Purpose |
|------|---------|
| [`gittensory.minimal.yml`](./gittensory.minimal.yml) | Smallest safe starter — gate off, observe-only autonomy, no accidental writes |
| [`gittensory.full.yml`](./gittensory.full.yml) | Exhaustive commented reference — every `gate:`, `settings:`, `review:`, and `features:` field |
| [`global.gittensory.yml`](./global.gittensory.yml) | **Private only** — illustrative fleet-wide default for a self-host mount |
| [`repo-override.gittensory.yml`](./repo-override.gittensory.yml) | **Private only** — per-repo overlay deep-merged over `global.gittensory.yml` |
| [`shared.gittensory.yml`](./shared.gittensory.yml) | **Private only** — lowest-priority cross-repo house policy for multi-repo operators (#1959) |

Canonical copies of the minimal and full templates also live at the repo root as
[`.gittensory.minimal.yml`](../../.gittensory.minimal.yml) and
[`.gittensory.yml.example`](../../.gittensory.yml.example). CI keeps the `config/examples/` copies
in sync with those files.

## Public repo root vs private self-host mount

Paths below show the new-brand `.loopover.yml` name; `.gittensory.yml` (and `.github/gittensory.yml`
for the public row) still works everywhere, indefinitely (#4773) — see the filename note above.

| Layer | Path | Who can read it | Typical contents |
|-------|------|-----------------|------------------|
| **Public** | `.loopover.yml` or `.github/loopover.yml` in git | Contributors | `wantedPaths`, test expectations, public review presentation |
| **Private global** | `${GITTENSORY_REPO_CONFIG_DIR}/.loopover.yml` | Operator only | Shared autonomy baseline, contributor caps, maintainer allowlists |
| **Private per-repo** | `${GITTENSORY_REPO_CONFIG_DIR}/owner__repo/.loopover.yml` | Operator only | Repo-specific CI context names, AI mode, overrides |
| **Private shared base** | `${GITTENSORY_REPO_CONFIG_DIR}/_shared/.loopover.yml` | Operator only | Lowest-priority cross-repo house policy for an operator running many repos (#1959) — see [README's "Shared base layer" section](./README.md#shared-base-layer-multi-repo-operators-1959) |

When **either** a private global or private per-repo file exists, the loader **never fetches** the
public repo file for that review — mount private policy deliberately. See [README.md](./README.md)
for precedence and deep-merge rules.

**Never commit real private policy** (maintainer logins, thresholds, autonomy dials you do not want
contributors to read) into a public repository. Copy `global.gittensory.yml` into your gitignored
`gittensory-config/` mount and edit there.

## Quick start

### Public repo (contributor-visible config)

```bash
cp config/examples/gittensory.minimal.yml .loopover.yml
# edit wantedPaths / gate when ready
# (an existing .gittensory.yml at repo root also still works -- #4773 -- no need to rename it)
```

### Self-host private mount (operator-only policy)

```bash
mkdir -p gittensory-config
cp config/examples/global.gittensory.yml gittensory-config/.loopover.yml
# edit your-admin-login placeholders before going live
# optional per-repo overlay:
mkdir -p gittensory-config/myorg__myrepo
cp config/examples/repo-override.gittensory.yml gittensory-config/myorg__myrepo/.loopover.yml
```

Point `GITTENSORY_REPO_CONFIG_DIR` at that directory (default `/config` in `docker-compose.yml` maps
`./gittensory-config`).

## Fleet examples (without committing private policy)

These patterns apply to common JSONbored repos. **Do not copy real maintainer logins or thresholds
into public git** — use the private mount for anything marked *private* below.

### `JSONbored/gittensory` (dogfooding)

- **Public** `.gittensory.yml` in the repo (the legacy name this repo's own committed config still
  uses, per #4773's dual-read — a new repo would name this `.loopover.yml` instead): work-area
  guardrails, test expectations, gate dimensions contributors should understand.
- **Private** `gittensory-config/` (gitignored locally, operator mount in production): fleet
  autonomy, anti-abuse caps, maintainer exemption lists — the same split described in
  [`global.gittensory.yml`](./global.gittensory.yml).
- Start from `gittensory.minimal.yml` in the public repo until gate semantics are tuned, then promote
  fields into the private global default as you enable autonomous review.

### `JSONbored/awesome-claude` (public template repo)

- Prefer **`gittensory.minimal.yml`** or a trimmed public manifest: `wantedPaths`, linked-issue
  policy, and advisory gate modes only.
- Keep contributor caps, `autoCloseExemptLogins`, and `autonomy.close: auto` in **private config
  only** — this repo is meant to be copied; do not bake operator-specific enforcement into its
  public history.

### `JSONbored/metagraphed` (sibling product repo)

- Same split as `gittensory`: public manifest for transparent contributor guidance; private mount
  for thresholds and maintainer-only rules.
- Use `repo-override.gittensory.yml` when one repo needs different `expectedCiContexts` or
  `gate.checkMode: disabled` while sharing a fleet-wide `global.gittensory.yml` baseline.

## Validation

Every template in this directory is parsed in CI (`test/unit/config-templates.test.ts` and
`test/unit/selfhost-config-examples.test.ts`). The exhaustive template body is kept identical to
`.gittensory.yml.example` from `# WHERE IT LIVES` onward. Lint a local file before deploy:

```bash
npx tsx scripts/gittensory-config-lint.ts path/to/.loopover.yml   # or path/to/.gittensory.yml (legacy, #4773)
```
