---
layout: home

hero:
  name: Gittensory
  text: Gittensor repo intelligence for miners, maintainers, and coding agents.
  tagline: Backend-only signals, MCP branch preflight, and GitHub App review context. Not a Gittensor frontend.
  actions:
    - theme: brand
      text: Install MCP
      link: /guide/install
    - theme: alt
      text: GitHub App Setup
      link: /guide/github-app-setup

features:
  - title: Miner Decision Packs
    details: Rank next actions with private reward/risk reasoning, lane context, score blockers, open PR pressure, and maintainer friction.
  - title: Local MCP Preflight
    details: Let Codex, Claude, Cursor, and other MCP clients inspect branch metadata without uploading source contents.
  - title: Maintainer Reviewability
    details: Generate PR packets, check runs, duplicate context, and public-safe guidance that reduces noisy Gittensor-driven review load.
  - title: Registry-Aware Signals
    details: Normalize Gittensor registry data, repo lanes, label multipliers, queue health, collisions, bounties, and configuration readiness.
  - title: Private By Default
    details: GitHub OAuth sessions are short-lived Gittensory tokens. User PATs are not stored. Public comments never include private score context.
  - title: API First
    details: The API is the product surface. Lovable or other frontends can consume it later without turning Gittensory into another Gittensor dashboard.
---

## What Gittensory Is

Gittensory is a private backend intelligence layer for Gittensor registered repositories.
It helps Gittensor miners and contributors decide what to work on next, and it helps maintainers understand whether a Gittensor-driven PR is clean, duplicate-prone, stale, missing evidence, or worth reviewing.

It is not a Gittensor frontend, not a public leaderboard, and not a reward estimator for public comments. The useful surface is the signal: role-aware repo context, official Gittensor stats, local branch preflight, queue health, duplicate risk, and maintainer-friendly review packets.

## Primary Surfaces

| Surface | Who uses it | What it does |
| --- | --- | --- |
| MCP package | miners and coding agents | Runs local branch analysis, score blocker checks, preflight, and PR packet generation. |
| REST API | internal tools and future clients | Serves decision packs, repo intelligence, reviewability, readiness, and branch analysis. |
| GitHub App | maintainers and repo owners | Adds private check-run intelligence and optional public-safe PR comments. |

## Current Status

Gittensory is still private beta. The MCP package remains restricted until the public launch gate passes, but the install flow is already shaped for a simple public npm path.
