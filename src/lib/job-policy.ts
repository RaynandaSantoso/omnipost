// Retry/lease policy, kept dependency-free so both the config schema (which
// is imported by the request proxy) and the job engine can share one source of
// truth for the defaults.
export interface JobPolicy {
  /** Attempt budget: a job is never claimed for an attempt beyond this. */
  maxAttempts: number;
  /** How long a claim stays valid without a heartbeat. */
  leaseMs: number;
  /** First-retry delay; doubles per attempt, capped at backoffMaxMs. */
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export const JOB_POLICY_DEFAULTS: JobPolicy = {
  maxAttempts: 5,
  leaseMs: 30_000,
  backoffBaseMs: 1_000,
  backoffMaxMs: 5 * 60_000,
};
