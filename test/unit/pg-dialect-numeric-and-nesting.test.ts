import { describe, expect, it } from "vitest";
import { translateSql } from "../../src/selfhost/pg-dialect";
import { translateInstr } from "../../src/selfhost/pg-dialect";

// #9084 verified live: `SELECT avg((metadata_json::jsonb ->> 'reviewEffortMinutes')) FROM audit_events` →
// ERROR: function avg(text) does not exist. json_extract translates to `->>`, which yields TEXT, so the
// enclosing AVG resolved to avg(text). Both call sites swallow the error, so the published "review effort /
// minutes saved" number was permanently zero on the Postgres self-host and nobody was told.
describe("numeric aggregation over json_extract survives translation (#9084)", () => {
  it("keeps an explicit numeric cast around the extracted text", () => {
    const translated = translateSql("SELECT AVG(CAST(NULLIF(json_extract(metadata_json, '$.reviewEffortMinutes'), '') AS REAL)) AS m FROM audit_events");
    expect(translated).toContain("->> 'reviewEffortMinutes'");
    // The cast has to survive, or AVG is handed text again.
    expect(translated).toContain("AS REAL");
    expect(translated).toContain("NULLIF");
  });
});

// #9084, same family: the previous regex stopped its haystack at the first comma, so a NESTED instr left the
// OUTER call untranslated — producing SQL that fails on Postgres with the exact "function instr does not exist"
// the rule exists to prevent, into a fail-safe read that swallows it to an empty result.
describe("instr translation handles nesting and literals (#9084)", () => {
  it("translates a nested call at every level", () => {
    expect(translateInstr("instr(substr(a, instr(a, '#') + 1), '#')")).toBe("strpos(substr(a, strpos(a, '#') + 1), '#')");
  });

  it("translates a plain call unchanged in meaning", () => {
    expect(translateInstr("instr(target_key, '#')")).toBe("strpos(target_key, '#')");
  });

  it("is not confused by a comma or a paren inside a string literal", () => {
    expect(translateInstr("instr(a, ',')")).toBe("strpos(a, ',')");
    expect(translateInstr("instr(a, '(')")).toBe("strpos(a, '(')");
  });

  it("leaves an identifier that merely ends in instr alone", () => {
    expect(translateInstr("myinstr(a, b)")).toBe("myinstr(a, b)");
    expect(translateInstr("t.instr(a, b)")).toBe("t.instr(a, b)");
  });

  it("passes malformed input through rather than mangling it — this is a translator, not a validator", () => {
    expect(translateInstr("instr(a")).toBe("instr(a");
    expect(translateInstr("instr(a)")).toBe("instr(a)");
  });

  it("handles several calls in one statement", () => {
    expect(translateInstr("SELECT instr(a, '#'), instr(b, '@') FROM t")).toBe("SELECT strpos(a, '#'), strpos(b, '@') FROM t");
  });
});

// #9084: target_key is not uniformly two-segment — regateRepairTargetKey mints `repo#pr#headSha`. On SQLite the
// INTEGER cast of `pr#sha` is lenient garbage; on Postgres it aborts the WHOLE query, so ONE three-segment row
// among the filtered event types took the entire public-stats read to [] and the homepage counters to zero.
describe("public-stats excludes multi-segment target keys before casting (#9084)", () => {
  it("counts separators with functions that need no dialect translation at all", () => {
    const predicate = "length(target_key) - length(replace(target_key, '#', '')) = 1";
    // If this ever needed translating, the guard would itself become the thing that breaks the query.
    expect(translateSql(`SELECT 1 FROM t WHERE ${predicate}`)).toContain(predicate);
  });
});
