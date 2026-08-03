import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

describe("Job metadata API", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "omnipost-job-metadata-api-"));
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

  async function seedJob(platform = "youtube", status = "pending", hashtags: string[] = []) {
    const { prisma, ensureSeedUser } = await import("@/lib/db");
    const user = await ensureSeedUser();
    const upload = await prisma.upload.create({
      data: {
        userId: user.id,
        title: "Shared title",
        description: "Shared description",
        hashtags: JSON.stringify(hashtags),
        fileName: "clip.mp4",
        filePath: "/tmp/clip.mp4",
        fileSize: 1024,
        jobs: { create: [{ platform, status }] },
      },
      include: { jobs: true },
    });
    return upload.jobs[0];
  }

  function updateRequest(jobId: string, body: unknown) {
    return new Request(`http://localhost/api/jobs/${jobId}/metadata`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("sets and replaces only one Job's title and description override", async () => {
    const { PATCH, GET } = await import("@/app/api/jobs/[id]/metadata/route");
    const { prisma } = await import("@/lib/db");
    const job = await seedJob();
    const sibling = await prisma.job.create({
      data: { uploadId: job.uploadId, platform: "instagram", status: "pending" },
    });

    let response = await PATCH(updateRequest(job.id, {
      title: "First title",
      description: "First description",
    }), { params: Promise.resolve({ id: job.id }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      source: "overridden",
      titleOverride: "First title",
      descriptionOverride: "First description",
      effective: { title: "First title", description: "First description" },
    });

    response = await PATCH(updateRequest(job.id, {
      title: "Replacement title",
      description: "Replacement description",
    }), { params: Promise.resolve({ id: job.id }) });
    expect(response.status).toBe(200);

    const read = await GET(new Request(`http://localhost/api/jobs/${job.id}/metadata`), {
      params: Promise.resolve({ id: job.id }),
    });
    expect(await read.json()).toMatchObject({
      titleOverride: "Replacement title",
      descriptionOverride: "Replacement description",
      effective: { title: "Replacement title", description: "Replacement description" },
    });
    expect(await prisma.job.findUniqueOrThrow({ where: { id: sibling.id } })).toMatchObject({
      titleOverride: null,
      descriptionOverride: null,
    });
  });

  it("clears both overrides to null and restores shared metadata", async () => {
    const { PATCH } = await import("@/app/api/jobs/[id]/metadata/route");
    const { prisma } = await import("@/lib/db");
    const job = await seedJob();
    await prisma.job.update({
      where: { id: job.id },
      data: { titleOverride: "Custom", descriptionOverride: "Custom details" },
    });

    const response = await PATCH(updateRequest(job.id, {
      title: null,
      description: null,
    }), { params: Promise.resolve({ id: job.id }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      source: "shared",
      titleOverride: null,
      descriptionOverride: null,
      effective: { title: "Shared title", description: "Shared description" },
    });
    const saved = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(saved.titleOverride).toBeNull();
    expect(saved.descriptionOverride).toBeNull();
  });

  it("accepts a finished caption but rejects a separate caption-only description", async () => {
    const { PATCH } = await import("@/app/api/jobs/[id]/metadata/route");
    const job = await seedJob("tiktok");

    const accepted = await PATCH(updateRequest(job.id, {
      title: "A finished caption #shorts",
      description: null,
    }), { params: Promise.resolve({ id: job.id }) });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      effective: { title: "A finished caption #shorts", description: "" },
    });

    const rejected = await PATCH(updateRequest(job.id, {
      title: "Caption",
      description: "Do not append this",
    }), { params: Promise.resolve({ id: job.id }) });
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error).toContain("finished caption");
  });

  it("enforces the platform's declared text limits", async () => {
    const { PATCH } = await import("@/app/api/jobs/[id]/metadata/route");
    const job = await seedJob("youtube");

    const response = await PATCH(updateRequest(job.id, {
      title: "x".repeat(101),
      description: null,
    }), { params: Promise.resolve({ id: job.id }) });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("100 characters or fewer");
  });

  it("sets a per-Job hashtag override without changing a sibling Job's shared hashtags", async () => {
    const { PATCH, GET } = await import("@/app/api/jobs/[id]/metadata/route");
    const { prisma } = await import("@/lib/db");
    const job = await seedJob("youtube", "pending", ["launch", "demo"]);
    const sibling = await prisma.job.create({
      data: { uploadId: job.uploadId, platform: "instagram", status: "pending" },
    });

    const response = await PATCH(updateRequest(job.id, {
      hashtags: ["tiktokonly"],
    }), { params: Promise.resolve({ id: job.id }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      source: "overridden",
      hashtagsOverride: ["tiktokonly"],
      effective: { title: "Shared title", description: "Shared description\n\n#tiktokonly" },
    });

    const read = await GET(new Request(`http://localhost/api/jobs/${sibling.id}/metadata`), {
      params: Promise.resolve({ id: sibling.id }),
    });
    expect(await read.json()).toMatchObject({
      source: "shared",
      hashtagsOverride: null,
    });
  });

  it("clears a hashtag override back to the Upload's shared set", async () => {
    const { PATCH } = await import("@/app/api/jobs/[id]/metadata/route");
    const job = await seedJob("youtube", "pending", ["launch"]);

    await PATCH(updateRequest(job.id, { hashtags: ["override"] }), {
      params: Promise.resolve({ id: job.id }),
    });
    const cleared = await PATCH(updateRequest(job.id, { hashtags: null }), {
      params: Promise.resolve({ id: job.id }),
    });

    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({
      source: "shared",
      hashtagsOverride: null,
      effective: { title: "Shared title", description: "Shared description\n\n#launch" },
    });
  });

  it("rejects a malformed hashtags override", async () => {
    const { PATCH } = await import("@/app/api/jobs/[id]/metadata/route");
    const job = await seedJob();

    const response = await PATCH(updateRequest(job.id, { hashtags: "not-an-array" }), {
      params: Promise.resolve({ id: job.id }),
    });

    expect(response.status).toBe(400);
  });

  it("marks an edit during upload as applying to a future attempt", async () => {
    const { PATCH } = await import("@/app/api/jobs/[id]/metadata/route");
    const job = await seedJob("youtube", "uploading");

    const response = await PATCH(updateRequest(job.id, {
      title: "Next attempt title",
      description: null,
    }), { params: Promise.resolve({ id: job.id }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      appliesTo: "future-attempt",
      titleOverride: "Next attempt title",
    });
  });
});
