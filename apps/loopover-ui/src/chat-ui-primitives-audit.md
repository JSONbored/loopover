# Chat-adjacent UI primitives audit (#6244)

Part of #6230 (chat interface spec — scope/backend/placement still open there). This is groundwork
only, per the issue's own scope: an inventory of what `apps/loopover-ui/src/components/**` and
`packages/loopover-ui-kit/src/components/**` already have that a future chat surface could reuse,
against the four primitives #6230 will eventually need. No code changes accompany this doc.

## What exists and is reusable as-is

- **Loading / empty / error scaffolding** — `apps/loopover-ui/src/components/site/state-views.tsx`
  exports `LoadingState`, `EmptyState`, `ErrorState`, and the composing `StateBoundary`, plus a bare
  `Spinner` (a `Loader2` icon with `animate-spin`, disabled under `motion-reduce`). These are already
  the app-wide convention for "is this panel loading/empty/erroring" and would drop straight into a
  chat panel's outer shell with no adaptation — see the note below on why `Spinner` is not itself a
  typing indicator.
- **Composer building blocks** — `packages/loopover-ui-kit/src/components/textarea.tsx` (a plain
  `forwardRef` wrapper around `<textarea>`, token-styled, no built-in submit handling) and
  `input.tsx`/`button.tsx` are the raw primitives a composer would be built from. They carry no
  keyboard-submit or auto-grow logic themselves — see "entirely absent" below.
- **Scrollable container** — `packages/loopover-ui-kit/src/components/scroll-area.tsx` wraps
  Radix's `ScrollArea` with the app's scrollbar styling. This is the direct building block for a
  scrollable message list's viewport; it renders whatever children are passed, so it doesn't imply
  message layout on its own.
- **Avatars** — `packages/loopover-ui-kit/src/components/avatar.tsx` (Radix `Avatar` wrapper,
  image + fallback) is reusable as-is for per-message sender avatars.

## What's close but would need adaptation

- **`apps/loopover-ui/src/components/site/audit-feed.tsx`** (`AuditFeed`) is structurally the
  closest existing analog to a filtered, live-data timeline: it owns filter state
  (`reason`/`repoFullName`/`sinceIso`/`limit`), fetches and re-fetches on filter change, and renders
  through the same `EmptyState`/`ErrorState`/`LoadingState` scaffolding above. But it renders results
  as an HTML `<table>` with fixed columns (Time / Repository / Pull request / Reason / Remediation),
  not a bubble/timeline list — reusing it for chat would mean keeping its data-fetching and state
  shell but replacing the `<table>` row renderer with a per-message component (sender, bubble,
  timestamp), which is effectively a rewrite of the view layer, not a prop change.
- **`apps/loopover-ui/src/components/site/command-palette.tsx`** (`CommandPalette`) has the only
  bare `<input>` + live-filtered scrollable `<ul>` combination in the app (⌘K-triggered, `Escape`
  closes it, results navigate on click). It's close to "text input driving a list," but it is a
  *search-and-navigate* palette, not a composer: there's no `onKeyDown` handling for `Enter` at all
  (results are selected by click, not by keyboard submit), no multi-line/auto-grow textarea, and no
  concept of "submit this text as a message." A submit-on-Enter composer would need to be built new,
  informed by this file's open/close and keyboard-listener patterns rather than by reusing its input.
- **`apps/loopover-ui/src/components/site/animated-terminal.tsx`** (`AnimatedTerminal`) is the
  closest existing "reveal text incrementally" precedent: a `setInterval`-driven character-by-character
  typewriter over `scene.prompt`, a `motion.pre` fade-in reveal for `scene.output` via
  `AnimatePresence`, and a `useReducedMotion()` escape hatch that skips the animation outright. The
  reveal mechanics (interval-driven character reveal, reduced-motion handling) are a reasonable
  starting point for a streaming-text renderer, but the data source is a hardcoded
  `DEFAULT_SCENES: TerminalScene[]` array timed by a fixed `HOLD` duration — there is no chunked
  input, no cancellation on new input arriving mid-type, and no backpressure handling. Adapting it to
  real streaming would mean replacing the `setInterval` scene-walk with a consumer of whatever chunk
  source #6230 picks (see below), while keeping the reduced-motion and fade-in-reveal behavior.

## What's entirely absent

- **A submit-on-Enter composer.** No component anywhere in `apps/loopover-ui/src/components/**` or
  `packages/loopover-ui-kit/src/components/**` wires a textarea to `Enter`-to-submit /
  `Shift+Enter`-for-newline, and none auto-grow. `textarea.tsx` is unstyled-behavior raw material
  only.
- **A live streaming-text consumer.** Grepping `apps/loopover-ui/src` for
  `EventSource|ReadableStream|text/event-stream|streaming` returns exactly one hit outside this
  audit: a comment in `apps/loopover-ui/src/lib/analytics-proxy.ts` explaining that the analytics
  proxy buffers its (tiny) request body specifically so it does *not* need a streaming/duplex
  request — i.e. the one file that mentions "streaming" is explicitly the case of avoiding it. There
  is no code anywhere in the app that consumes an `EventSource`, a `fetch` response's `ReadableStream`
  body, or a `text/event-stream` response today. `animated-terminal.tsx` (above) is the closest
  *rendering* precedent, but it has no real stream to consume from.
- **A chat-bubble / message-list component.** Nothing pairs an avatar, a role-colored bubble, and a
  timestamp into a reusable per-message unit. `audit-feed.tsx`'s table rows are the nearest list
  pattern, but as noted above they're tabular, not conversational.
- **A typing / "in progress" indicator.** `state-views.tsx`'s `Spinner`/`LoadingState` communicate
  "this whole panel is loading," not "the other side is composing a response inline in the
  conversation." There is no dot-pulse, no inline avatar-with-ellipsis, nor any other
  chat-specific in-progress affordance anywhere in the codebase.

## Summary for #6230's eventual scoping

The reusable pieces (`state-views.tsx`'s state scaffolding, `scroll-area.tsx`, `avatar.tsx`,
`textarea.tsx`/`input.tsx`/`button.tsx` as raw material) cover the outer shell and building blocks,
not the chat-specific behavior. The four primitives #6230 will need — message list, composer,
streaming renderer, typing indicator — are each either absent or only structurally adjacent
(`audit-feed.tsx` for the list, `command-palette.tsx` for the input, `animated-terminal.tsx` for the
renderer), so whoever implements #6230 should plan to build all four from scratch, informed by these
adjacent patterns rather than assuming any can be reused directly.
