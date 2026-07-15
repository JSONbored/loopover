# LoopOver review config templates

Copy-paste templates for the per-repo review manifest. Every file in this directory uses the
**same schema** whether it lives in a public repo root or a self-host private mount
(`LOOPOVER_REPO_CONFIG_DIR`).

> **Filename note:** the canonical manifest filename is **`.loopover.yml`**. The *template*
> filenames catalogued below (e.g. `loopover.minimal.yml`) are a separate, unrelated naming
> concern and are left as-is — see the "Quick start" section for the destination filename you
> actually create.

## Template catalog

| File | Purpose |
|------|---------|
| [`loopover.minimal.yml`](./loopover.minimal.yml) | Smallest safe starter — gate off, observe-only autonomy, no accidental writes |
| [`loopover.full.yml`](./loopover.full.yml) | Exhaustive commented reference — every `gate:`, `settings:`, `review:`, and `features:` field |
| [`global.loopover.yml`](./global.loopover.yml) | **Private only** — illustrative fleet-wide default for a self-host mount |
| [`repo-override.loopover.yml`](./repo-override.loopover.yml) | **Private only** — per-repo overlay deep-merged over `global.loopover.yml` |
| [`shared.loopover.yml`](./shared.loopover.yml) | **Private only** — lowest-priority cross-repo house policy for multi-repo operators (#1959) |

Canonical copies of the minimal and full templates also live at the repo root as
[`.loopover.minimal.yml`](../../.loopover.minimal.yml) and
[`.loopover.yml.example`](../../.loopover.yml.example). CI keeps the `config/examples/` copies
in sync with those files.

## Public repo root vs private self-host mount

| Layer | Path | Who can read it | Typical contents |
|-------|------|-----------------|------------------|
| **Public** | `.loopover.yml` or `.github/loopover.yml` in git | Contributors | `wantedPaths`, test expectations, public review presentation |
| **Private global** | `${LOOPOVER_REPO_CONFIG_DIR}/.loopover.yml` | Operator only | Shared autonomy baseline, contributor caps, maintainer allowlists |
| **Private per-repo** | `${LOOPOVER_REPO_CONFIG_DIR}/owner__repo/.loopover.yml` | Operator only | Repo-specific CI context names, AI mode, overrides |
| **Private shared base** | `${LOOPOVER_REPO_CONFIG_DIR}/_shared/.loopover.yml` | Operator only | Lowest-priority cross-repo house policy for an operator running many repos (#1959) — see [README's "Shared base layer" section](./README.md#shared-base-layer-multi-repo-operators-1959) |

When **either** a private global or private per-repo file exists, the loader **never fetches** the
public repo file for that review — mount private policy deliberately. See [README.md](./README.md)
for precedence and deep-merge rules.

**Never commit real private policy** (maintainer logins, thresholds, autonomy dials you do not want
contributors to read) into a public repository. Copy `global.loopover.yml` into your gitignored
`loopover-config/` mount and edit there.

## Quick start

### Public repo (contributor-visible config)

```bash
cp config/examples/loopover.minimal.yml .loopover.yml
# edit wantedPaths / gate when ready
```

### Self-host private mount (operator-only policy)

```bash
mkdir -p loopover-config
cp config/examples/global.loopover.yml loopover-config/.loopover.yml
# edit your-admin-login placeholders before going live
# optional per-repo overlay:
mkdir -p loopover-config/myorg__myrepo
cp config/examples/repo-override.loopover.yml loopover-config/myorg__myrepo/.loopover.yml
```

Point `LOOPOVER_REPO_CONFIG_DIR` at that directory (default `/config` in `docker-compose.yml` maps
`./loopover-config`).

## Fleet examples (without committing private policy)

These patterns apply to common JSONbored repos. **Do not copy real maintainer logins or thresholds
into public git** — use the private mount for anything marked *private* below.

### `JSONbored/loopover` (dogfooding)

- **Public** `.loopover.yml` in the repo: work-area guardrails, test expectations, gate dimensions
  contributors should understand.
- **Private** `loopover-config/` (gitignored locally, operator mount in production): fleet
  autonomy, anti-abuse caps, maintainer exemption lists — the same split described in
  [`global.loopover.yml`](./global.loopover.yml).
- Start from `loopover.minimal.yml` in the public repo until gate semantics are tuned, then promote
  fields into the private global default as you enable autonomous review.

### `JSONbored/awesome-claude` (public template repo)

- Prefer **`loopover.minimal.yml`** or a trimmed public manifest: `wantedPaths`, linked-issue
  policy, and advisory gate modes only.
- Keep contributor caps, `autoCloseExemptLogins`, and `autonomy.close: auto` in **private config
  only** — this repo is meant to be copied; do not bake operator-specific enforcement into its
  public history.

### `JSONbored/metagraphed` (sibling product repo)

- Same split as `loopover`: public manifest for transparent contributor guidance; private mount
  for thresholds and maintainer-only rules.
- Use `repo-override.loopover.yml` when one repo needs different `expectedCiContexts` or
  `gate.checkMode: disabled` while sharing a fleet-wide `global.loopover.yml` baseline.

## Validation

Every template in this directory is parsed in CI (`test/unit/config-templates.test.ts` and
`test/unit/selfhost-config-examples.test.ts`). The exhaustive template body is kept identical to
`.loopover.yml.example` from `# WHERE IT LIVES` onward. Lint a local file before deploy:

```bash
npx tsx scripts/loopover-config-lint.ts path/to/.loopover.yml
```
