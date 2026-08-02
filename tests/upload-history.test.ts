import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

describe("upload history and retry API", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "omnipost-upload-history-"));
    process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
    writeFileSync(path.join(dir, "test.db"), "");
    execFileSync("npx", ["--no-install", "prisma", "migrate", "deploy"], {
      stdio: "inherit",
      env: process.env,
    });
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  beforeEach(async () => {
    const { prisma } = await import("@/lib/db");
    await prisma.job.deleteMany();
    await prisma.upload.deleteMany();
  });

  async function createUpload(status: "done" | "failed", createdAt: Date) {
    const { prisma, ensureSeedUser } = await import("@/lib/db");
    const user = await ensureSeedUser();
    return prisma.upload.create({
      data: {
        userId: user.id,
        title: status === "done" ? "Published Short" : "Rejected Short",
        description: "A short clip",
        fileName: "clip.mp4",
        filePath: "/tmp/clip.mp4",
        fileSize: 1024,
        createdAt,
        jobs: { create: [{ platform: "youtube", status, error: status === "failed" ? "invalid credentials" : null }] },
      },
      include: { jobs: true },
    });
  }

  it("lists most recent uploads with their job outcomes and timestamps", async () => {
    const older = await createUpload("done", new Date("2026-01-01T00:00:00.000Z"));
    const newer = await createUpload("failed", new Date("2026-01-02T00:00:00.000Z"));
    const { GET } = await import("@/app/api/uploads/route");

    const response = await GET();

    expect(response.status).toBe(200);
    const history = await response.json();
    expect(history.map((upload: { id: string }) => upload.id)).toEqual([newer.id, older.id]);
    expect(history[0].createdAt).toBe("2026-01-02T00:00:00.000Z");
    expect(history[0].jobs[0]).toMatchObject({ status: "failed", error: "invalid credentials" });
  });

  it("puts a failed job back into the queue when retried", async () => {
    const upload = await createUpload("failed", new Date());
    const { POST } = await import("@/app/api/jobs/[id]/retry/route");

    const response = await POST(new Request(`http://localhost/api/jobs/${upload.jobs[0].id}/retry`, { method: "POST" }), {
      params: Promise.resolve({ id: upload.jobs[0].id }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: upload.jobs[0].id, status: "pending", error: null });
  });

  it("returns cleared Job metadata to shared fallback on the next history read", async () => {
    const upload = await createUpload("done", new Date());
    const { prisma } = await import("@/lib/db");
    await prisma.job.update({
      where: { id: upload.jobs[0].id },
      data: {
        titleOverride: "Historical title",
        descriptionOverride: "Historical description",
        resolvedTitle: "Historical title",
        resolvedDescription: "Historical description",
        resolvedFromOverride: true,
      },
    });
    const { PATCH } = await import("@/app/api/jobs/[id]/metadata/route");
    const cleared = await PATCH(new Request(
      `http://localhost/api/jobs/${upload.jobs[0].id}/metadata`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: null, description: null }),
      },
    ), { params: Promise.resolve({ id: upload.jobs[0].id }) });
    expect(cleared.status).toBe(200);

    const { GET } = await import("@/app/api/uploads/route");
    const history = await (await GET()).json();
    expect(history[0].jobs[0]).toMatchObject({
      metadataSource: "shared",
      effectiveMetadata: {
        title: "Published Short",
        description: "A short clip",
      },
    });
  });
});
