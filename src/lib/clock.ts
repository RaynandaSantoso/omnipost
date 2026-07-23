// Lease expiry and backoff are product behaviour, not implementation
// detail, so time is a dependency rather than something read ambiently:
// tests advance it explicitly instead of waiting out a real backoff curve.
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};
