import { describe, expect, it } from "vitest";
import { verifyPassword } from "@/lib/access-gate";

describe("verifyPassword", () => {
  it("accepts the correct password", () => {
    expect(verifyPassword("correct horse", "correct horse")).toBe(true);
  });

  it("rejects an incorrect password", () => {
    expect(verifyPassword("wrong", "correct horse")).toBe(false);
  });

  it("rejects without throwing when lengths differ", () => {
    expect(verifyPassword("x", "a much longer configured password")).toBe(false);
    expect(verifyPassword("a much longer candidate password", "x")).toBe(false);
  });

  it("rejects an empty candidate against a real password", () => {
    expect(verifyPassword("", "correct horse")).toBe(false);
  });
});
