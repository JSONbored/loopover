# AMS auth/identity research — options for a hosted, multi-tenant login layer

Research spike for **#5217**. AMS has no auth/identity layer today — self-host is single-operator, single-machine,
with no login concept at all. A hosted AMS needs one. This document surveys realistic approaches, evaluated
**against the installation-token / GitHub App patterns gittensory already operates** (ORB's token-broker,
`src/orb/broker.ts`), so the eventual auth/identity design issue starts from a baseline consistent with existing
infrastructure rather than an unrelated auth stack. **Research and writeup only — no auth flow, token exchange,
or provider integration is implemented or decided here; the output is a non-binding input to the maintainer-owned
auth design issue. It does not propose any change to `src/orb/broker.ts`'s existing behavior, cited strictly as
precedent.**

## Summary

**Recommendation (non-binding): lead with GitHub OAuth as the identity source, reusing ORB's existing
maintainer-OAuth self-enrollment + installation-token broker, and add a managed identity provider only if/when
AMS must admit non-GitHub tenants (email/SSO).** AMS is already a GitHub-centric system whose authority is the
GitHub *installation*; ORB's broker (`src/orb/broker.ts`, #1255) already proves installation ownership
server-side and mints short-lived installation tokens without the App private key ever leaving the center. Adding
a separate identity provider that duplicates "who owns this installation" would add attack surface for little
gain until a non-GitHub login requirement actually exists. A fully custom JWT/OIDC scheme is the highest-effort,
highest-risk option and is not recommended unless a specific requirement forces it.

Two properties of the existing precedent drive this:

1. **GitHub is already the authority.** ORB's "das-github-mirror" trust model treats the OPERATOR/installation
   as the authority: the maintainer-OAuth self-enrollment path (`src/orb/oauth.ts`, referenced from
   `broker.ts`) proves the caller is an **admin of the installation's account, server-side, before issuing** —
   which is exactly the "who is this tenant and what may they act on" question a hosted auth layer must answer.
2. **The token-mint is already solved and centrally trusted.** The broker binds `installation_id` **at issue
   time from the enrollment row, never from the request** (`broker.ts:8`, `:30`), so a stolen secret for
   install X can never mint a token for install Y. Any auth option must **reuse** this, not replace it — the
   GitHub-token path is orthogonal to tenant *login*.

## Baseline

- **AMS today:** the miner (`packages/loopover-miner`) reads a `GITHUB_TOKEN` from env and acts as a single
  operator — no login, no tenant, no session. This is the "before" the hosted auth layer must replace.
- **Existing precedent to build on (not re-invent):**
  - `src/orb/broker.ts` (#1255) — central GitHub App token-broker. A self-hosted container exchanges a one-time
    enrollment secret (shown once, stored only as a SHA-256 hash) for a short-lived (~1h) GitHub installation
    token via `POST /v1/orb/token`; `installation_id` is bound server-side at issue time.
  - `src/orb/oauth.ts` — maintainer-OAuth SELF-enrollment: proves the caller is an admin of the installation's
    account before issuing, closing the privilege-escalation surface a red-team flagged.
  - `src/orb/broker-client.ts` — the self-host side of the exchange; token cache lives with the App-key path in
    `src/github/app.ts` (one mint per ~hour per installation).
  - `src/auth/security` — `createOpaqueToken` / `hashToken` primitives already used for enrollment secrets.

## What a hosted AMS auth layer must do

1. **Establish tenant identity** — who is signing in.
2. **Map identity → the tenant's GitHub App installation(s)** — the unit AMS actually acts on.
3. **Authorize AMS resource access** — a tenant sees only their own loops/queues/ledgers (the `api_base_url`
   composite-key scope, #5563, is where a `tenant_id` would attach; see the storage-abstraction research).
4. **Obtain GitHub tokens to act** — already handled by the broker; the auth layer must feed it, not replace it.
5. **Session management** — issue/refresh/revoke tenant sessions.

## Options

### Option 1 — GitHub OAuth as identity, reusing the ORB broker + self-enrollment — *recommended lead*

- **Identity:** GitHub OAuth login; the tenant *is* their GitHub account/installation, exactly the authority
  `src/orb/oauth.ts` self-enrollment already establishes.
- **Broker interaction: REUSE.** Login proves installation admin (as oauth.ts already does), then the existing
  broker mints installation tokens unchanged. No second source of truth for installation ownership.
- **Security:** smallest new surface — leans on GitHub's OAuth and the already-hardened server-side
  `installation_id` binding; no new long-lived credential store beyond the existing hashed enrollment secrets.
- **Cost/limits:** requires every tenant to have a GitHub identity (true for AMS's current audience). Session
  layer (cookies/JWT) still needed on top, but scoped and small.

### Option 2 — Managed identity provider (Auth0 / Clerk / WorkOS) alongside the broker

- **Identity:** a dedicated IdP handles login (email, SSO, social), decoupling tenant identity from GitHub.
- **Broker interaction: ALONGSIDE.** The IdP authenticates the *person*; a linking step still binds that
  identity to a GitHub installation, after which the broker mints tokens unchanged. The IdP does **not** replace
  the broker — it sits in front of it.
- **Security:** offloads session/credential handling to a hardened vendor (MFA, SSO, breach monitoring) at the
  cost of a third-party dependency and an identity↔installation linking table that must be kept authoritative.
- **When it earns its keep:** only once AMS must admit tenants **without** a GitHub identity, or needs
  enterprise SSO. Until then it duplicates "who owns this installation" that Option 1 already answers.

### Option 3 — Custom token-based scheme (JWT / OIDC) — *not recommended*

- **Identity:** AMS mints and validates its own JWTs/OIDC tokens for tenant sessions.
- **Broker interaction:** still must call the broker for GitHub tokens (RUN ALONGSIDE), so it adds an auth stack
  without removing one.
- **Security:** re-implements key rotation, token revocation, and session hardening that a managed IdP or GitHub
  OAuth provides for free — the largest surface to get wrong, and the reason to avoid it absent a hard requirement.

## Interaction with ORB's installation-token exchange (per the deliverable)

| Option | GitHub OAuth (identity) | ORB broker (`broker.ts`) | Net |
|---|---|---|---|
| 1 — GitHub OAuth + self-enrollment | is the identity | **reuse unchanged** | smallest surface; GitHub is authority |
| 2 — Managed IdP alongside | IdP is identity; GitHub linked | **reuse** (fed by a linking step) | adds SSO/non-GitHub login; extra linking table |
| 3 — Custom JWT/OIDC | self-issued | **reuse** (run alongside) | most to build + secure; not recommended |

In every option the broker's server-side `installation_id` binding and short-lived token mint are **reused, not
replaced** — the token path is orthogonal to tenant login, and re-deriving installation ownership elsewhere would
reopen the privilege-escalation surface the self-enrollment design already closed.

## Recommendation (non-binding)

Start from **Option 1** (GitHub OAuth reusing the existing self-enrollment + broker) because GitHub is already
AMS's authority and the ownership-proof + token-mint are already built and hardened. Adopt **Option 2** (a
managed IdP, alongside — never replacing — the broker) only when a concrete non-GitHub-login or enterprise-SSO
requirement lands. Avoid **Option 3** unless a specific constraint rules the others out. This is an input to the
maintainer-owned auth/identity design issue, not the decision.
