# Code Of Conduct

LoopOver is maintained as a direct, technical, evidence-first project. We expect contributors,
maintainers, and users to keep discussions focused on the work, the proof, and the production
impact.

## Expected Behavior

- Be respectful and specific when giving or receiving feedback.
- Keep criticism technical and actionable.
- Assume public issues and PRs are permanent public records.
- Use private reporting channels for security issues or sensitive evidence.
- Remove secrets, tokens, wallet details, private keys, local paths, and private scoring output
  before posting logs, screenshots, or reproduction steps.
- Respect maintainer scope decisions when a PR is closed, split, or redirected.

## Unacceptable Behavior

- Harassment, threats, personal attacks, slurs, or sexualized language.
- Spam, reward-farming noise, generated bulk submissions, or intentionally low-effort PRs.
- Plagiarism — copying another contributor's PR, diff, commits, or work and submitting it as your
  own, including lightly reworded or re-tested copies filed under a different account to claim
  credit or farm Gittensor rewards.
- Posting secrets, private contributor evidence, private maintainer evidence, wallet details,
  hotkeys, coldkeys, raw trust scores, or private rankings publicly.
- Misrepresenting LoopOver output as guaranteed compensation, guaranteed ranking, or financial
  advice.
- Evading review boundaries by reopening closed work without addressing the stated reason.
- Attempting to bypass authentication, rate limits, GitHub App permissions, or Cloudflare Worker
  controls.
- Manipulating the review bot or automated gate — embedding hidden or misleading instructions in
  code, comments, PR titles/bodies, file contents, or commit messages to influence the AI review or
  pass the gate (prompt injection).
- Circumventing CI or the gate — disabling or weakening tests, faking or gaming coverage,
  fabricating tests to satisfy Codecov, or editing CI to skip required checks.
- Submitting malicious or destructive code — malware, backdoors, secret exfiltration, malicious
  dependencies, destructive migrations, or anything intended to damage the codebase, its data, or
  production systems.
- Abusing system resources — webhook floods, deliberately triggering expensive re-reviews or CI
  runs, or attempts to exhaust the review bot's compute or credits.

## Enforcement

Maintainers may edit or delete comments, close issues or PRs, block users, or report abuse when
behavior violates this Code of Conduct, the contribution guidelines, or GitHub's terms.

Enforcement is proportional and escalates with intent and repetition:

- Opening your own issue and then submitting a PR that resolves it is welcome, and a PR with no
  linked issue is fine — neither is farming.
- Off-scope or low-effort work is closed or relabeled, with no further penalty.
- Reward-farming is against policy: using more than one account under the same person's control
  (alt / sock-puppet accounts) — for example, one account opening issues for another account to
  "resolve" — or manufacturing low-value/slop issues and bulk point-chasing PRs to inflate
  contribution credit. Linked issues from farming are closed so the work earns no bonus credit, and
  a warning is issued; continuing after a warning, or any confirmed multi-account (sock-puppet)
  farming, results in submissions being closed and labeled on sight and a block from contributing.
- Plagiarism and ban-evasion — copying another contributor's work, or returning under a new account
  after a block — result in an immediate **permanent block from contributing across all of our
  repositories** (`JSONbored/loopover`, `JSONbored/metagraphed`, `JSONbored/awesome-claude`).

## Contribution Terms

By submitting, you affirm the work is your own original work and that you have the right to contribute
it under this repository's license. Contributing is not an entitlement: contribution scoring and any
Gittensor rewards are set by the subnet's on-chain hyperparameters and validators, not by us, and all
decisions — merge, close, scope, policy, timing, labels, and blocks — are at maintainer discretion and
final. Report security issues privately (below) rather than exploiting or weaponizing them in a PR;
good-faith research is welcome through that channel.

For security issues, use GitHub private vulnerability reporting:

https://github.com/JSONbored/loopover/security/advisories/new

For non-sensitive support, use GitHub issues and follow `SUPPORT.md`.
