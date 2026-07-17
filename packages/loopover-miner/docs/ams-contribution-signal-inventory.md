# AMS contribution-profile: real-world eligibility-signal inventory

Research inventory for **#6794**. Evidence-gathering only — the `ContributionProfile` schema this informs is
designed in the dependent issue (#6795), and no code changes are part of this deliverable.

## Purpose

Before AMS can build a per-repo contribution profile (the #6793 epic), we need an accurate, evidence-based
picture of what real repositories actually expose as PR-eligibility signals — which signal types exist, where
they live, and how consistently they carry machine-extractable meaning versus prose a human has to interpret.
This is an audit of real examples, not an assumption of what "most repos" do.

## Sample

Ten public repositories, chosen for a spread of contribution norms, sizes, and documentation maturity:

| Repo                       | Why in the sample                                                        |
| -------------------------- | ------------------------------------------------------------------------ |
| `JSONbored/loopover`       | Gate-enabled, this project's own convention (the reference case)         |
| `JSONbored/metagraphed`    | Gate-enabled sibling in the same gate family                             |
| `facebook/react`           | Large OSS, mature contribution process, heavy AI-agent tooling           |
| `rust-lang/rust`           | Very large, deeply structured label taxonomy (~960 labels)               |
| `microsoft/vscode`         | Very large label taxonomy (~700 labels), triage-automation heavy         |
| `cli/cli`                  | Mid-size OSS with an explicit, prose-stated contributor-eligibility rule |
| `denoland/deno`            | Mid-size OSS, triage-state-oriented labels, no first-issue vocabulary    |
| `honojs/hono`              | Small OSS, minimal label set, generic docs                               |
| `tailwindlabs/tailwindcss` | Small OSS with a "discuss first, PRs likely closed" norm                 |
| `sindresorhus/ky`          | Minimal library — no repo-local contribution docs at all                 |

`ljharb/qs` was also spot-checked as a second no-local-docs case and behaves like `ky`.

## Method

Per repo, via the GitHub REST API and the git-trees API (authoritative file list, not per-path `contents`
probes, which false-positive on case-insensitive/redirected paths):

- **Labels** — `GET /repos/{owner}/{repo}/labels` (paginated), reading each label's `name` **and**
  `description`, judging eligibility/scope meaning from those two fields alone.
- **Docs presence** — `GET /repos/{owner}/{repo}/git/trees/{default_branch}?recursive=1`, filtered for
  `CONTRIBUTING.md`, `.github/PULL_REQUEST_TEMPLATE(.md|/)`, `.github/ISSUE_TEMPLATE/`, `AGENTS.md`,
  `CLAUDE.md`, `.claude/**`, `.cursorrules`/`.cursor/rules`, `CODEOWNERS`.
- **Docs content** — fetched `CONTRIBUTING.md` and the PR template for each repo that has them, and read for
  the four eligibility questions below.

## The four eligibility questions (per repo)

1. **Label taxonomy** — do any labels read as eligibility/scope signals from name + description alone?
2. **`CONTRIBUTING.md`** — does it state a linked-issue requirement, a required-label rule, or assignment/claim
   rules?
3. **PR template** — is there one, and does it carry an eligibility checkbox (e.g. "link the issue this closes")?
4. **AI-agent-facing docs** — `AGENTS.md` / `CLAUDE.md` / `.claude/skills/**` / `.cursor/rules` that state
   contribution rules explicitly for an AI contributor (as opposed to general build/dev guidance)?

## Master inventory

`Y` = present and eligibility-bearing · `dev` = present but developer/build guidance only (no
contributor-eligibility rules) · `soft` = present but optional/advisory · `—` = absent.

| Repo                       | Eligibility labels                                     | Exclusion labels                                                          | CONTRIBUTING eligibility rule                             | PR template        | Linked-issue requirement                      | Agent-facing contribution docs                   |
| -------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------ | --------------------------------------------- | ------------------------------------------------ |
| `JSONbored/loopover`       | **Y** (machine-readable in description)                | **Y** (`maintainer-only`)                                                 | **Y** (linked open eligible issue required)               | Y (checkbox)       | **Required (hard)**                           | **Y** (`CLAUDE.md`/`AGENTS.md`/`.claude/skills`) |
| `JSONbored/metagraphed`    | **Y** (machine-readable in description)                | **Y** (`maintainer-only`)                                                 | **Y** (linked open eligible issue required)               | Y (multi-template) | **Required (hard)**                           | **Y** (`CLAUDE.md`/`AGENTS.md`/`.claude/skills`) |
| `cli/cli`                  | Y (`help wanted`, `good first issue`)                  | **Y** (`core` = "not accepting PRs from outside contributors")            | **Y** ("PRs accepted for issues labelled `help wanted`")  | Y                  | soft (`Fixes #N`)                             | dev (`AGENTS.md`)                                |
| `microsoft/vscode`         | Y (`help wanted`, `good first issue`)                  | **Y** (`team-low-hanging` = "No external contributions will be accepted") | —                                                         | Y                  | soft ("Associate an issue")                   | dev (`AGENTS.md`)                                |
| `rust-lang/rust`           | Y (rich `E-*` family)                                  | — (uses `S-*`/`needs-*` workflow states, not a "no PRs" label)            | — (redirects to dev-guide)                                | Y                  | **soft (explicitly optional)**                | dev (only in `rust-analyzer` subtree)            |
| `denoland/deno`            | soft (triage-state only; no first-issue vocab)         | —                                                                         | — (anti-AI-spam clause only)                              | Y                  | soft ("ensure a related issue is referenced") | dev (`CLAUDE.md`/`.claude/skills`)               |
| `facebook/react`           | Y (`good first issue`, `Difficulty:*`)                 | —                                                                         | — (generic)                                               | Y                  | —                                             | dev (extensive `.claude/skills`, build tasks)    |
| `honojs/hono`              | soft (`help wanted`, empty description)                | —                                                                         | — (generic)                                               | Y                  | —                                             | —                                                |
| `tailwindlabs/tailwindcss` | soft (`good first issue`, empty description)           | —                                                                         | **negative** ("discuss first; feature PRs likely closed") | Y                  | —                                             | —                                                |
| `sindresorhus/ky`          | soft (GitHub-default `good first issue`/`help wanted`) | —                                                                         | — (none repo-local)                                       | —                  | —                                             | —                                                |

## Findings by signal type

### 1. Labels — the name is portable; the description usually is not

- **Eligibility label _names_ are the most common cross-repo signal.** `good first issue` and/or `help wanted`
  appear in 7 of 10 repos (react, vscode, cli, hono, tailwind, ky, and loopover carries `help wanted` too).
  They are the closest thing to a universal, name-only eligibility hint.
- **Label _descriptions_ are unreliable as an eligibility source in almost every repo.** They are frequently
  empty (react's `Difficulty:*` and `good first issue`, hono's `help wanted`, tailwind's `good first issue`),
  or they restate GitHub's stock defaults with no repo-specific meaning (`ky`: `good first issue` = "Good for
  newcomers", `help wanted` = "Extra attention is needed"). Where descriptions do carry content, the wording
  is inconsistent even for the same label name — `help wanted` is "Contributions welcome" (cli), "good
  community contribution opportunities" (vscode), or empty (hono).
- **Only the two gate-enabled repos put machine-readable eligibility semantics _in the description_.**
  `loopover` and `metagraphed` are alone in the sample in encoding, directly in each label's description text,
  whether an issue is contributor-eligible, what scope it belongs to, and its relative priority — plus an
  explicit `maintainer-only` label whose description states the work is not contributor-eligible. This is the
  only place in the whole sample where a label description alone is sufficient to decide eligibility
  programmatically.
- **Large taxonomies dilute rather than clarify.** rust (~960 labels) and vscode (~700) have rich vocabularies,
  but eligibility signal is spread thin: rust's `E-*` "Call for participation" family (`E-easy`, `E-mentor`,
  `E-help-wanted`, `E-needs-*`) is unusually well-described, yet most of the taxonomy is triage/team/status
  state irrelevant to a contributor. A profile builder must _select_ the eligibility-bearing labels out of a
  large set, not treat label count as signal strength.
- **Exclusion is expressed more consistently than inclusion, when it is expressed at all.** Three repos state a
  hard "not for outside contributors" signal, and all three put it somewhere machine-readable: `loopover`/
  `metagraphed`'s `maintainer-only` label, `cli/cli`'s `core` label ("This issue is not accepting PRs from
  outside contributors"), and `vscode`'s `team-low-hanging` ("No external contributions will be accepted"). The
  last two are notable: a non-loopover repo _can_ carry an exclusion rule in a label description.

### 2. `CONTRIBUTING.md` — present often, eligibility-bearing rarely

- 8 of 10 repos have a `CONTRIBUTING.md` (only `ky`/`qs` have none repo-local). Presence is common; a
  contributor-eligibility _rule_ inside it is not.
- **Explicit label-gated eligibility in prose exists but is rare.** `cli/cli` is the clearest non-loopover
  example: "We accept pull requests for issues labelled `help wanted`" — a directly extractable rule, and it
  agrees with the `core` label description. `loopover`/`metagraphed` state the linked-open-eligible-issue
  requirement in prose _and_ enforce it at the gate.
- **Negative eligibility rules occur.** `tailwindcss` tells contributors to open a discussion first and warns
  that unsolicited feature PRs are "likely to close" — a real eligibility signal, but stated only as prose
  discouragement with no label or template mechanism behind it.
- **Most CONTRIBUTING files are generic.** react and hono cover bug-reporting and setup but state no
  linked-issue or label gate. rust's top-level `CONTRIBUTING.md` largely redirects to the rustc-dev-guide,
  where the real norms (E-labels, `@rustbot claim`) live — i.e. the eligibility norm can sit one hop away from
  the file a scraper would first read.

### 3. PR templates — near-universal, but a weak eligibility source

- 9 of 10 repos have a PR template (all but `ky`). So "has a PR template" is almost no signal at all.
- **Linked-issue enforcement strength is a spectrum, and the template wording reveals it:**
  - **Hard-required:** loopover/metagraphed — an explicit checkbox ("I linked a currently open issue this PR
    resolves … required for every contributor PR"), backed by the gate.
  - **Requested:** deno ("Ensure there is a related issue and it is referenced"), vscode ("Associate an issue
    with the Pull Request"), cli (`Fixes #NUMBER`).
  - **Explicitly optional:** rust ("If you don't know of a related tracking issue … feel free to ignore this").
  - **Absent:** react, hono, tailwind ask only for a summary/validation, with no issue field.
- Only loopover/metagraphed carry an eligibility _checklist_ (scope, linked-issue, secret-hygiene boxes). The
  rest are description prompts, not eligibility gates.

### 4. AI-agent-facing docs — increasingly common, almost never about eligibility

- **Agent-facing files are now common:** 7 of 10 repos carry at least one of `AGENTS.md`, `CLAUDE.md`, or a
  `.claude/skills/**` tree (loopover, metagraphed, react, vscode, cli, deno, and rust in its `rust-analyzer`
  subtree). hono, tailwind, and ky have none.
- **But their _purpose_ splits sharply.** In 5 of those 7, the agent docs are developer/build guidance — how to
  run the compiler, extract error codes, format, triage, port a pass (react's `.claude/skills/{flow,
feature-flags,extract-errors}` and `compiler/.claude/**`; deno's `.claude/skills/{fmt,lint,node-compat,
review-pr}`; vscode/cli `AGENTS.md`). None of these tell an external AI contributor which _issues_ are
  eligible to work on or what a PR must satisfy to be accepted.
- **Only loopover/metagraphed use agent docs to state contribution _eligibility_ rules for an AI contributor.**
  Their `CLAUDE.md` + `AGENTS.md` + `.claude/skills/contributing-to-*` spell out the linked-issue requirement,
  the scored-label convention, scope boundaries, and the one-shot gate — exactly the rules a profile would need.
  This is the richest agent-facing eligibility source in the sample, and it is unique to this gate family.

## Consistency analysis

- **Signal _location_ is inconsistent.** The same fact ("which issues may I PR against?") lives in a label
  description in one repo, in `CONTRIBUTING.md` prose in another, in a dev-guide one hop from CONTRIBUTING in a
  third, and nowhere explicit in a fourth. No single file is a reliable sole source.
- **Signal _shape_ is inconsistent.** Label descriptions range from machine-readable eligibility+scope+priority
  (loopover) to empty (hono/tailwind) to stock GitHub defaults (ky). A profile builder cannot assume a
  description means anything.
- **Name-level conventions are the most portable thing.** `good first issue` / `help wanted` as label _names_,
  and a `Closes/Fixes #N` phrase in a PR body, are the two conventions that recur across unrelated repos — but
  both are weak: the label names carry no enforcement, and the closing keyword is optional in most repos.
- **Explicit, enforceable, machine-readable eligibility is the exception, not the norm** — in this sample it is
  essentially unique to the gate-enabled repos, precisely the case AMS already handles. Every other repo sits
  somewhere on a gradient from "prose hints a human must interpret" (cli, tailwind, rust) down to "no explicit
  signal at all" (ky/qs), which is the case the epic's "deliberately conservative when no profile can be
  inferred" requirement exists for.

## Implications for the `ContributionProfile` schema (#6795)

Grounded in the above, the next issue's schema should assume:

1. **Multi-source extraction is mandatory**, not optional — no single file suffices. The profile must be able to
   draw eligibility rules from labels, `CONTRIBUTING.md`, the PR template, and agent-facing docs, and merge
   them.
2. **Per-rule source provenance matters**, because the _same_ rule can come from a strong source (an enforced
   label) or a weak one (an optional prose sentence). The schema already lists provenance in #6795's draft; the
   evidence confirms it is essential for the confidence calculation, not just debuggability.
3. **Confidence must be first-class and usually low.** Only 2 of 10 repos yield a high-confidence, fully
   machine-readable profile. The common case is a partial/inferred profile (a `help wanted` name with no
   enforcement) or none at all — so `discover` must treat an uncertain profile conservatively by design.
4. **Model inclusion and exclusion rules separately.** Exclusion signals (`maintainer-only`, `core`,
   `team-low-hanging`) are expressed more consistently and machine-readably than inclusion signals, and a false
   negative on an exclusion rule (PRing a `core`/`maintainer-only` issue) is exactly the auto-close waste the
   epic exists to prevent — so exclusion should be extracted and weighted at least as strongly as inclusion.
5. **Label _descriptions_ deserve extraction but not trust by default.** Parse them (loopover-shaped repos put
   real semantics there), but gate any eligibility inference drawn from a description on corroboration or a low
   confidence score, since most repos' descriptions are empty or generic.
6. **Name-level heuristics (`good first issue` / `help wanted`) are a reasonable low-confidence default** for
   the majority of repos that expose nothing stronger, but must never be treated as an enforcement guarantee.

## Appendix — raw per-repo notes

- **loopover / metagraphed:** ~27 labels; `gittensor:*` label descriptions carry eligibility+scope+relative-
  priority semantics and `maintainer-only` marks non-contributor work; `CONTRIBUTING.md` + PR-template checkbox
  require a linked open eligible issue; full `CLAUDE.md`/`AGENTS.md`/`.claude/skills/contributing-to-*` for AI
  contributors. metagraphed additionally uses a `.github/PULL_REQUEST_TEMPLATE/` directory (backend/docs/
  provider/surface variants).
- **facebook/react:** 76 labels (`good first issue`, `Difficulty: starter|medium|challenging`, all empty
  descriptions); generic `CONTRIBUTING.md`; PR template asks only how the change was verified; large
  `.claude/skills/**` + `compiler/.claude/{rules,agents,skills}` — all build/dev tasks.
- **rust-lang/rust:** ~960 labels; well-described `E-*` "Call for participation" family is the eligibility
  vocabulary; top-level `CONTRIBUTING.md` redirects to the dev-guide; PR template's tracking-issue line is
  explicitly optional; agent docs only under `src/tools/rust-analyzer/`.
- **microsoft/vscode:** ~700 labels; `good first issue`/`help wanted` described for contributors, and
  `team-low-hanging` explicitly excludes external PRs; no root `CONTRIBUTING.md` eligibility rule; PR template
  says "Associate an issue"; `AGENTS.md` is dev guidance.
- **cli/cli:** 80 labels; `help wanted` = "Contributions welcome", `core` = "not accepting PRs from outside
  contributors", `help wanted candidate` = not-yet-ready; `CONTRIBUTING.md` states PRs are accepted for
  `help wanted` issues; PR template uses `Fixes #NUMBER`; `AGENTS.md` is dev guidance.
- **denoland/deno:** 121 labels, triage-state oriented (`needs triage`, `needs discussion`, `feat` =
  accepted), no first-issue vocabulary; `CONTRIBUTING.md` has an anti-AI-spam clause; PR template asks for a
  referenced related issue; `CLAUDE.md` + `.claude/skills/**` are maintenance tasks.
- **honojs/hono:** 24 labels (`help wanted`/`triage`, empty descriptions); generic `docs/CONTRIBUTING.md`; PR
  template is a tests/format checklist; no agent docs.
- **tailwindlabs/tailwindcss:** 17 labels (`good first issue` empty); `CONTRIBUTING.md` directs feature ideas
  to Discussions and warns unsolicited feature PRs are likely closed; PR template is a summary prompt; no agent
  docs.
- **sindresorhus/ky:** 13 labels, all GitHub/Issuehunt defaults; no repo-local `CONTRIBUTING.md`, PR template,
  issue template, or agent docs (org-level `.github` defaults may apply, but nothing is exposed at the repo
  level). `ljharb/qs` behaves the same way.
