import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetConfigCache } from "@/lib/config";

function uploadRequest(fields: {
  video?: File | null;
  title?: string;
  description?: string;
  platform?: string;
  overrides?: unknown;
  hashtags?: unknown;
}) {
  const body = new FormData();
  if (fields.video !== undefined && fields.video !== null) {
    body.set("video", fields.video);
  }
  if (fields.title !== undefined) {
    body.set("title", fields.title);
  }
  if (fields.description !== undefined) {
    body.set("description", fields.description);
  }
  if (fields.platform !== undefined) {
    body.set("platform", fields.platform);
  }
  if (fields.overrides !== undefined) {
    body.set("overrides", JSON.stringify(fields.overrides));
  }
  if (fields.hashtags !== undefined) {
    body.set("hashtags", JSON.stringify(fields.hashtags));
  }
  return new Request("http://localhost/api/uploads", {
    method: "POST",
    body,
  });
}

describe("POST /api/uploads", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "omnipost-uploads-"));
    const dbPath = path.join(dir, "test.db");
    writeFileSync(dbPath, "");
    process.env.DATABASE_URL = `file:${dbPath}`;
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    resetConfigCache();

    execFileSync("npx", ["--no-install", "prisma", "migrate", "deploy"], {
      stdio: "inherit",
      env: process.env,
    });
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates an Upload and a pending Job, returning immediately", async () => {
    const { POST } = await import("@/app/api/uploads/route");
    const { prisma } = await import("@/lib/db");

    const video = new File(["fake video bytes"], "clip.mp4", {
      type: "video/mp4",
    });

    const response = await POST(
      uploadRequest({ video, title: "My Short", description: "A short clip" }),
    );

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.jobs).toHaveLength(1);
    expect(data.jobs[0].status).toBe("pending");
    expect(data.jobs[0].platform).toBe("dry-run");

    const upload = await prisma.upload.findUnique({
      where: { id: data.id },
      include: { jobs: true },
    });
    expect(upload?.title).toBe("My Short");
    expect(upload?.description).toBe("A short clip");
    expect(upload?.fileName).toBe("clip.mp4");
    expect(upload?.jobs).toHaveLength(1);
    expect(upload?.jobs[0].status).toBe("pending");
    expect(upload?.jobs[0]).toMatchObject({
      titleOverride: null,
      descriptionOverride: null,
    });
  });

  it("fans one upload out to connected YouTube, TikTok, and Instagram jobs", async () => {
    const { POST } = await import("@/app/api/uploads/route");
    const { prisma, ensureSeedUser } = await import("@/lib/db");
    const { encryptToken } = await import("@/lib/token-crypto");
    const user = await ensureSeedUser();
    await prisma.platformConnection.create({
      data: {
        userId: user.id,
        platform: "youtube",
        accessTokenEncrypted: encryptToken("access"),
        refreshTokenEncrypted: encryptToken("refresh"),
        accessTokenExpiresAt: new Date(Date.now() + 60_000),
        externalAccountId: "channel-123",
      },
    });
    await prisma.platformConnection.create({
      data: {
        userId: user.id,
        platform: "tiktok",
        accessTokenEncrypted: encryptToken("access"),
        refreshTokenEncrypted: encryptToken("refresh"),
        accessTokenExpiresAt: new Date(Date.now() + 60_000),
        externalAccountId: "open-id-123",
      },
    });
    await prisma.platformConnection.create({
      data: {
        userId: user.id,
        platform: "instagram",
        accessTokenEncrypted: encryptToken("access"),
        refreshTokenEncrypted: encryptToken("refresh"),
        accessTokenExpiresAt: new Date(Date.now() + 60_000),
        externalAccountId: "ig-123",
      },
    });

    const response = await POST(uploadRequest({
      video: new File(["fake video bytes"], "clip.mp4", { type: "video/mp4" }),
      title: "My Short",
      description: "A short clip",
    }));

    expect(response.status).toBe(201);
    expect((await response.json()).jobs.map((job: { platform: string }) => job.platform).sort())
      .toEqual(["instagram", "tiktok", "youtube"]);
  });

  it("persists an override on its target Job without changing the shared Upload text", async () => {
    const { POST } = await import("@/app/api/uploads/route");
    const { prisma } = await import("@/lib/db");

    const response = await POST(uploadRequest({
      video: new File(["fake video bytes"], "clip.mp4", { type: "video/mp4" }),
      title: "Shared title",
      description: "Shared description",
      platform: "youtube",
      overrides: {
        youtube: {
          title: "YouTube title",
          description: "YouTube description",
        },
      },
    }));

    expect(response.status).toBe(201);
    const created = await response.json();
    const upload = await prisma.upload.findUniqueOrThrow({
      where: { id: created.id },
      include: { jobs: true },
    });
    expect(upload).toMatchObject({
      title: "Shared title",
      description: "Shared description",
    });
    expect(upload.jobs[0]).toMatchObject({
      platform: "youtube",
      titleOverride: "YouTube title",
      descriptionOverride: "YouTube description",
    });
  });

  it("stores a shared hashtag set on the Upload", async () => {
    const { POST } = await import("@/app/api/uploads/route");
    const { prisma } = await import("@/lib/db");

    const response = await POST(uploadRequest({
      video: new File(["fake video bytes"], "clip.mp4", { type: "video/mp4" }),
      title: "My Short",
      description: "A short clip",
      hashtags: ["launch", "demo"],
    }));

    expect(response.status).toBe(201);
    const created = await response.json();
    expect(created.hashtags).toEqual(["launch", "demo"]);
    const upload = await prisma.upload.findUniqueOrThrow({ where: { id: created.id } });
    expect(JSON.parse(upload.hashtags)).toEqual(["launch", "demo"]);
  });

  it("rejects a malformed hashtags field", async () => {
    const { POST } = await import("@/app/api/uploads/route");
    const response = await POST(uploadRequest({
      video: new File(["fake video bytes"], "clip.mp4", { type: "video/mp4" }),
      title: "My Short",
      description: "A short clip",
      hashtags: { not: "an array" },
    }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("hashtags");
  });

  it("rejects an override for a platform outside the Upload fan-out", async () => {
    const { POST } = await import("@/app/api/uploads/route");
    const response = await POST(uploadRequest({
      video: new File(["fake video bytes"], "clip.mp4", { type: "video/mp4" }),
      title: "Shared title",
      description: "Shared description",
      platform: "youtube",
      overrides: { tiktok: { title: "Wrong target" } },
    }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("not included");
  });

  it("rejects an unregistered override platform at the request boundary", async () => {
    const { POST } = await import("@/app/api/uploads/route");
    const response = await POST(uploadRequest({
      video: new File(["fake video bytes"], "clip.mp4", { type: "video/mp4" }),
      title: "Shared title",
      description: "Shared description",
      platform: "youtube",
      overrides: { facebook: { title: "Unsupported" } },
    }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("unsupported override platform");
  });

  it("stores a caption-only override as one finished caption", async () => {
    const { POST } = await import("@/app/api/uploads/route");
    const { prisma } = await import("@/lib/db");
    const response = await POST(uploadRequest({
      video: new File(["fake video bytes"], "clip.mp4", { type: "video/mp4" }),
      title: "Shared title",
      description: "Shared description",
      platform: "tiktok",
      overrides: { tiktok: { title: "Finished caption #shorts" } },
    }));

    expect(response.status).toBe(201);
    const created = await response.json();
    const job = await prisma.job.findUniqueOrThrow({
      where: { id: created.jobs[0].id },
    });
    expect(job.titleOverride).toBe("Finished caption #shorts");
    expect(job.descriptionOverride).toBeNull();
  });

  it("rejects a separate description for a caption-only override", async () => {
    const { POST } = await import("@/app/api/uploads/route");
    const response = await POST(uploadRequest({
      video: new File(["fake video bytes"], "clip.mp4", { type: "video/mp4" }),
      title: "Shared title",
      description: "Shared description",
      platform: "instagram",
      overrides: {
        instagram: { title: "Finished caption", description: "Append me" },
      },
    }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("one finished caption");
  });

  it("rejects an oversized explicit TikTok upload before saving the file", async () => {
    const { createUpload } = await import("@/lib/uploads");
    const { ensureSeedUser } = await import("@/lib/db");
    const user = await ensureSeedUser();
    const oversizedFile = {
      name: "large.mp4",
      size: 64 * 1024 * 1024 + 1,
      arrayBuffer: () => {
        throw new Error("file should not be read");
      },
    } as unknown as File;

    await expect(
      createUpload({
        userId: user.id,
        title: "Large clip",
        description: "",
        file: oversizedFile,
        platform: "tiktok",
      }),
    ).rejects.toThrow("64 MB");
  });

  it("rejects a video whose MIME type conflicts with its extension", async () => {
    const { POST } = await import("@/app/api/uploads/route");
    const response = await POST(
      uploadRequest({
        video: new File(["webm bytes"], "clip.mp4", { type: "video/webm" }),
        title: "My Short",
        description: "",
      }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("does not match");
  });

  it("keeps accepting an extensionless typed video for dry-run", async () => {
    const { POST } = await import("@/app/api/uploads/route");
    const response = await POST(
      uploadRequest({
        video: new File(["video bytes"], "clip", { type: "video/mp4" }),
        title: "My Short",
        description: "",
        platform: "dry-run",
      }),
    );

    expect(response.status).toBe(201);
    expect((await response.json()).jobs[0].platform).toBe("dry-run");
  });

  it("accepts Instagram as an explicit registered platform", async () => {
    const { POST } = await import("@/app/api/uploads/route");
    const response = await POST(uploadRequest({
      video: new File(["fake video bytes"], "clip.mp4", { type: "video/mp4" }),
      title: "My Short",
      description: "A short clip",
      platform: "instagram",
    }));

    expect(response.status).toBe(201);
    expect((await response.json()).jobs[0].platform).toBe("instagram");
  });

  it("rejects an Instagram upload whose container is not MP4 or MOV", async () => {
    const { POST } = await import("@/app/api/uploads/route");
    const response = await POST(uploadRequest({
      video: new File(["webm bytes"], "clip.webm", { type: "video/webm" }),
      title: "My Reel",
      description: "A short clip",
      platform: "instagram",
    }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("MP4 or MOV");
  });

  it("rejects an Instagram video above the Reels size limit before saving", async () => {
    const { createUpload } = await import("@/lib/uploads");
    const { ensureSeedUser } = await import("@/lib/db");
    const user = await ensureSeedUser();
    const oversizedFile = {
      name: "large.mp4",
      type: "video/mp4",
      size: 1024 * 1024 * 1024 + 1,
      arrayBuffer: () => { throw new Error("file should not be read"); },
    } as unknown as File;

    await expect(createUpload({
      userId: user.id,
      title: "Large Reel",
      description: "",
      file: oversizedFile,
      platform: "instagram",
    })).rejects.toThrow("1 GB");
  });

  it("honors an explicit, registered platform instead of auto-selecting", async () => {
    const { POST } = await import("@/app/api/uploads/route");

    const response = await POST(uploadRequest({
      video: new File(["fake video bytes"], "clip.mp4", { type: "video/mp4" }),
      title: "My Short",
      description: "A short clip",
      platform: "dry-run",
    }));

    expect(response.status).toBe(201);
    expect((await response.json()).jobs[0].platform).toBe("dry-run");
  });

  it("rejects a request with no video file", async () => {
    const { POST } = await import("@/app/api/uploads/route");

    const response = await POST(
      uploadRequest({ title: "My Short", description: "A short clip" }),
    );

    expect(response.status).toBe(400);
  });

  it("rejects a request with no title", async () => {
    const { POST } = await import("@/app/api/uploads/route");
    const video = new File(["fake video bytes"], "clip.mp4", {
      type: "video/mp4",
    });

    const response = await POST(
      uploadRequest({ video, title: "", description: "A short clip" }),
    );

    expect(response.status).toBe(400);
  });
});
