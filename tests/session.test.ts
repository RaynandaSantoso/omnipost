import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSessionToken,
  isHttps,
  resetPlaintextWarning,
  SESSION_MAX_AGE_MS,
  verifySessionToken,
  warnIfPlaintext,
} from "@/lib/session";

describe("session tokens", () => {
  it("accepts a freshly issued token", () => {
    const now = Date.now();
    const token = createSessionToken("shared-password", now);
    expect(verifySessionToken(token, "shared-password", now)).toBe(true);
  });

  it("stays valid just before the 30-day sliding window elapses", () => {
    const now = Date.now();
    const token = createSessionToken("shared-password", now);
    expect(
      verifySessionToken(token, "shared-password", now + SESSION_MAX_AGE_MS - 1),
    ).toBe(true);
  });

  it("expires once the sliding window elapses", () => {
    const now = Date.now();
    const token = createSessionToken("shared-password", now);
    expect(
      verifySessionToken(token, "shared-password", now + SESSION_MAX_AGE_MS + 1),
    ).toBe(false);
  });

  it("rejects a token signed with a different password", () => {
    const now = Date.now();
    const token = createSessionToken("shared-password", now);
    expect(verifySessionToken(token, "a different password", now)).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const now = Date.now();
    const token = createSessionToken("shared-password", now);
    const [expiresAt] = token.split(".");
    const tampered = `${expiresAt}.${"0".repeat(64)}`;
    expect(verifySessionToken(tampered, "shared-password", now)).toBe(false);
  });

  it("rejects a malformed token", () => {
    expect(verifySessionToken("not-a-real-token", "shared-password")).toBe(false);
    expect(verifySessionToken("", "shared-password")).toBe(false);
  });
});

describe("isHttps", () => {
  it("is true for an https:// URL", () => {
    expect(isHttps(new Request("https://example.com/"))).toBe(true);
  });

  it("is true for plain http when X-Forwarded-Proto says https", () => {
    const request = new Request("http://example.com/", {
      headers: { "x-forwarded-proto": "https" },
    });
    expect(isHttps(request)).toBe(true);
  });

  it("is false for plain http with no forwarded-proto header", () => {
    expect(isHttps(new Request("http://example.com/"))).toBe(false);
  });
});

describe("warnIfPlaintext", () => {
  beforeEach(() => {
    resetPlaintextWarning();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs a warning for a plaintext request", () => {
    warnIfPlaintext(new Request("http://example.com/"));
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("does not log for an https request", () => {
    warnIfPlaintext(new Request("https://example.com/"));
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("only logs once per process even across repeated plaintext requests", () => {
    warnIfPlaintext(new Request("http://example.com/"));
    warnIfPlaintext(new Request("http://example.com/"));
    warnIfPlaintext(new Request("http://example.com/"));
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});
