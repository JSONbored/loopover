import { describe, expect, it } from "vitest";
import { __securityInternals } from "../../src/auth/security";

describe("security internals", () => {
  it("serializes cookies with optional HttpOnly and Secure flags", () => {
    const minimal = __securityInternals.serializeCookie("a", "b", {
      maxAge: 10,
      path: "/",
      httpOnly: false,
      sameSite: "Lax",
      secure: false,
    });
    expect(minimal).toContain("a=b");
    expect(minimal).not.toContain("HttpOnly");
    expect(minimal).not.toContain("Secure");

    const strict = __securityInternals.serializeCookie("a", "b", {
      maxAge: 10,
      path: "/",
      httpOnly: true,
      sameSite: "Strict",
      secure: true,
    });
    expect(strict).toContain("HttpOnly");
    expect(strict).toContain("Secure");
    expect(strict).toContain("SameSite=Strict");
  });
});
