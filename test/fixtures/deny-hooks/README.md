# Deny-hook fixture corpus (#2296)

A table-driven corpus that stress-tests the deny-hook primitive
(`packages/gittensory-miner/lib/deny-hooks.js`'s `evaluateDenyHooks`) against realistic tool-call
shapes a future coding-agent driver will produce — file writes, shell/git commands, multi-path edits
— beyond the hand-rolled examples in that module's own unit tests. It is driven by
`test/unit/deny-hooks-fixtures.test.ts`.

## Fixture format

Each entry in `cases.ts` (`DenyHookFixture`) is:

```ts
{
  name: string,                       // human-readable case label (shown per-test)
  toolCall: { name, input },          // the proposed tool call to evaluate
  rules?: DenyRule[],                 // optional; omitted → the built-in DEFAULT_DENY_RULES
  expected: {
    allowed: boolean,                 // the verdict evaluateDenyHooks must return
    blockedByIncludes?: string,       // when blocked, a substring the matched rule's `reason` must contain
  },
}
```

The test asserts `evaluateDenyHooks(toolCall, rules).allowed === expected.allowed` for every case, and
— for blocked cases — that the matched rule's `reason` contains `blockedByIncludes`.

## Coverage

Every built-in default rule is exercised on both sides (a matching call that IS blocked and a
clearly-benign call that is NOT), plus:

- **glob edge cases** — a path that superficially resembles a blocked pattern but isn't
  (`src/environment.ts` vs `.env`) and a path blocked via a less-obvious match (`secretstore/` via the
  `secret*` prefix);
- **command-embedded paths** — a protected path passed as a shell argument (tokenized, not a bare path
  field);
- **order-independent content matching** — the git force-push guard triggering regardless of flag order;
- **custom rules** — an empty rule set (allows everything) and a scoped exact-tool matcher.

## Extending

When a later phase adds a new default rule to `DEFAULT_DENY_RULES`, add fixtures here covering both a
matching (blocked) call and a clearly-benign (allowed) call for it, so the corpus keeps the matcher
honest before any real driver is plugged in.
