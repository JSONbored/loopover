# @loopover/ui-kit

Shared design-system tokens and component primitives for `apps/loopover-ui` and `apps/loopover-miner-ui`.

This package houses the Radix-based component library both apps build on, so the same design tokens,
component behavior, and accessibility conventions stay identical across the two frontends instead of
drifting apart. It is versioned independently and published to npm as `@loopover/ui-kit`.

## Install

```
npm install @loopover/ui-kit
```

`react` and `react-dom` (`^19.2.7`) are peer dependencies — the consuming app supplies its own copy.

## Usage

Each component is its own subpath export, so a consumer only pulls in the components it actually
imports rather than the whole library:

```ts
import { Button } from "@loopover/ui-kit/components/button";
import { useIsMobile } from "@loopover/ui-kit/hooks/use-mobile";
import { cn } from "@loopover/ui-kit/utils";
import "@loopover/ui-kit/theme.css";
```

`theme.css` ships as source (not compiled) so a consumer's own Tailwind/PostCSS pipeline processes it
alongside the rest of the app's styles.

## Components

`accordion`, `alert`, `alert-dialog`, `aspect-ratio`, `avatar`, `badge`, `breadcrumb`, `button`,
`calendar`, `card`, `carousel`, `chart`, `checkbox`, `collapsible`, `command`, `context-menu`, `dialog`,
`drawer`, `dropdown-menu`, `form`, `hover-card`, `input`, `input-otp`, `label`, `menubar`,
`navigation-menu`, `pagination`, `popover`, `progress`, `radio-group`, `resizable`, `scroll-area`,
`select`, `separator`, `sheet`, `sidebar`, `skeleton`, `slider`, `sonner`, `state-views`, `switch`,
`table`, `tabs`, `textarea`, `toggle`, `toggle-group`, `tooltip`.

Plus one hook (`hooks/use-mobile`) and shared utilities (`utils`, notably `cn` for Tailwind class merging).

## Build

```
npm run build --workspace @loopover/ui-kit
```

Runs `tsc -p tsconfig.json`, emitting `dist/` (the only published output alongside `CHANGELOG.md` and
`src/theme.css`).

## Test

```
npm test --workspace @loopover/ui-kit
```

Runs the package's own `vitest` suite (jsdom) against the component source.
