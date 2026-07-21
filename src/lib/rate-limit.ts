const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 60_000;

interface LimiterState {
  failures: number;
  blockedUntil: number;
}

// Reused across hot reloads in dev, same rationale as the Prisma singleton
// in db.ts: a fresh Map on every module reload would silently reset
// everyone's backoff.
const globalForRateLimit = globalThis as unknown as {
  loginAttempts?: Map<string, LimiterState>;
};

const attempts = globalForRateLimit.loginAttempts ?? new Map<string, LimiterState>();
if (process.env.NODE_ENV !== "production") {
  globalForRateLimit.loginAttempts = attempts;
}

function backoffFor(failures: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** (failures - 1), MAX_DELAY_MS);
}

export function checkRateLimit(
  key: string,
  now: number = Date.now(),
): { allowed: boolean; retryAfterMs: number } {
  const state = attempts.get(key);
  if (!state || state.blockedUntil <= now) {
    return { allowed: true, retryAfterMs: 0 };
  }
  return { allowed: false, retryAfterMs: state.blockedUntil - now };
}

export function recordFailure(key: string, now: number = Date.now()): void {
  const state = attempts.get(key) ?? { failures: 0, blockedUntil: 0 };
  state.failures += 1;
  state.blockedUntil = now + backoffFor(state.failures);
  attempts.set(key, state);
}

export function recordSuccess(key: string): void {
  attempts.delete(key);
}

// Test-only: isolate rate-limit state between test cases.
export function resetRateLimitState(): void {
  attempts.clear();
}
