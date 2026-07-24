import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("processPendingJobs", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "omnipost-job-runner-"));
    const dbPath = path.join(dir, "test.db");
    writeFileSync(dbPath, "");
    process.env.DATABASE_URL = `file:${dbPath}`;

    execFileSync("npx", ["--no-install", "prisma", "migrate", "deploy"], {
      stdio: "inherit",
      env: process.env,
    });
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("drives a pending dry-run Job to done with no outbound network call", async () => {
    const { processPendingJobs } = await import("@/lib/job-runner");
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
        jobs: { create: [{ platform: "dry-run", status: "pending" }] },
      },
      include: { jobs: true },
    });
    const jobId = upload.jobs[0].id;

    await processPendingJobs();

    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("done");
    expect(job.resultUrl).toMatch(/^dry-run:\/\//);
    expect(job.error).toBeNull();
  });

  it("leaves non-pending jobs untouched", async () => {
    const { processPendingJobs } = await import("@/lib/job-runner");
    const { prisma, ensureSeedUser } = await import("@/lib/db");

    const user = await ensureSeedUser();
    const upload = await prisma.upload.create({
      data: {
        userId: user.id,
        title: "Already done",
        description: "",
        fileName: "clip.mp4",
        filePath: "/tmp/clip.mp4",
        fileSize: 1024,
        jobs: {
          create: [
            { platform: "dry-run", status: "done", resultUrl: "dry-run://existing" },
          ],
        },
      },
      include: { jobs: true },
    });
    const jobId = upload.jobs[0].id;

    await processPendingJobs();

    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.resultUrl).toBe("dry-run://existing");
  });
});
