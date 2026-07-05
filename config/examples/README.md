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
- **Arrays** (`wantedPaths`, `preferredLabels`, `testExpectations`,
  `review.pathInstructions`, `review.excludePaths`, `contentLane.duplicateKeyFields`, etc.)
  **replace wholesale** — a per-repo array is never concatenated with the global one.
- An **explicit `null`** at a key in the per-repo file always overrides the global value there.
  This clears a setting wherever the manifest parser already treats an explicit `null` as
  "off"/"clear" — e.g. `settings.contributorOpenPrCap`, `settings.contributorOpenIssueCap`,
  `settings.accountAgeThresholdDays`, and the enforcement label names
  (`settings.blacklistLabel`/`contributorCapLabel`/`reviewNagLabel`, see below) — and is a harmless
  no-op (equivalent to omitting the key) everywhere else.
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

## Label autonomy scoping for one-shot review mode

Two `autonomy` classes govern every label the bot can apply, and they are **independent**:

- **`close`** authorizes the terminal merge/close/hold disposition **and** the anti-abuse
  enforcement labels tied to it (blacklist/contributor-cap/review-nag) — a label like
  `over-contributor-limit` is inseparable metadata on its close, so it never needs a separate grant.
  Set `settings.contributorCapLabel`/`blacklistLabel`/`reviewNagLabel` to explicit `null` (not just
  omitted) to close/hold **without** applying any label at all.
- **`review_state_label`** authorizes the bot's own disposition-communication labels only —
  `ready-to-merge` / `changes-requested` / `manual-review` /
  `migration-collision` by default. These are advisory commentary about the bot's own verdict, not
  enforcement, and default OFF like every autonomy class. **For a one-shot review model, leave this
  at the default** so a PR merges, closes, or holds through the required gate check alone — set it
  to `auto` only if you specifically want that commentary as GitHub labels too.

All disposition labels are configurable under `settings.*Label`, and explicit `null` disables the
label without disabling the underlying merge/close/hold decision. Hard path guardrails are
config-as-code only: omitting `settings.hardGuardrailGlobs` or setting it to `[]` means no path
guardrails, and a concrete list replaces any lower-layer private global default.

```yaml
# .gittensory.yml (global default) — recommended one-shot baseline
settings:
  autonomy:
    close: auto
    # review_state_label intentionally omitted (defaults to observe)
```

The broad `autonomy.label` class still exists but no longer gates any of the above — it is not
required for either family and applies to nothing on its own.

## Maintainer-mention nag moderation

`settings.reviewNagMonitoredMentions` extends the `@gittensory`-ping review-nag cooldown
(`reviewNagPolicy`/`reviewNagMaxPings`/`reviewNagCooldownDays`/`reviewNagLabel` — same settings,
one shared policy) to **also** throttle a thread's own author repeatedly @-mentioning a configured
maintainer login, counted independently per login and independently of the `@gittensory` counter:

```yaml
# .gittensory.yml (global default)
settings:
  reviewNagPolicy: hold
  reviewNagMonitoredMentions:
    - your-maintainer-login
```

Owner/admin/automation-bot logins and anyone on `autoCloseExemptLogins` are always exempt, and only
the thread's own author is ever throttled — a third party mentioning the login on someone else's
PR/issue never counts.

## Linked-issue label propagation

`settings.linkedIssueLabelPropagation` copies a label from a linked/closing issue onto the PR when
the issue already carries it — the only mechanism that can ever select a maintainer-reward or
moderation-weighted label; it is never inferred from a PR's title, changed files, AI output, or
existing PR labels. If your labels carry that kind of weight, this is exactly the sort of rule that
belongs in the private layer rather than the public `.gittensory.yml`, so a contributor can see
*that* the mapping exists (via its effect) without being able to read the exact issue-label ->
PR-label rules and game them:

```yaml
# .gittensory.yml (global default)
settings:
  linkedIssueLabelPropagation:
    enabled: true
    mode: exclusive_type_label
    mappings:
      - issueLabel: customer:vip
        prLabel: triage:vip
        removeOtherTypeLabels: false
```

A per-repo override's `mappings` list **replaces** the global default wholesale (the standard
array-replace overlay semantics above) — it does not merge with it.

## What belongs here vs. in the public `.gittensory.yml`

- **Private config** (this directory): anti-abuse thresholds, the contributor cap, maintainer/
  admin exemption logins, autonomy dials, model/effort overrides, and anything else you don't want
  a contributor reading and gaming.
- **Public `.gittensory.yml`** (repo root, contributor-visible): work-area guidance
  (`wantedPaths`), test expectations, and review-panel presentation — nothing here
  should describe your private enforcement strategy.

## Safety

Never commit real policy into this directory or into these example files: no maintainer usernames,
no repo names, no thresholds beyond illustrative placeholders, no secrets or tokens. The two
`.gittensory.yml` files shipped alongside this README are deliberately generic and inert — copy
them into your own mounted `GITTENSORY_REPO_CONFIG_DIR` and edit the copy, not this one.
