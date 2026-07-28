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
  });

  it("targets YouTube when the upload owner has connected YouTube", async () => {
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

    const response = await POST(uploadRequest({
      video: new File(["fake video bytes"], "clip.mp4", { type: "video/mp4" }),
      title: "My Short",
      description: "A short clip",
    }));

    expect(response.status).toBe(201);
    expect((await response.json()).jobs[0].platform).toBe("youtube");
  });

  it("rejects an unregistered platform with a 400 naming the invalid value, before creating anything", async () => {
    const { POST } = await import("@/app/api/uploads/route");
    const { prisma } = await import("@/lib/db");
    const countBefore = await prisma.upload.count();

    const response = await POST(uploadRequest({
      video: new File(["fake video bytes"], "clip.mp4", { type: "video/mp4" }),
      title: "My Short",
      description: "A short clip",
      platform: "tiktok",
    }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("tiktok");
    await expect(prisma.upload.count()).resolves.toBe(countBefore);
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
