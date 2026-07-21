import { describe, expect, it } from "vitest";

import { preserveExistingObjectOrder } from "../../scripts/write-ui-openapi";

// #7770: direct unit tests for the OpenAPI key-ordering helper, which only had indirect coverage before.
describe("preserveExistingObjectOrder (#7770)", () => {
  it("reorders a nested object's keys to match the current file's order", () => {
    const next = { b: 1, a: { y: 2, x: 3 }, c: 4 };
    const current = { a: { x: 0, y: 0 }, b: 0 };
    const result = preserveExistingObjectOrder(next, current);
    // Top level: current's a, b first; c (new-only) appended.
    expect(Object.keys(result)).toEqual(["a", "b", "c"]);
    // Nested object is reordered to current's x, y with next's values.
    expect(Object.keys(result.a)).toEqual(["x", "y"]);
    expect(result).toEqual({ a: { x: 3, y: 2 }, b: 1, c: 4 });
  });

  it("appends keys present in next but not current, in next's own order", () => {
    const result = preserveExistingObjectOrder({ first: 1, second: 2, third: 3 }, { second: 0 });
    expect(Object.keys(result)).toEqual(["second", "first", "third"]);
  });

  it("drops keys present in current but not in next (only next's keys survive)", () => {
    const result = preserveExistingObjectOrder({ a: 1 }, { a: 0, removed: 0 });
    expect(result).toEqual({ a: 1 });
    expect("removed" in result).toBe(false);
  });

  it("walks array-valued keys positionally, aligning each item with the current array", () => {
    const next = {
      list: [
        { b: 1, a: 2 },
        { d: 3, c: 4 },
      ],
    };
    // Shorter current array: index 1 has no counterpart, so it stays in next's own order.
    const current = { list: [{ a: 0, b: 0 }] };
    const result = preserveExistingObjectOrder(next, current);
    expect(Object.keys(result.list[0]!)).toEqual(["a", "b"]);
    expect(result.list[1]).toEqual({ d: 3, c: 4 });
    expect(result.list).toHaveLength(2);
  });

  it("passes primitive, null, and undefined leaf values through unchanged", () => {
    expect(preserveExistingObjectOrder(5, { a: 1 })).toBe(5);
    expect(preserveExistingObjectOrder("s", undefined)).toBe("s");
    expect(preserveExistingObjectOrder(null, { a: 1 })).toBe(null);
    // An undefined-valued key is retained as a key (with undefined value), ordered by current.
    const result = preserveExistingObjectOrder({ b: undefined, a: 1 }, { a: 0, b: 0 });
    expect(Object.keys(result)).toEqual(["a", "b"]);
    expect(result.b).toBeUndefined();
  });

  it("treats a current value of the wrong shape as empty, keeping next's own order", () => {
    // next is an object but current is an array -> currentObject falls back to {}, so next's order wins.
    const objVsArr = preserveExistingObjectOrder({ z: 1, a: 2 }, [1, 2, 3]);
    expect(Object.keys(objVsArr)).toEqual(["z", "a"]);
    // next is an array but current is an object -> each current[index] is undefined.
    const arrVsObj = preserveExistingObjectOrder([{ b: 1, a: 2 }], { not: "an-array" });
    expect(Object.keys(arrVsObj[0]!)).toEqual(["b", "a"]);
  });
});
