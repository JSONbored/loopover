# Self-host private config — layout, precedence, and examples

This directory ships **generic, safe** examples for the self-host **private** config directory
(`GITTENSORY_REPO_CONFIG_DIR`, default `/config` in the Docker image / `docker-compose.yml`). It
contains no real policy, thresholds, logins, or repo names — copy what you need into your own
mounted config directory and edit it there (never in this repo).

The private config directory is read by `src/selfhost/private-config.ts` and is kept **out of the
public GitHub repo** on purpose: contributors can read a public `.gittensory.yml`, so anti-abuse
thresholds, maintainer/admin allowlists, autonomy dials, and model/effort settings belong here
instead, where only the self-host operator can see them.

## Directory layout

For a repo `owner/repo`, the reader tries, in priority order:

```
${GITTENSORY_REPO_CONFIG_DIR}/owner__repo/.gittensory.yml   # 1. owner-qualified folder (recommended)
${GITTENSORY_REPO_CONFIG_DIR}/repo/.gittensory.yml          # 2. bare repo-name folder
${GITTENSORY_REPO_CONFIG_DIR}/owner__repo.yml               # 3. flat file (back-compat)
${GITTENSORY_REPO_CONFIG_DIR}/.gittensory.yml               # 4. global default, shared by every repo
```

`.yaml` and `.json` are accepted everywhere `.yml` is. Every one of these files uses the **exact
same schema** as the public `.gittensory.yml` — see [`.gittensory.yml.example`](../../.gittensory.yml.example)
at the repo root for the exhaustive, field-by-field reference (not duplicated here, so the two
never drift out of sync).

## Precedence chain

From highest to lowest priority:

1. **Private per-repo file**, deep-merged over **2** when both exist (see below) — or used alone
   when only a per-repo file exists.
2. **Private global default** (`${GITTENSORY_REPO_CONFIG_DIR}/.gittensory.yml`) — used alone when
   a repo has no per-repo file of its own.
3. When **neither** a private per-repo nor a private global file exists, the loader falls back to
   the **public repo `.gittensory.yml`** (or `.github/gittensory.yml`) fetched from GitHub.
4. **Dashboard/API-stored settings** for the repo.
5. **Built-in safe defaults.**

Layers 1-2 are evaluated together as one private-config layer: if *either* a per-repo or a global
file exists privately, the public file in layer 3 is **never consulted** for that repo. This is
unchanged from the original private-config behavior (#1390) — only the interaction *between* the
private per-repo and private global layers is new.

## Overlay (deep-merge) semantics

When **both** a per-repo file and a global default exist for a repo, they are merged — the
per-repo file overlaid onto the global default:

- **Nested mappings** (`gate`, `settings`, `review`, `features`, `contentLane`, and their own
  nested blocks like `gate.readiness` or `gate.aiReview`) merge **key by key**. A per-repo file
  only needs to mention the keys it wants to change; everything else is inherited from global.
- **Arrays** (`wantedPaths`, `blockedPaths`, `preferredLabels`, `testExpectations`,
  `review.pathInstructions`, `review.excludePaths`, `contentLane.duplicateKeyFields`, etc.)
  **replace wholesale** — a per-repo array is never concatenated with the global one.
- An **explicit `null`** at a key in the per-repo file always overrides the global value there.
  This clears a setting wherever the manifest parser already treats an explicit `null` as
  "off"/"clear" — e.g. `settings.contributorOpenPrCap`, `settings.contributorOpenIssueCap`, and
  `settings.accountAgeThresholdDays` — and is a harmless no-op (equivalent to omitting the key)
  everywhere else.
- If either file fails to parse (or is malformed/oversized), the merge is skipped and the
  still-valid file is used alone; a still-good sibling's policy is never silently discarded just
  because the other file is broken.

### Example 1 — global defaults + a per-repo override

`.gittensory.yml` (global default, at the config dir root):

```yaml
settings:
  contributorOpenPrCap: 3
  autoCloseExemptLogins:
    - your-admin-login
gate:
  enabled: true
  duplicates: block
```

`owner__repo/.gittensory.yml` (per-repo override — only touches what's different for this repo):

```yaml
gate:
  enabled: true
  # duplicates is inherited from global (still "block") — not repeated here.
  aiReview:
    mode: advisory
```

The effective config for `owner/repo` has `gate.duplicates: block` (from global),
`gate.aiReview.mode: advisory` and `gate.enabled: true` (from the per-repo file), and
`settings.contributorOpenPrCap: 3` plus the exempt login (both from global).

### Example 2 — disabling a global setting for one high-trust repo

```yaml
# owner__repo/.gittensory.yml
settings:
  contributorOpenPrCap: null   # explicitly clears the global cap of 3 for this repo only
```

### Example 3 — an admin/maintainer exemption list

Shared anti-abuse mechanisms (the review-request-nag cooldown, the contributor open-item cap)
exempt configured logins on top of the standing owner/admin/automation-bot exemption:

```yaml
# .gittensory.yml (global default)
settings:
  autoCloseExemptLogins:
    - your-trusted-regular
```

## What belongs here vs. in the public `.gittensory.yml`

- **Private config** (this directory): anti-abuse thresholds, the contributor cap, maintainer/
  admin exemption logins, autonomy dials, model/effort overrides, and anything else you don't want
  a contributor reading and gaming.
- **Public `.gittensory.yml`** (repo root, contributor-visible): work-area guidance
  (`wantedPaths`/`blockedPaths`), test expectations, and review-panel presentation — nothing here
  should describe your private enforcement strategy.

## Safety

Never commit real policy into this directory or into these example files: no maintainer usernames,
no repo names, no thresholds beyond illustrative placeholders, no secrets or tokens. The two
`.gittensory.yml` files shipped alongside this README are deliberately generic and inert — copy
them into your own mounted `GITTENSORY_REPO_CONFIG_DIR` and edit the copy, not this one.
