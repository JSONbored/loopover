# Changelog

## 0.1.0

Initial release. `@loopover/contract` is the single zod source of truth for LoopOver's MCP tool and API
contracts — the schemas, tool metadata, and derived projections every server and client reads.

It is published because it is a **runtime** dependency of `@loopover/mcp` and `@loopover/miner`, which
import it from code that ships (#9749). It must be published *before* any release of those packages that
depends on a new version of it.
