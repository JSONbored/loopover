import { describe, it, expect } from "vitest";
import { parsePositiveInt } from "../../src/utils/json";

describe("parsePositiveInt", () => {
  it("returns null for null input", () => {
    expect(parsePositiveInt(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(parsePositiveInt(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parsePositiveInt("")).toBeNull();
  });

  it("returns null for malformed strings with non-numeric characters", () => {
    expect(parsePositiveInt("123abc")).toBeNull();
    expect(parsePositiveInt("abc123")).toBeNull();
    expect(parsePositiveInt("12.34")).toBeNull();
    expect(parsePositiveInt("-123")).toBeNull();
    expect(parsePositiveInt("0")).toBeNull();
    expect(parsePositiveInt(" 123")).toBeNull();
    expect(parsePositiveInt("123 ")).toBeNull();
  });

  it("returns null for zero", () => {
    expect(parsePositiveInt("0")).toBeNull();
  });

  it("returns null for negative numbers", () => {
    expect(parsePositiveInt("-1")).toBeNull();
    expect(parsePositiveInt("-100")).toBeNull();
  });

  it("returns the parsed number for valid positive integers", () => {
    expect(parsePositiveInt("1")).toBe(1);
    expect(parsePositiveInt("123")).toBe(123);
    expect(parsePositiveInt("999999")).toBe(999999);
  });

  it("rejects strings that would partially parse to valid numbers", () => {
    // This is the key fix: before the regex validation, parseInt("123abc") would return 123
    // After the fix, it should return null
    expect(parsePositiveInt("123abc")).toBeNull();
    expect(parsePositiveInt("456def")).toBeNull();
    expect(parsePositiveInt("789xyz")).toBeNull();
  });

  it("rejects strings with special characters", () => {
    expect(parsePositiveInt("123!")).toBeNull();
    expect(parsePositiveInt("$123")).toBeNull();
    expect(parsePositiveInt("123@")).toBeNull();
  });
});
