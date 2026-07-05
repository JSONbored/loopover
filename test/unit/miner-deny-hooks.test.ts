import { describe, expect, it } from "vitest";
import {
  DEFAULT_DENY_RULES,
  evaluateDenyHooks,
} from "../../packages/gittensory-miner/lib/deny-hooks.js";

// PreToolUse-style deny-hook primitives (#2295). Pure decision function — no live interception. Each built-in
// rule is checked on BOTH sides (fires on a crafted matching call, does NOT fire on a benign one), plus the
// empty-rule-set / no-match allow paths and the matcher/pathPattern/inputIncludesAll composition.

describe("evaluateDenyHooks — built-in DEFAULT_DENY_RULES", () => {
  it("has a non-empty default rule set (the safety primitive exists and is wired at least this far)", () => {
    expect(DEFAULT_DENY_RULES.length).toBeGreaterThan(0);
  });

  it("blocks writing a CI workflow, including relative, nested, and Windows-style variants", () => {
    const blocked = evaluateDenyHooks({ name: "Write", input: { file_path: ".github/workflows/ci.yml" } });
    expect(blocked.allowed).toBe(false);
    expect(blocked.blockedBy?.reason).toContain("CI workflows");
    expect(evaluateDenyHooks({ name: "Write", input: { file_path: "./.github/workflows/ci.yml" } }).allowed).toBe(false);
    expect(evaluateDenyHooks({ name: "Write", input: { file_path: "foo/.github/workflows/ci.yml" } }).allowed).toBe(false);
    expect(evaluateDenyHooks({ name: "Write", input: { file_path: ".github\\workflows\\ci.yml" } }).allowed).toBe(false);
    expect(evaluateDenyHooks({ name: "Write", input: { file_path: "src/review/rag.ts" } }).allowed).toBe(true);
  });

  it("blocks env and credential files case-insensitively, allows a normal config file", () => {
    expect(evaluateDenyHooks({ name: "Read", input: { file_path: ".env" } }).allowed).toBe(false);
    expect(evaluateDenyHooks({ name: "Read", input: { file_path: "app/.env.local" } }).allowed).toBe(false);
    expect(evaluateDenyHooks({ name: "Read", input: { file_path: ".ENV" } }).allowed).toBe(false);
    expect(evaluateDenyHooks({ name: "Read", input: { file_path: ".dev.vars" } }).allowed).toBe(false);
    expect(evaluateDenyHooks({ name: "Read", input: { file_path: ".npmrc" } }).allowed).toBe(false);
    expect(evaluateDenyHooks({ name: "Read", input: { file_path: "app/config.ts" } }).allowed).toBe(true);
  });

  it("blocks secret-bearing paths and filenames, allows an unrelated directory", () => {
    expect(evaluateDenyHooks({ name: "Read", input: { file_path: "config/secrets/prod.json" } }).allowed).toBe(false);
    expect(evaluateDenyHooks({ name: "Read", input: { file_path: "config/secret.json" } }).allowed).toBe(false);
    expect(evaluateDenyHooks({ name: "Read", input: { file_path: "config/public/prod.json" } }).allowed).toBe(true);
  });

  it("blocks private key and PEM material case-insensitively, allows a lookalike that is not a key", () => {
    expect(evaluateDenyHooks({ name: "Read", input: { file_path: "keys/id_private_key.pem" } }).allowed).toBe(false);
    expect(evaluateDenyHooks({ name: "Read", input: { file_path: "keys/id_PRIVATE_KEY.pem" } }).allowed).toBe(false);
    expect(evaluateDenyHooks({ name: "Read", input: { file_path: "certs/client.pem" } }).allowed).toBe(false);
    expect(evaluateDenyHooks({ name: "Read", input: { file_path: "docs/public-notes.md" } }).allowed).toBe(true);
  });

  it("blocks a protected path EMBEDDED in a command string (tokenizes; no pre-split path field required)", () => {
    // A command carrying a protected path as one argument must be caught, not just a bare path-valued field.
    expect(evaluateDenyHooks({ name: "Bash", input: { command: "git add .github/workflows/ci.yml && git commit" } }).allowed).toBe(false);
    expect(evaluateDenyHooks({ name: "Bash", input: { command: "git add ./.github/workflows/ci.yml && git commit" } }).allowed).toBe(false);
    expect(evaluateDenyHooks({ name: "Bash", input: { command: "cat config/secrets/prod.json" } }).allowed).toBe(false);
    // A benign command carrying no protected token still passes.
    expect(evaluateDenyHooks({ name: "Bash", input: { command: "git status --short" } }).allowed).toBe(true);
  });

  it("blocks a git force-push regardless of flag/subcommand order, allows a normal push", () => {
    expect(evaluateDenyHooks({ name: "Bash", input: { command: "git push --force origin main" } }).allowed).toBe(false);
    // Order-independent: both substrings present in either order.
    expect(evaluateDenyHooks({ name: "Bash", input: { command: "git --force-with-lease push" } }).allowed).toBe(false);
    expect(evaluateDenyHooks({ name: "Bash", input: { command: "git push origin main" } }).allowed).toBe(true);
    expect(evaluateDenyHooks({ name: "Bash", input: { command: "git commit --amend" } }).allowed).toBe(true);
  });

  it("blocks the short -f force-push flag (bare or bundled) without false-flagging --follow-tags", () => {
    expect(evaluateDenyHooks({ name: "Bash", input: { command: "git push -f origin main" } }).allowed).toBe(false);
    expect(evaluateDenyHooks({ name: "Bash", input: { command: "git push -uf origin main" } }).allowed).toBe(false);
    // --follow-tags contains "-f" as a substring but is not a force flag — must not be blocked.
    expect(evaluateDenyHooks({ name: "Bash", input: { command: "git push --follow-tags origin main" } }).allowed).toBe(true);
  });
});

describe("evaluateDenyHooks — rule composition and allow paths", () => {
  it("an empty rule set always allows", () => {
    expect(evaluateDenyHooks({ name: "Bash", input: { command: "rm -rf /" } }, []).allowed).toBe(true);
  });

  it("a call matching zero rules is allowed", () => {
    const rules = [{ matcher: "Write", pathPattern: "dist/**", reason: "no dist edits" }];
    expect(evaluateDenyHooks({ name: "Read", input: { file_path: "src/a.ts" } }, rules).allowed).toBe(true);
  });

  it("respects the tool-name matcher: an exact matcher only fires for that tool", () => {
    const rules = [{ matcher: "Write", pathPattern: "**/*.lock", reason: "no lockfile writes" }];
    expect(evaluateDenyHooks({ name: "Write", input: { file_path: "pnpm.lock" } }, rules).allowed).toBe(false);
    // Same path, different tool → matcher does not match → allowed.
    expect(evaluateDenyHooks({ name: "Read", input: { file_path: "pnpm.lock" } }, rules).allowed).toBe(true);
  });

  it("a matcher-only rule (no pathPattern/inputIncludesAll) fires on the tool name alone", () => {
    const rules = [{ matcher: "Delete", reason: "deletes are never allowed" }];
    const verdict = evaluateDenyHooks({ name: "Delete", input: {} }, rules);
    expect(verdict.allowed).toBe(false);
    expect(verdict.blockedBy?.reason).toBe("deletes are never allowed");
  });

  it("matches pathPattern against a path-shaped array field", () => {
    const rules = [{ matcher: "*", pathPattern: ".github/workflows/**", reason: "no workflows" }];
    expect(evaluateDenyHooks({ name: "MultiEdit", input: { paths: ["README.md", ".github/workflows/x.yml"] } }, rules).allowed).toBe(false);
    expect(evaluateDenyHooks({ name: "MultiEdit", input: { paths: ["README.md", "src/x.ts"] } }, rules).allowed).toBe(true);
  });

  it("defaults to the built-in rule set when no rules argument is passed", () => {
    expect(evaluateDenyHooks({ name: "Write", input: { file_path: ".github/workflows/ci.yml" } }).allowed).toBe(false);
  });

  it("recursively inspects nested input strings without throwing on missing input", () => {
    expect(evaluateDenyHooks({ name: "Bash", input: {} }).allowed).toBe(true);
    expect(evaluateDenyHooks({ name: "Read", input: { request: { file_path: ".env" } } }).allowed).toBe(false);
    expect(evaluateDenyHooks({ name: "Read", input: { count: 3, nested: { file: "src/x.ts" } } }).allowed).toBe(true);
  });
});
