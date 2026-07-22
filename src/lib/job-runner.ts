import { prisma } from "@/lib/db";
import { getAdapter } from "@/lib/adapters/registry";
import { AdapterFailure } from "@/lib/platform-adapter";

// Minimal walking-skeleton runner: claims pending jobs by status alone and
// drives each to completion in-process. Leases, heartbeats, crash
// recovery, and retry/backoff are a separate concern (the durable job
// engine) layered on top of this later — this version proves the pipeline
// shape end to end.
export async function processPendingJobs(): Promise<void> {
  const pending = await prisma.job.findMany({
    where: { status: "pending" },
    include: { upload: true },
  });

  for (const job of pending) {
    await runJob(job.id, job.platform, job.upload);
  }
}

async function runJob(
  jobId: string,
  platform: string,
  upload: { title: string; description: string; filePath: string },
): Promise<void> {
  await prisma.job.update({
    where: { id: jobId },
    data: { status: "uploading" },
  });

  try {
    const adapter = getAdapter(platform);
    const result = await adapter.upload({
      title: upload.title,
      description: upload.description,
      filePath: upload.filePath,
    });
    await prisma.job.update({
      where: { id: jobId },
      data: { status: "done", resultUrl: result.url, error: null },
    });
  } catch (error) {
    const message =
      error instanceof AdapterFailure || error instanceof Error
        ? error.message
        : "unknown error";
    await prisma.job.update({
      where: { id: jobId },
      data: { status: "failed", error: message },
    });
  }
}

// Reused across hot reloads in dev, same rationale as the Prisma singleton
// in db.ts: a fresh reference on every module reload would leak a second
// interval running against the old module instance.
const globalForJobRunner = globalThis as unknown as {
  jobRunnerInterval?: ReturnType<typeof setInterval>;
};

export function startJobRunner(intervalMs = 1000): void {
  if (globalForJobRunner.jobRunnerInterval) {
    return;
  }
  globalForJobRunner.jobRunnerInterval = setInterval(() => {
    processPendingJobs().catch((error) => {
      console.error("job runner tick failed", error);
    });
  }, intervalMs);
}

export function stopJobRunner(): void {
  if (globalForJobRunner.jobRunnerInterval) {
    clearInterval(globalForJobRunner.jobRunnerInterval);
    globalForJobRunner.jobRunnerInterval = undefined;
  }
}
