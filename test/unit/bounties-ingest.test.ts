import { describe, expect, it } from "vitest";

import { normalizeGittBountySnapshot } from "../../src/bounties/ingest";

// #9313: normalizeGittBountySnapshot parses an UNTRUSTED Gitt payload (`unknown`), so its declared field types
// don't hold at runtime. These pin the typed value guards: a wrong-typed required field drops the whole record
// rather than being trusted into a mistyped BountyRecord, and a wrong-typed/non-finite amount degrades to
// undefined without dropping the record.
const validIssue: Record<string, unknown> = {
  id: 42,
  repository_full_name: "owner/repo",
  issue_number: 7,
  status: "open",
  bounty_amount: 5,
};
const snap = (issue: Record<string, unknown>) => normalizeGittBountySnapshot({ issues: [issue] });

describe("normalizeGittBountySnapshot type guards (#9313)", () => {
  it.each([
    ["id neither string nor number", { id: {} }],
    ["repoFullName not a string", { repository_full_name: 5 }],
    ["repoFullName empty", { repository_full_name: "" }],
    ["issueNumber not a number", { issue_number: "7" }],
    ["issueNumber non-finite (NaN)", { issue_number: Number.NaN }],
    ["status not a string", { status: 5 }],
    ["status empty", { status: "" }],
  ])("drops a record whose required field is wrong-typed: %s", (_label, override) => {
    expect(snap({ ...validIssue, ...override })).toEqual([]);
  });

  it("keeps a well-typed record (string id) and takes amountText from bounty_alpha", () => {
    const [record] = snap({ ...validIssue, id: "abc-1", bounty_alpha: "1 alpha", bounty_amount: undefined });
    expect(record).toMatchObject({
      id: "abc-1",
      repoFullName: "owner/repo",
      issueNumber: 7,
      status: "open",
      amountText: "1 alpha",
    });
  });

  it("keeps a well-typed record (numeric id) and stringifies a finite bounty_amount when no bounty_alpha", () => {
    const [record] = snap({ ...validIssue, id: 42, bounty_alpha: undefined, bounty_amount: 5 });
    expect(record).toMatchObject({ id: "42", issueNumber: 7, amountText: "5" });
  });

  it("degrades a non-finite or absent amount to undefined without dropping the record", () => {
    const infinite = snap({ ...validIssue, bounty_alpha: undefined, bounty_amount: Number.POSITIVE_INFINITY });
    expect(infinite).toHaveLength(1);
    expect(infinite[0]?.amountText).toBeUndefined();
    const absent = snap({ ...validIssue, bounty_alpha: undefined, bounty_amount: undefined });
    expect(absent).toHaveLength(1);
    expect(absent[0]?.amountText).toBeUndefined();
  });

  it("returns [] for a null/malformed payload (unchanged fail-safe)", () => {
    expect(normalizeGittBountySnapshot(null)).toEqual([]);
    expect(normalizeGittBountySnapshot({})).toEqual([]);
  });
});
