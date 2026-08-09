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
  platforms?: string[];
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
  const platforms = fields.platforms ?? (fields.platform === undefined ? undefined : [fields.platform]);
  if (platforms !== undefined) {
    body.set("platforms", JSON.stringify(platforms));
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

  it("creates Jobs only for the connected platforms explicitly selected", async () => {
    const { POST } = await import("@/app/api/uploads/route");
    const response = await POST(uploadRequest({
      video: new File(["fake video bytes"], "clip.mp4", { type: "video/mp4" }),
      title: "YouTube only",
      description: "A selected upload",
      platforms: ["youtube"],
    }));

    expect(response.status).toBe(201);
    expect((await response.json()).jobs.map((job: { platform: string }) => job.platform))
      .toEqual(["youtube"]);
  });

  it("rejects an empty platform selection rather than falling back to dry-run", async () => {
    const { POST } = await import("@/app/api/uploads/route");
    const response = await POST(uploadRequest({
      video: new File(["fake video bytes"], "clip.mp4", { type: "video/mp4" }),
      title: "No destination",
      description: "",
      platforms: [],
    }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("non-empty array");
  });

  it("rejects duplicate platforms instead of creating duplicate Jobs", async () => {
    const { POST } = await import("@/app/api/uploads/route");
    const response = await POST(uploadRequest({
      video: new File(["fake video bytes"], "clip.mp4", { type: "video/mp4" }),
      title: "Duplicate target",
      description: "",
      platforms: ["youtube", "youtube"],
    }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("must not contain duplicates");
  });

  it("rejects a selected platform that has no connected account", async () => {
    const { POST } = await import("@/app/api/uploads/route");
    const { ensureSeedUser, prisma } = await import("@/lib/db");
    const { encryptToken } = await import("@/lib/token-crypto");
    const user = await ensureSeedUser();
    await prisma.platformConnection.delete({
      where: { userId_platform: { userId: user.id, platform: "tiktok" } },
    });
    const response = await POST(uploadRequest({
      video: new File(["fake video bytes"], "clip.mp4", { type: "video/mp4" }),
      title: "Missing connection",
      description: "",
      platforms: ["tiktok"],
    }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('platform "tiktok" is not connected');
    await prisma.platformConnection.create({
      data: {
        userId: user.id,
        platform: "tiktok",
        accessTokenEncrypted: encryptToken("access"),
        refreshTokenEncrypted: encryptToken("refresh"),
        accessTokenExpiresAt: new Date(Date.now() + 60_000),
        externalAccountId: "open-id-restored",
      },
    });
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

  it("persists a per-platform hashtag override on its target Job without changing the shared Upload hashtags", async () => {
    const { POST } = await import("@/app/api/uploads/route");
    const { prisma } = await import("@/lib/db");

    const response = await POST(uploadRequest({
      video: new File(["fake video bytes"], "clip.mp4", { type: "video/mp4" }),
      title: "Shared title",
      description: "Shared description",
      platform: "youtube",
      hashtags: ["launch", "demo"],
      overrides: {
        youtube: { hashtags: ["tiktokonly"] },
      },
    }));

    expect(response.status).toBe(201);
    const created = await response.json();
    const upload = await prisma.upload.findUniqueOrThrow({
      where: { id: created.id },
      include: { jobs: true },
    });
    expect(JSON.parse(upload.hashtags)).toEqual(["launch", "demo"]);
    expect(JSON.parse(upload.jobs[0].hashtagsOverride!)).toEqual(["tiktokonly"]);
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

  it("rejects a shared hashtag set that overflows a caption platform's limit", async () => {
    const { POST } = await import("@/app/api/uploads/route");
    const response = await POST(uploadRequest({
      video: new File(["fake video bytes"], "clip.mp4", { type: "video/mp4" }),
      title: "T",
      description: "y".repeat(2_190),
      platform: "tiktok",
      hashtags: ["overflow"],
    }));

    expect(response.status).toBe(400);
    const { error } = await response.json();
    expect(error).toBe("tiktok caption must be 2200 characters or fewer");
  });

  it("accepts the same upload once the hashtags that overflowed it are gone", async () => {
    // The shared text is unchanged from the test above, so the rejection there
    // is attributable to the hashtags and nothing else.
    const { POST } = await import("@/app/api/uploads/route");
    const response = await POST(uploadRequest({
      video: new File(["fake video bytes"], "clip.mp4", { type: "video/mp4" }),
      title: "T",
      description: "y".repeat(2_190),
      platform: "tiktok",
      hashtags: [],
    }));

    expect(response.status).toBe(201);
  });

  it("rejects a per-platform hashtag override that overflows the caption", async () => {
    const { POST } = await import("@/app/api/uploads/route");
    const response = await POST(uploadRequest({
      video: new File(["fake video bytes"], "clip.mp4", { type: "video/mp4" }),
      title: "T",
      description: "y".repeat(2_190),
      platforms: ["instagram"],
      hashtags: [],
      overrides: { instagram: { hashtags: ["overflow"] } },
    }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe(
      "instagram caption must be 2200 characters or fewer",
    );
  });

  it("lets a hashtag set too long for a caption platform through to YouTube", async () => {
    const { POST } = await import("@/app/api/uploads/route");
    const { prisma } = await import("@/lib/db");
    const response = await POST(uploadRequest({
      video: new File(["fake video bytes"], "clip.mp4", { type: "video/mp4" }),
      title: "T",
      description: "y".repeat(2_190),
      platform: "youtube",
      hashtags: ["overflow"],
    }));

    expect(response.status).toBe(201);
    const created = await response.json();
    const upload = await prisma.upload.findUniqueOrThrow({ where: { id: created.id } });
    expect(JSON.parse(upload.hashtags)).toEqual(["overflow"]);
  });

  it("rejects a separate description for a caption-only override", async () => {
    const { POST } = await import("@/app/api/uploads/route");
    const response = await POST(uploadRequest({
      video: new File(["fake video bytes"], "clip.mp4", { type: "video/mp4" }),
      title: "Shared title",
      description: "Shared description",
      platforms: ["instagram"],
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
        platforms: ["tiktok"],
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

  it("keeps accepting an extensionless typed video through the dry-run fallback", async () => {
    const { POST } = await import("@/app/api/uploads/route");
    const { ensureSeedUser, prisma } = await import("@/lib/db");
    const { encryptToken } = await import("@/lib/token-crypto");
    await prisma.platformConnection.deleteMany();
    const response = await POST(
      uploadRequest({
        video: new File(["video bytes"], "clip", { type: "video/mp4" }),
        title: "My Short",
        description: "",
      }),
    );

    expect(response.status).toBe(201);
    expect((await response.json()).jobs[0].platform).toBe("dry-run");

    const user = await ensureSeedUser();
    await prisma.platformConnection.create({
      data: {
        userId: user.id,
        platform: "instagram",
        accessTokenEncrypted: encryptToken("access"),
        refreshTokenEncrypted: encryptToken("refresh"),
        accessTokenExpiresAt: new Date(Date.now() + 60_000),
        externalAccountId: "ig-restored",
      },
    });
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
      platforms: ["instagram"],
    })).rejects.toThrow("1 GB");
  });

  it("does not allow dry-run to be selected as a destination", async () => {
    const { POST } = await import("@/app/api/uploads/route");

    const response = await POST(uploadRequest({
      video: new File(["fake video bytes"], "clip.mp4", { type: "video/mp4" }),
      title: "My Short",
      description: "A short clip",
      platform: "dry-run",
    }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('platform "dry-run" is not connected');
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
