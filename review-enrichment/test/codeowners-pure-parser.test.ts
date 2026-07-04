// Units for the CODEOWNERS analyzer's pure glob/parser/ownership helpers (#2094). Own file (next to
// codeowners.test.ts, which covers the scanCodeowners async wiring) so concurrent analyzer PRs don't collide.
// No network involved — these four exports are deterministic. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  patternToRegex,
  parseCodeowners,
  findOwners,
  authorMatchesOwner,
} from "../dist/analyzers/codeowners.js";

test("patternToRegex: a leading slash anchors the pattern to the repo root", () => {
  const re = patternToRegex("/docs/readme.md");
  assert.equal(re.test("docs/readme.md"), true);
  assert.equal(re.test("packages/docs/readme.md"), false);
});

test("patternToRegex: a bare filename pattern is unanchored and matches at any depth", () => {
  const re = patternToRegex("*.md");
  assert.equal(re.test("readme.md"), true);
  assert.equal(re.test("docs/deep/readme.md"), true);
  // The `.` in the extension is a literal, not a regex wildcard.
  assert.equal(re.test("readmeXmd"), false);
});

test("patternToRegex: a trailing-slash directory pattern owns everything under the directory", () => {
  const re = patternToRegex("apps/");
  assert.equal(re.test("apps/web/index.ts"), true);
  assert.equal(re.test("apps/api/deep/nested/file.ts"), true);
  assert.equal(re.test("apps"), false); // the directory itself is not a file under it
});

test("patternToRegex: a single star stays within one path segment; a globstar crosses segments", () => {
  const single = patternToRegex("docs/*.md");
  assert.equal(single.test("docs/guide.md"), true);
  assert.equal(single.test("docs/sub/guide.md"), false);

  const globstar = patternToRegex("docs/**/*.md");
  assert.equal(globstar.test("docs/guide.md"), true);
  assert.equal(globstar.test("docs/sub/deep/guide.md"), true);
});

test("patternToRegex: literal segments match exactly, and ? matches exactly one non-slash character", () => {
  const literal = patternToRegex("/package.json");
  assert.equal(literal.test("package.json"), true);
  assert.equal(literal.test("packageXjson"), false);

  const question = patternToRegex("/file?.ts");
  assert.equal(question.test("file1.ts"), true);
  assert.equal(question.test("file.ts"), false);
  assert.equal(question.test("file/x.ts"), false);
});

test("parseCodeowners: skips comment lines and blank lines, keeping only real rules", () => {
  const rules = parseCodeowners("# top comment\n\n   \n*.js @alice\n# tail comment\n");
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].owners, ["@alice"]);
});

test("parseCodeowners: a rule keeps every owner listed after its pattern", () => {
  const rules = parseCodeowners("src/ @alice @org/team dev@example.com\n");
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].owners, ["@alice", "@org/team", "dev@example.com"]);
});

test("parseCodeowners: a malformed line (pattern with no valid owners) is skipped, not parsed", () => {
  // `bob` has no leading @ and is not an email — the pattern is unowned and must not produce a rule.
  const rules = parseCodeowners("src/ bob\ndocs/ @alice\n");
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].owners, ["@alice"]);
});

test("parseCodeowners: an overlong pattern is skipped rather than compiled", () => {
  const rules = parseCodeowners(`/${"a".repeat(600)} @alice\n*.ts @bob\n`);
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].owners, ["@bob"]);
});

test("findOwners: the LAST matching rule wins, per CODEOWNERS semantics", () => {
  const rules = parseCodeowners("* @global\ndocs/ @docs-team\n");
  assert.deepEqual(findOwners(rules, "docs/guide.md"), ["@docs-team"]);
  assert.deepEqual(findOwners(rules, "src/app.ts"), ["@global"]);

  // Reversed order: the broad rule now comes last and overrides the specific one.
  const reversed = parseCodeowners("docs/ @docs-team\n* @global\n");
  assert.deepEqual(findOwners(reversed, "docs/guide.md"), ["@global"]);
});

test("findOwners: a path matching no rule returns an empty owner list", () => {
  const rules = parseCodeowners("docs/ @docs-team\n");
  assert.deepEqual(findOwners(rules, "src/app.ts"), []);
  assert.deepEqual(findOwners([], "src/app.ts"), []);
});

test("authorMatchesOwner: matches a @user owner with or without the author's leading @, case-insensitively", () => {
  assert.equal(authorMatchesOwner("alice", ["@alice"]), true);
  assert.equal(authorMatchesOwner("@alice", ["@alice"]), true);
  assert.equal(authorMatchesOwner("Alice", ["@ALICE"]), true);
  assert.equal(authorMatchesOwner("carol", ["@alice", "@bob"]), false);
});

test("authorMatchesOwner: a user login does not match a @org/team owner", () => {
  assert.equal(authorMatchesOwner("team", ["@org/team"]), false);
  assert.equal(authorMatchesOwner("org/team", ["@org/team"]), true);
});
