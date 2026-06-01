# /app Final Polish — UX & Feature Improvements

Targeted enhancements to make the App surfaces feel like a real, daily-driver workspace (still preview-only on mock data, no backend writes). Grouped by impact.

## 1. Global app shell

- **Command palette inside /app**: extend the existing site `CommandPalette` with app-scoped actions (jump to Workbench tab, filter runs by status/kind, recheck API, copy install snippet, sign out). Bind `⌘K` / `Ctrl+K` inside the shell.
- **Keyboard shortcuts**: `g o` overview, `g w` workbench, `g r` runs, `g p` repos, `/` focus search on runs. Add a `?` overlay listing them (reuse `keyboard-shortcuts.tsx`).
- **Persistent header status**: replace the static "Signed · ready" pill with a live `StatusPill` driven by `useApiStatus` + connection. Click → opens a small popover with last-check timestamp and "Recheck now".
- **Breadcrumb with tab awareness**: when on `/app/workbench?tab=playground`, breadcrumb reads `App / Workbench / Playground` (read `tab` search param).
- **Sidebar polish**: pin/unpin favorite routes (localStorage), recent runs section under nav showing the last 3 viewed run IDs from URL history.

## 2. /app (Overview)

- **Customizable sparkline metrics**: let users pick which 3 of N analytics series to pin (localStorage). Add a small "Edit metrics" button.
- **Quick actions row**: small chips — "Run preflight", "Plan next work", "Open last run" — that deep-link into Workbench tabs or the most recent run drawer.
- **Recent activity strip**: last 5 runs with status dots, click to open in /app/runs with `selected=<id>` preserved.
- **What's new / changelog peek**: tiny card pulling top entry from `/changelog` data so returning users see deltas.
- **Onboarding checklist** (dismissible): "Install MCP", "Run `doctor`", "Open Workbench", "View a run" — persists dismissal in localStorage.

## 3. /app/runs

- **Saved filter views**: name + save the current `{status, kind, q}` combo to localStorage; surface as chips above the table ("My blocked", "Today's preflights").
- **Bulk + multi-select**: checkbox column, "Copy IDs", "Export JSON", "Mark reviewed" (local-only flag).
- **Column sort + density toggle**: sort by time/status/kind; compact vs comfortable density saved per user.
- **Detail drawer upgrades**: tabbed sections (Summary / Evidence / Raw JSON / Timeline), "Copy permalink", "Open in Workbench" deep-link, prev/next arrow keys cycle runs while drawer is open.
- **Time grouping**: group rows by Today / Yesterday / This week with sticky subheaders.
- **Live tail toggle**: when API is live, simulate streaming new mock runs every N seconds with a pause control; clearly badged "Live · mock".

## 4. /app/workbench

- **Tab state remembered per session**: last-used tab restored on revisit (already URL-driven — add localStorage fallback when no `?tab=`).
- **Split-view on wide screens**: at ≥1280px, show Miner panel alongside Playground for side-by-side planning + preflight.
- **Run-from-anywhere**: floating action button to re-run the last command from any tab.
- **Inline contextual help**: each panel header gets a `?` popover linking to the matching docs route (Quickstart, Miner workflow, etc.).

### Playground panel

- **History grouping & search** beyond what's there: filter by status/timeout/offline.
- **Variables/presets**: save common login/repo combos, switchable via dropdown.
- **Diff view** between two history entries.

## 5. /app/repos

- **Repo health grid**: cards per repo with install health dot, drift status, last sync, registration-readiness score.
- **Quick filter**: by maintainer-only, registered, drift-detected.
- **"Preview settings" sandbox** opens a side panel showing the recommended Gittensor config recommendation with copy-as-YAML.

## 6. /app/analytics

- **Date-range picker** (7d / 30d / 90d) — purely client-side filtering on mock series.
- **Comparison overlay**: previous period dashed line on each chart.
- **Export CSV/PNG** per chart.
- **Noise-reduction story**: dedicated section comparing "comments before" vs "comments after" with sparkline + percentage delta.

## 7. /app/operator

- **Drift incident timeline** with severity chips and one-click "Acknowledge" (local only).
- **Install health heatmap** by hour-of-day (mock).
- **Top noisy repos** table with quick-link to maintainer panel.

## 8. Cross-cutting polish

- **Empty/loading/error parity**: ensure every panel uses `StateBoundary` with `errorLabel` (some still render bespoke skeletons).
- **Toast inbox**: a small bell in the shell header collects recent toasts (errors, retries, copies) for 30 min.
- **Reduced-motion + dense-mode prefs** in a tiny "Preferences" popover.
- **Print/PDF stylesheet** so a run detail prints cleanly for sharing.
- **Accessibility sweep**: live regions on filter changes, `aria-current="page"` on sidebar links, focus return when drawer closes.

## Scope notes / out of scope

- All data remains local mock; no real API mutations.
- No new backend routes or `createServerFn` work.
- No design-system color changes; reuses existing tokens and the `.accent-*` / `focus-ring` / `hover-surface` utilities.
- Visual style stays current dark theme — no theme toggle reintroduced.

## Proposed sequencing (if approved)

1. Shell: command palette + shortcuts + live status pill + breadcrumb tab awareness.
2. Overview: pinned metrics, quick actions, recent activity.
3. Runs: saved views, detail drawer tabs, keyboard cycling, time grouping.
4. Workbench: per-panel help, playground presets/diff, split-view.
5. Repos / Analytics / Operator: feature additions above.
6. Cross-cutting: StateBoundary parity, toast inbox, print styles, a11y sweep.

Each step is independently shippable. Tell me which sections to build (all, or a subset) and I'll execute.
