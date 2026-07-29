import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Clock } from "@/lib/clock";
import type {
  PlatformAdapter,
  UploadMetadata,
  UploadResult,
} from "@/lib/platform-adapter";
import { AdapterFailure } from "@/lib/platform-adapter";

// Time is injected, so lease expiry and backoff are exercised by advancing a
// number rather than by waiting.
function fakeClock(start = new Date("2026-01-01T00:00:00.000Z")) {
  let current = start.getTime();
  const clock: Clock & { advance(ms: number): void; date(): Date } = {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
    date: () => new Date(current),
  };
  return clock;
}

function adapterOf(
  upload: (metadata: UploadMetadata) => Promise<UploadResult>,
): PlatformAdapter {
  return { platform: "dry-run", upload };
}

describe("job engine", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "omnipost-job-engine-"));
    process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
    writeFileSync(path.join(dir, "test.db"), "");

    execFileSync("npx", ["--no-install", "prisma", "migrate", "deploy"], {
      stdio: "inherit",
      env: process.env,
    });
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // A tick claims every runnable job in the database, so each test starts
  // from an empty queue rather than inheriting the last one's leftovers.
  beforeEach(async () => {
    const { prisma } = await import("@/lib/db");
    await prisma.job.deleteMany();
    await prisma.upload.deleteMany();
  });

  async function seedJob(
    job: Record<string, unknown> = {},
  ): Promise<{ id: string }> {
    const { prisma, ensureSeedUser } = await import("@/lib/db");
    const user = await ensureSeedUser();
    const upload = await prisma.upload.create({
      data: {
        userId: user.id,
        title: "My Short",
        description: "A short clip",
        fileName: "clip.mp4",
        filePath: "/tmp/clip.mp4",
        fileSize: 1024,
        jobs: { create: [{ platform: "test", status: "pending", ...job }] },
      },
      include: { jobs: true },
    });
    return { id: upload.jobs[0].id };
  }

  it("claims a runnable job, drives it to done, and releases the lease", async () => {
    const { createJobEngine } = await import("@/lib/job-engine");
    const { prisma } = await import("@/lib/db");
    const clock = fakeClock();
    const { id } = await seedJob();

    const engine = createJobEngine({
      clock,
      resolveAdapter: () =>
        adapterOf(async () => ({ url: "https://example.test/v/1" })),
    });
    await engine.tick();

    const job = await prisma.job.findUniqueOrThrow({ where: { id } });
    expect(job.status).toBe("done");
    expect(job.resultUrl).toBe("https://example.test/v/1");
    expect(job.leaseOwner).toBeNull();
    expect(job.leaseExpiresAt).toBeNull();
    expect(job.attempts).toBe(1);
  });

  it("finishes one platform job when another platform job fails", async () => {
    const { createJobEngine } = await import("@/lib/job-engine");
    const { prisma, ensureSeedUser } = await import("@/lib/db");
    const user = await ensureSeedUser();
    const upload = await prisma.upload.create({
      data: {
        userId: user.id, title: "My Short", description: "A short clip", fileName: "clip.mp4", filePath: "/tmp/clip.mp4", fileSize: 1024,
        jobs: { create: [{ platform: "youtube", status: "pending" }, { platform: "tiktok", status: "pending" }] },
      },
      include: { jobs: true },
    });
    const engine = createJobEngine({
      resolveAdapter: (platform) => adapterOf(async () => {
        if (platform === "tiktok") throw new AdapterFailure("TikTok rejected the upload", "terminal");
        return { url: "https://example.test/youtube/1" };
      }),
    });

    await engine.tick();

    const jobs = await prisma.job.findMany({ where: { uploadId: upload.id }, orderBy: { platform: "asc" } });
    expect(jobs.map((job) => job.status)).toEqual(["failed", "done"]);
  });

  it("leaves a leased job alone until its lease expires", async () => {
    const { createJobEngine } = await import("@/lib/job-engine");
    const { prisma } = await import("@/lib/db");
    const clock = fakeClock();
    const { id } = await seedJob({
      status: "uploading",
      attempts: 1,
      leaseOwner: "worker-that-died",
      leaseExpiresAt: new Date(clock.date().getTime() + 30_000),
    });

    let calls = 0;
    const engine = createJobEngine({
      clock,
      resolveAdapter: () =>
        adapterOf(async () => {
          calls += 1;
          return { url: "https://example.test/v/2" };
        }),
    });

    await engine.tick();
    expect(calls).toBe(0);
    expect(
      (await prisma.job.findUniqueOrThrow({ where: { id } })).leaseOwner,
    ).toBe("worker-that-died");

    clock.advance(30_001);
    await engine.tick();

    const job = await prisma.job.findUniqueOrThrow({ where: { id } });
    expect(calls).toBe(1);
    expect(job.status).toBe("done");
  });

  it("reclaims an expired lease exactly once when workers race", async () => {
    const { createJobEngine } = await import("@/lib/job-engine");
    const { prisma } = await import("@/lib/db");
    const clock = fakeClock();
    const { id } = await seedJob({
      status: "uploading",
      attempts: 1,
      leaseOwner: "worker-that-died",
      leaseExpiresAt: new Date(clock.date().getTime() - 1),
    });

    let calls = 0;
    const resolveAdapter = () =>
      adapterOf(async () => {
        calls += 1;
        return { url: `https://example.test/v/${calls}` };
      });

    await Promise.all([
      createJobEngine({ clock, workerId: "a", resolveAdapter }).tick(),
      createJobEngine({ clock, workerId: "b", resolveAdapter }).tick(),
    ]);

    const job = await prisma.job.findUniqueOrThrow({ where: { id } });
    expect(calls).toBe(1);
    expect(job.status).toBe("done");
    expect(job.resultUrl).toBe("https://example.test/v/1");
  });

  it("returns an expired-lease job to pending on startup recovery", async () => {
    const { createJobEngine } = await import("@/lib/job-engine");
    const { prisma } = await import("@/lib/db");
    const clock = fakeClock();
    const { id } = await seedJob({
      status: "uploading",
      attempts: 1,
      leaseOwner: "worker-that-died",
      leaseExpiresAt: new Date(clock.date().getTime() - 1),
    });

    const engine = createJobEngine({
      clock,
      resolveAdapter: () =>
        adapterOf(async () => ({ url: "https://example.test/v/3" })),
    });
    await engine.recoverStalledJobs();

    const recovered = await prisma.job.findUniqueOrThrow({ where: { id } });
    expect(recovered.status).toBe("pending");
    expect(recovered.leaseOwner).toBeNull();
    // A crash is a failed attempt, so the reclaimed job waits out a backoff
    // rather than spinning the fresh instance at full speed.
    expect(recovered.nextAttemptAt!.getTime()).toBeGreaterThan(
      clock.date().getTime(),
    );

    clock.advance(60_000);
    await engine.tick();
    expect(
      (await prisma.job.findUniqueOrThrow({ where: { id } })).status,
    ).toBe("done");
  });

  it("fails a stalled job that has exhausted its attempt budget", async () => {
    const { createJobEngine } = await import("@/lib/job-engine");
    const { prisma } = await import("@/lib/db");
    const clock = fakeClock();
    const { id } = await seedJob({
      status: "uploading",
      attempts: 3,
      leaseOwner: "worker-that-died",
      leaseExpiresAt: new Date(clock.date().getTime() - 1),
    });

    const engine = createJobEngine({
      clock,
      maxAttempts: 3,
      resolveAdapter: () =>
        adapterOf(async () => ({ url: "https://example.test/v/4" })),
    });
    await engine.recoverStalledJobs();

    const job = await prisma.job.findUniqueOrThrow({ where: { id } });
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/attempt/i);
    expect(job.leaseOwner).toBeNull();
  });

  it("reschedules a retryable failure with a growing, jittered delay", async () => {
    const { createJobEngine } = await import("@/lib/job-engine");
    const { prisma } = await import("@/lib/db");
    const clock = fakeClock();
    const { id } = await seedJob();

    const engine = createJobEngine({
      clock,
      maxAttempts: 5,
      backoffBaseMs: 1_000,
      random: () => 0.5,
      resolveAdapter: () =>
        adapterOf(async () => {
          throw new AdapterFailure("rate limited", "retryable");
        }),
    });

    const delays: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await engine.tick();
      const job = await prisma.job.findUniqueOrThrow({ where: { id } });
      expect(job.status).toBe("pending");
      expect(job.error).toBe("rate limited");
      delays.push(job.nextAttemptAt!.getTime() - clock.date().getTime());
      clock.advance(delays[delays.length - 1] + 1);
    }

    expect(delays[1]).toBeGreaterThan(delays[0]);
    expect(delays[2]).toBeGreaterThan(delays[1]);
  });

  it("jitters the delay rather than scheduling every worker at the same instant", async () => {
    const { createJobEngine } = await import("@/lib/job-engine");
    const { prisma } = await import("@/lib/db");

    async function delayWithRandom(random: number): Promise<number> {
      const clock = fakeClock();
      const { id } = await seedJob();
      const engine = createJobEngine({
        clock,
        backoffBaseMs: 10_000,
        random: () => random,
        resolveAdapter: () =>
          adapterOf(async () => {
            throw new AdapterFailure("rate limited", "retryable");
          }),
      });
      await engine.tick();
      const job = await prisma.job.findUniqueOrThrow({ where: { id } });
      return job.nextAttemptAt!.getTime() - clock.date().getTime();
    }

    const low = await delayWithRandom(0);
    const high = await delayWithRandom(1);
    expect(high).toBeGreaterThan(low);
  });

  it("fails a job that exhausts its attempt budget while retrying", async () => {
    const { createJobEngine } = await import("@/lib/job-engine");
    const { prisma } = await import("@/lib/db");
    const clock = fakeClock();
    const { id } = await seedJob();

    const engine = createJobEngine({
      clock,
      maxAttempts: 2,
      backoffBaseMs: 1_000,
      resolveAdapter: () =>
        adapterOf(async () => {
          throw new AdapterFailure("rate limited", "retryable");
        }),
    });

    await engine.tick();
    clock.advance(60_000);
    await engine.tick();

    const job = await prisma.job.findUniqueOrThrow({ where: { id } });
    expect(job.status).toBe("failed");
    expect(job.attempts).toBe(2);
    expect(job.error).toBe("rate limited");

    // Budget exhausted: further ticks must not touch it.
    clock.advance(60_000);
    await engine.tick();
    expect(
      (await prisma.job.findUniqueOrThrow({ where: { id } })).status,
    ).toBe("failed");
  });

  it("does not retry a terminal failure, and waits for an explicit retry", async () => {
    const { createJobEngine } = await import("@/lib/job-engine");
    const { prisma } = await import("@/lib/db");
    const clock = fakeClock();
    const { id } = await seedJob();

    let calls = 0;
    const engine = createJobEngine({
      clock,
      maxAttempts: 5,
      resolveAdapter: () =>
        adapterOf(async () => {
          calls += 1;
          throw new AdapterFailure("invalid credentials", "terminal");
        }),
    });

    await engine.tick();
    let job = await prisma.job.findUniqueOrThrow({ where: { id } });
    expect(job.status).toBe("failed");
    expect(job.error).toBe("invalid credentials");
    expect(job.nextAttemptAt).toBeNull();

    clock.advance(60 * 60_000);
    await engine.tick();
    expect(calls).toBe(1);

    await engine.requestRetry(id);
    job = await prisma.job.findUniqueOrThrow({ where: { id } });
    expect(job.status).toBe("pending");
    expect(job.attempts).toBe(0);
    expect(job.error).toBeNull();

    await engine.tick();
    expect(calls).toBe(2);
  });

  it("releases its own in-flight leases on shutdown without burning an attempt", async () => {
    const { createJobEngine } = await import("@/lib/job-engine");
    const { prisma } = await import("@/lib/db");
    const clock = fakeClock();
    const { id } = await seedJob();

    let release: (() => void) | undefined;
    const engine = createJobEngine({
      clock,
      workerId: "worker-a",
      resolveAdapter: () =>
        adapterOf(
          () =>
            new Promise<UploadResult>((resolve) => {
              release = () => resolve({ url: "https://example.test/v/5" });
            }),
        ),
    });

    const running = engine.tick();
    await new Promise((resolve) => setImmediate(resolve));

    const leased = await prisma.job.findUniqueOrThrow({ where: { id } });
    expect(leased.status).toBe("uploading");
    expect(leased.leaseOwner).toMatch(/^worker-a:/);
    expect(leased.attempts).toBe(1);

    await engine.releaseOwnLeases();
    release?.();
    await running;

    const released = await prisma.job.findUniqueOrThrow({ where: { id } });
    expect(released.status).toBe("pending");
    expect(released.leaseOwner).toBeNull();
    expect(released.attempts).toBe(0);
  });

  it("lets an in-flight upload finish before draining releases its lease", async () => {
    const { createJobEngine } = await import("@/lib/job-engine");
    const { prisma } = await import("@/lib/db");
    const clock = fakeClock();
    const { id } = await seedJob();

    let release: (() => void) | undefined;
    const engine = createJobEngine({
      clock,
      resolveAdapter: () =>
        adapterOf(
          () =>
            new Promise<UploadResult>((resolve) => {
              release = () => resolve({ url: "https://example.test/v/6" });
            }),
        ),
    });

    const running = engine.tick();
    await new Promise((resolve) => setImmediate(resolve));

    const draining = engine.drain(1_000);
    // The drain must wait for the upload rather than yank its lease: a job
    // released mid-upload is a job the next instance publishes twice.
    release?.();
    await Promise.all([running, draining]);

    const job = await prisma.job.findUniqueOrThrow({ where: { id } });
    expect(job.status).toBe("done");
    expect(job.resultUrl).toBe("https://example.test/v/6");
  });

  it("renews the lease of a job it is still working on", async () => {
    const { createJobEngine } = await import("@/lib/job-engine");
    const { prisma } = await import("@/lib/db");
    const clock = fakeClock();
    const { id } = await seedJob();

    let release: (() => void) | undefined;
    const engine = createJobEngine({
      clock,
      leaseMs: 30_000,
      heartbeatMs: 5,
      resolveAdapter: () =>
        adapterOf(
          () =>
            new Promise<UploadResult>((resolve) => {
              release = () => resolve({ url: "https://example.test/v/7" });
            }),
        ),
    });

    const running = engine.tick();
    await new Promise((resolve) => setImmediate(resolve));
    const firstLease = (
      await prisma.job.findUniqueOrThrow({ where: { id } })
    ).leaseExpiresAt!;

    // Time moves on while the upload is still going: the heartbeat should
    // push the lease out ahead of the clock rather than let it lapse.
    clock.advance(20_000);
    await vi.waitFor(async () => {
      const job = await prisma.job.findUniqueOrThrow({ where: { id } });
      expect(job.leaseExpiresAt!.getTime()).toBeGreaterThan(
        firstLease.getTime(),
      );
      expect(job.leaseExpiresAt!.getTime()).toBeGreaterThan(
        clock.date().getTime(),
      );
    });

    release?.();
    await running;
  });

  it("ignores a completion from a worker whose lease was already reclaimed", async () => {
    const { createJobEngine } = await import("@/lib/job-engine");
    const { prisma } = await import("@/lib/db");
    const clock = fakeClock();
    const { id } = await seedJob();

    let releaseStalled: (() => void) | undefined;
    const stalled = createJobEngine({
      clock,
      leaseMs: 30_000,
      // No heartbeat during the test: this worker is the one that stops
      // reporting in and loses its lease.
      heartbeatMs: 60_000,
      workerId: "stalled",
      resolveAdapter: () =>
        adapterOf(
          () =>
            new Promise<UploadResult>((resolve) => {
              releaseStalled = () => resolve({ url: "https://example.test/late" });
            }),
        ),
    });
    const reclaimer = createJobEngine({
      clock,
      workerId: "reclaimer",
      resolveAdapter: () =>
        adapterOf(async () => ({ url: "https://example.test/winner" })),
    });

    const stalledRun = stalled.tick();
    await new Promise((resolve) => setImmediate(resolve));

    clock.advance(30_001);
    await reclaimer.tick();
    expect(
      (await prisma.job.findUniqueOrThrow({ where: { id } })).resultUrl,
    ).toBe("https://example.test/winner");

    // The stalled worker finally finishes — its write must be dropped, not
    // allowed to overwrite the result of the worker that took over.
    releaseStalled?.();
    await stalledRun;

    const job = await prisma.job.findUniqueOrThrow({ where: { id } });
    expect(job.status).toBe("done");
    expect(job.resultUrl).toBe("https://example.test/winner");
  });
});
