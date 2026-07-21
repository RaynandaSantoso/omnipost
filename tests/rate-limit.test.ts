import { beforeEach, describe, expect, it } from "vitest";
import {
  checkRateLimit,
  recordFailure,
  recordSuccess,
  resetRateLimitState,
} from "@/lib/rate-limit";

describe("rate limiting", () => {
  beforeEach(() => {
    resetRateLimitState();
  });

  it("allows the first attempt", () => {
    expect(checkRateLimit("1.2.3.4").allowed).toBe(true);
  });

  it("blocks immediately after a failure, honouring the backoff window", () => {
    const now = Date.now();
    recordFailure("1.2.3.4", now);

    expect(checkRateLimit("1.2.3.4", now).allowed).toBe(false);
    expect(checkRateLimit("1.2.3.4", now + 999).allowed).toBe(false);
    expect(checkRateLimit("1.2.3.4", now + 1001).allowed).toBe(true);
  });

  it("grows the backoff with repeated failures", () => {
    const now = Date.now();
    recordFailure("1.2.3.4", now); // -> 1s
    recordFailure("1.2.3.4", now); // -> 2s
    recordFailure("1.2.3.4", now); // -> 4s

    expect(checkRateLimit("1.2.3.4", now + 3000).allowed).toBe(false);
    expect(checkRateLimit("1.2.3.4", now + 4001).allowed).toBe(true);
  });

  it("caps the backoff instead of growing unboundedly", () => {
    const now = Date.now();
    for (let i = 0; i < 10; i += 1) {
      recordFailure("1.2.3.4", now);
    }

    expect(checkRateLimit("1.2.3.4", now + 59_000).allowed).toBe(false);
    expect(checkRateLimit("1.2.3.4", now + 60_001).allowed).toBe(true);
  });

  it("resets backoff on success", () => {
    const now = Date.now();
    recordFailure("1.2.3.4", now);
    recordSuccess("1.2.3.4");

    expect(checkRateLimit("1.2.3.4", now).allowed).toBe(true);
  });

  it("tracks failures independently per key", () => {
    const now = Date.now();
    recordFailure("1.2.3.4", now);

    expect(checkRateLimit("1.2.3.4", now).allowed).toBe(false);
    expect(checkRateLimit("5.6.7.8", now).allowed).toBe(true);
  });
});
