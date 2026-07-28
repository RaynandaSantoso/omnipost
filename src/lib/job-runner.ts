import { getConfig } from "@/lib/config";
import { createJobEngine, type JobEngine } from "@/lib/job-engine";
import { logError } from "@/lib/log";

// Process-level lifecycle around the job engine: one engine per server
// instance, ticked on an interval. All the durability behaviour (leases,
// heartbeats, backoff, recovery) lives in the engine — this module only
// decides when it runs.

// Reused across hot reloads in dev, same rationale as the Prisma singleton
// in db.ts: a fresh reference on every module reload would leak a second
// interval running against the old module instance, and — worse here — a
// second worker identity holding leases nobody releases.
const globalForJobRunner = globalThis as unknown as {
  jobRunnerInterval?: ReturnType<typeof setInterval>;
  jobEngine?: JobEngine;
};

export function getJobEngine(): JobEngine {
  if (!globalForJobRunner.jobEngine) {
    const config = getConfig();
    globalForJobRunner.jobEngine = createJobEngine({
      maxAttempts: config.JOB_MAX_ATTEMPTS,
      leaseMs: config.JOB_LEASE_MS,
      backoffBaseMs: config.JOB_BACKOFF_BASE_MS,
      backoffMaxMs: config.JOB_BACKOFF_MAX_MS,
    });
  }
  return globalForJobRunner.jobEngine;
}

export async function processPendingJobs(): Promise<void> {
  await getJobEngine().tick();
}

// Boot-time sweep: a job left "uploading" by a crash or a kill -9 holds a
// lease nobody will renew, so it is reclaimed (or retired, if its budget is
// spent) before this instance starts serving.
export async function recoverStalledJobs(): Promise<void> {
  await getJobEngine().recoverStalledJobs();
}

// Graceful drain: let in-flight work finish, then hand back what this
// worker holds so a deploy leaves no job waiting out a full lease before
// anyone can pick it up again.
export async function drainJobs(graceMs?: number): Promise<void> {
  await getJobEngine().drain(graceMs);
}

export function startJobRunner(intervalMs = 1000): void {
  if (globalForJobRunner.jobRunnerInterval) {
    return;
  }
  // Ticks must not overlap: a second tick entering while the first is still
  // uploading would find nothing to do at best, and at worst race its own
  // in-flight job the moment a heartbeat slipped.
  let ticking = false;
  globalForJobRunner.jobRunnerInterval = setInterval(() => {
    if (ticking) {
      return;
    }
    ticking = true;
    processPendingJobs()
      .catch((error) => {
        logError("job-runner.tick", error);
      })
      .finally(() => {
        ticking = false;
      });
  }, intervalMs);
}

export function stopJobRunner(): void {
  if (globalForJobRunner.jobRunnerInterval) {
    clearInterval(globalForJobRunner.jobRunnerInterval);
    globalForJobRunner.jobRunnerInterval = undefined;
  }
}
