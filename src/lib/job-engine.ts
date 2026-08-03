import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { systemClock, type Clock } from "@/lib/clock";
import { getAdapter } from "@/lib/adapters/registry";
import {
  AdapterFailure,
  type PlatformAdapter,
  type TransferTracker,
  type UploadMetadata,
} from "@/lib/platform-adapter";
import { JOB_POLICY_DEFAULTS, type JobPolicy } from "@/lib/job-policy";
import { logError } from "@/lib/log";
import { JOB_STATUS } from "@/lib/job-status";
import { resolveJobMetadata, sharedUploadText } from "@/lib/job-metadata";

// The durable job engine. Jobs are rows in SQLite and the database is the
// only source of truth: a worker claims a job by writing a time-bounded
// lease, heartbeats while it works, and every write after the claim is
// guarded by "still my lease". That guard is what makes reclaim safe — a
// worker whose lease was taken away after a stall cannot clobber the
// winner's result, so a reclaimed job still completes exactly once.

// The transfer columns a Job row carries, as the database hands them over.
interface JobTransferState {
  uploadSessionUrl: string | null;
  bytesUploaded: bigint | null;
}

type UploadMetadataSnapshot = Pick<UploadMetadata, "title" | "description">;

export interface JobEngineOptions extends Partial<JobPolicy> {
  clock?: Clock;
  random?: () => number;
  resolveAdapter?: (platform: string) => PlatformAdapter;
  workerId?: string;
  /** Renewal period for a held lease. Defaults to a third of the lease. */
  heartbeatMs?: number;
}

export interface JobEngine {
  readonly workerId: string;
  /** Claim and run every job that is runnable right now. */
  tick(): Promise<void>;
  /** Startup sweep: retire exhausted jobs, reclaim expired leases. */
  recoverStalledJobs(): Promise<void>;
  /** Wait out this worker's in-flight jobs, then hand back what it still holds. */
  drain(graceMs?: number): Promise<void>;
  /** Hand back this worker's leases immediately, whether or not work is in flight. */
  releaseOwnLeases(): Promise<void>;
  /** Explicit user retry of a failed job — the only way past a terminal failure. */
  requestRetry(jobId: string): Promise<void>;
}

export function createJobEngine(options: JobEngineOptions = {}): JobEngine {
  const clock = options.clock ?? systemClock;
  const random = options.random ?? Math.random;
  const resolveAdapter = options.resolveAdapter ?? getAdapter;
  const workerId = options.workerId ?? randomUUID();
  const maxAttempts = options.maxAttempts ?? JOB_POLICY_DEFAULTS.maxAttempts;
  const leaseMs = options.leaseMs ?? JOB_POLICY_DEFAULTS.leaseMs;
  // Derived, not configured: a heartbeat period an operator could set longer
  // than the lease would expire every job it was meant to keep alive.
  const heartbeatMs =
    options.heartbeatMs ?? Math.max(250, Math.floor(leaseMs / 3));
  const backoffBaseMs =
    options.backoffBaseMs ?? JOB_POLICY_DEFAULTS.backoffBaseMs;
  const backoffMaxMs = options.backoffMaxMs ?? JOB_POLICY_DEFAULTS.backoffMaxMs;

  const inFlight = new Set<Promise<void>>();

  // "Uploading, but nobody is renewing the lease any more." Claiming and
  // startup recovery must agree on this exactly, so they share one clause.
  function stalledWhere(now: Date) {
    return {
      status: JOB_STATUS.uploading,
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
    };
  }

  function runnableWhere(now: Date) {
    return {
      attempts: { lt: maxAttempts },
      OR: [
        {
          status: JOB_STATUS.pending,
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        },
        stalledWhere(now),
      ],
    };
  }

  // Jitter is not decoration: unjittered backoff synchronises every retry
  // into a burst against a platform that is already signalling distress.
  // Half the window is deterministic so delays still visibly grow.
  function backoffFor(attempts: number): number {
    const ceiling = Math.min(
      backoffBaseMs * 2 ** Math.max(attempts - 1, 0),
      backoffMaxMs,
    );
    return Math.round(ceiling / 2 + random() * (ceiling / 2));
  }

  // Claiming is a conditional write, not a read-then-write: the same
  // predicate that made the job look runnable is re-asserted in the UPDATE,
  // so of two workers racing for one job exactly one sees count === 1.
  //
  // The lease is identified per *claim*, not per worker: a worker that
  // stalled long enough to lose a lease can otherwise reclaim its own
  // still-running job and pass the ownership guard twice, which is exactly
  // the double-upload the lease exists to prevent.
  async function claim(
    jobId: string,
    now: Date,
  ): Promise<{ lease: string; metadata: UploadMetadataSnapshot } | null> {
    const lease = `${workerId}:${randomUUID()}`;
    return prisma.$transaction(async (transaction) => {
      const current = await transaction.job.findUnique({
        where: { id: jobId },
        include: { upload: true },
      });
      if (!current) return null;
      const metadata = resolveJobMetadata(current, sharedUploadText(current.upload));
      const resolvedFromOverride =
        current.titleOverride !== null
        || current.descriptionOverride !== null
        || current.hashtagsOverride !== null;
      const claimed = await transaction.job.updateMany({
        where: { id: jobId, ...runnableWhere(now) },
        data: {
          status: JOB_STATUS.uploading,
          leaseOwner: lease,
          leaseExpiresAt: new Date(now.getTime() + leaseMs),
          attempts: { increment: 1 },
          nextAttemptAt: null,
          resolvedTitle: metadata.title,
          resolvedDescription: metadata.description,
          resolvedFromOverride,
        },
      });
      return claimed.count === 1 ? { lease, metadata } : null;
    });
  }

  // Every post-claim write goes through here, so none of them can touch a
  // job whose lease has since moved on.
  async function updateHeldJob(
    jobId: string,
    lease: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await prisma.job.updateMany({
      where: { id: jobId, leaseOwner: lease },
      data,
    });
  }

  async function releaseHeldJob(
    jobId: string,
    lease: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await updateHeldJob(jobId, lease, {
      leaseOwner: null,
      leaseExpiresAt: null,
      ...data,
    });
  }

  // Transfer state is written through the same lease guard as every other
  // post-claim write: a worker that lost its lease mid-upload must not
  // rewrite the offset of whichever worker took the job over.
  function transferTrackerFor(
    job: JobTransferState & { id: string },
    lease: string,
  ): TransferTracker {
    const jobId = job.id;
    return {
      // Only a session URL makes an attempt resumable; without one there is
      // nothing to ask the platform about, whatever offset was left behind.
      resumable: job.uploadSessionUrl === null
        ? null
        : {
            sessionUrl: job.uploadSessionUrl,
            bytesUploaded: Number(job.bytesUploaded ?? 0),
          },
      begin: (sessionUrl) =>
        updateHeldJob(jobId, lease, {
          uploadSessionUrl: sessionUrl,
          bytesUploaded: BigInt(0),
        }),
      // Widened at the boundary: adapters count bytes in ordinary numbers,
      // the column is 64-bit because video offsets outgrow 32 bits.
      record: (bytesUploaded) =>
        updateHeldJob(jobId, lease, { bytesUploaded: BigInt(bytesUploaded) }),
      forget: () =>
        updateHeldJob(jobId, lease, {
          uploadSessionUrl: null,
          bytesUploaded: null,
        }),
    };
  }

  async function runClaimedJob(
    // The Upload row carries everything an adapter needs except the tracker,
    // which is per-attempt state this engine owns rather than upload data.
    job: JobTransferState & {
      id: string;
      platform: string;
      attempts: number;
      titleOverride: string | null;
      descriptionOverride: string | null;
      upload: Omit<UploadMetadata, "transfer"> & { id: string };
    },
    lease: string,
    metadata: UploadMetadataSnapshot,
  ): Promise<void> {
    const beat = setInterval(() => {
      updateHeldJob(job.id, lease, {
        leaseExpiresAt: new Date(clock.now().getTime() + leaseMs),
      }).catch((error) => {
        logError("job-engine.heartbeat", error);
      });
    }, heartbeatMs);
    // The heartbeat must never be the reason a process stays alive.
    beat.unref?.();

    try {
      const adapter = resolveAdapter(job.platform);
      const result = await adapter.upload({
        ...job.upload,
        ...metadata,
        uploadId: job.upload.id,
        transfer: transferTrackerFor(job, lease),
      });
      await releaseHeldJob(job.id, lease, {
        status: JOB_STATUS.done,
        resultUrl: result.url,
        error: null,
      });
    } catch (error) {
      await recordFailure(job, lease, error);
    } finally {
      clearInterval(beat);
    }
  }

  async function recordFailure(
    job: { id: string; attempts: number },
    lease: string,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : "unknown error";
    // Anything that is not a typed adapter failure is treated as retryable:
    // the attempt budget bounds the damage either way, and giving up on a
    // transient bug is worse than one wasted retry.
    const terminal =
      error instanceof AdapterFailure && error.kind === "terminal";
    // attempts already includes this attempt — it is incremented at claim,
    // and the row is re-read afterwards.
    const attempts = job.attempts;

    if (terminal || attempts >= maxAttempts) {
      await releaseHeldJob(job.id, lease, {
        status: JOB_STATUS.failed,
        error: message,
      });
      return;
    }

    await releaseHeldJob(job.id, lease, {
      status: JOB_STATUS.pending,
      error: message,
      nextAttemptAt: new Date(clock.now().getTime() + backoffFor(attempts)),
    });
  }

  async function retireExhausted(now: Date, error: string): Promise<void> {
    await prisma.job.updateMany({
      where: {
        attempts: { gte: maxAttempts },
        OR: [stalledWhere(now), { status: JOB_STATUS.pending }],
      },
      data: {
        status: JOB_STATUS.failed,
        error,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
  }

  return {
    workerId,

    async tick(): Promise<void> {
      const now = clock.now();
      const candidates = await prisma.job.findMany({
        where: runnableWhere(now),
        select: { id: true, uploadId: true },
        orderBy: { createdAt: "asc" },
      });

      const byUpload = new Map<string, typeof candidates>();
      for (const candidate of candidates) {
        const group = byUpload.get(candidate.uploadId) ?? [];
        group.push(candidate);
        byUpload.set(candidate.uploadId, group);
      }
      // One upload's platform jobs are independent and run together, so a
      // poll-based platform cannot hold up direct uploads. Uploads themselves
      // stay ordered to bound simultaneous video transfers and memory use.
      for (const uploadCandidates of byUpload.values()) {
        await Promise.all(uploadCandidates.map(async (candidate) => {
          const claimResult = await claim(candidate.id, clock.now());
          if (!claimResult) return;
          const job = await prisma.job.findUnique({
            where: { id: candidate.id },
            include: { upload: true },
          });
          if (!job) return;
          const running = runClaimedJob(
            job,
            claimResult.lease,
            claimResult.metadata,
          );
          inFlight.add(running);
          try {
            await running;
          } finally {
            inFlight.delete(running);
          }
        }));
      }
    },

    async recoverStalledJobs(): Promise<void> {
      const now = clock.now();

      // Order matters: a job that stalled on its last allowed attempt is
      // done being retried, so retire it before the reclaim sweep would
      // hand it back to a worker that can never claim it. Pending rows are
      // swept too, so an exhausted job can never sit runnable-but-ignored.
      await retireExhausted(
        now,
        "attempt budget exhausted after an interrupted upload",
      );

      // A crash is a failed attempt like any other, so the reclaimed job
      // waits out a backoff: a job that reliably kills the process must not
      // spin the next instance at full speed. Row-by-row because the delay
      // depends on each job's own attempt count.
      const stalled = await prisma.job.findMany({
        where: stalledWhere(now),
        select: { id: true, attempts: true },
      });

      for (const job of stalled) {
        await prisma.job.update({
          where: { id: job.id },
          data: {
            status: JOB_STATUS.pending,
            leaseOwner: null,
            leaseExpiresAt: null,
            nextAttemptAt: new Date(now.getTime() + backoffFor(job.attempts)),
          },
        });
      }
    },

    async drain(graceMs = 5_000): Promise<void> {
      // Let in-flight work finish first: releasing a lease out from under a
      // running upload invites the next instance to publish the same video
      // a second time. Only what is still running when the grace period
      // runs out gets handed back mid-flight.
      if (inFlight.size > 0) {
        await Promise.race([
          Promise.allSettled([...inFlight]),
          new Promise((resolve) => setTimeout(resolve, graceMs).unref?.()),
        ]);
      }
      await this.releaseOwnLeases();
    },

    async releaseOwnLeases(): Promise<void> {
      // A deliberate drain is not a failure, so the attempt is refunded: a
      // deploy must not spend a job's retry budget. Matching on the worker
      // id prefix covers every per-claim lease this worker holds.
      await prisma.job.updateMany({
        where: {
          leaseOwner: { startsWith: `${workerId}:` },
          status: JOB_STATUS.uploading,
        },
        data: {
          status: JOB_STATUS.pending,
          leaseOwner: null,
          leaseExpiresAt: null,
          nextAttemptAt: null,
          attempts: { decrement: 1 },
        },
      });
    },

    async requestRetry(jobId: string): Promise<void> {
      await prisma.job.updateMany({
        where: { id: jobId, status: JOB_STATUS.failed },
        data: {
          status: JOB_STATUS.pending,
          attempts: 0,
          error: null,
          nextAttemptAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      });
    },
  };
}
