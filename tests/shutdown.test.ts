import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

describe("registerShutdownHandlers", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "omnipost-shutdown-"));
    process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;

    execFileSync("npx", ["--no-install", "prisma", "migrate", "deploy"], {
      stdio: "inherit",
      env: process.env,
    });
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Handler registration is once-per-module; each test wants its own.
    vi.resetModules();
  });

  afterEach(() => {
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
  });

  it("disconnects prisma and exits on SIGTERM", async () => {
    const { registerShutdownHandlers } = await import("@/lib/shutdown");
    const { prisma } = await import("@/lib/db");

    const disconnectSpy = vi
      .spyOn(prisma, "$disconnect")
      .mockResolvedValue(undefined);
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    registerShutdownHandlers();
    process.emit("SIGTERM");

    await vi.waitFor(() => {
      expect(disconnectSpy).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    disconnectSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("returns the jobs it still holds to pending on SIGTERM", async () => {
    const { registerShutdownHandlers } = await import("@/lib/shutdown");
    const { getJobEngine } = await import("@/lib/job-runner");
    const { prisma, ensureSeedUser } = await import("@/lib/db");

    const user = await ensureSeedUser();
    const upload = await prisma.upload.create({
      data: {
        userId: user.id,
        title: "In flight",
        description: "",
        fileName: "clip.mp4",
        filePath: "/tmp/clip.mp4",
        fileSize: 1024,
        jobs: {
          create: [
            {
              platform: "dry-run",
              status: "uploading",
              attempts: 1,
              // Leases are per claim, prefixed with the worker that took them.
              leaseOwner: `${getJobEngine().workerId}:${crypto.randomUUID()}`,
              leaseExpiresAt: new Date(Date.now() + 30_000),
            },
          ],
        },
      },
      include: { jobs: true },
    });
    const jobId = upload.jobs[0].id;

    const disconnectSpy = vi
      .spyOn(prisma, "$disconnect")
      .mockResolvedValue(undefined);
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    registerShutdownHandlers();
    process.emit("SIGTERM");

    await vi.waitFor(async () => {
      const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
      expect(job.status).toBe("pending");
      expect(job.leaseOwner).toBeNull();
    });

    disconnectSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
