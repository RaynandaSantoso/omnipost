import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { resetConfigCache } from "@/lib/config";

const uploadServer = setupServer();
const initUrl = "https://open.tiktokapis.com/v2/post/publish/video/init/";

describe("TikTokAdapter", () => {
  let dir: string;
  let videoPath: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "omnipost-tiktok-adapter-"));
    process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
    process.env.TIKTOK_CLIENT_KEY = "client-key";
    process.env.TIKTOK_CLIENT_SECRET = "client-secret";
    process.env.TIKTOK_REDIRECT_URI = "http://localhost/api/platforms/tiktok/callback";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    resetConfigCache();
    writeFileSync(path.join(dir, "test.db"), "");
    videoPath = path.join(dir, "clip.mp4");
    writeFileSync(videoPath, "video bytes");
    execFileSync("npx", ["--no-install", "prisma", "migrate", "deploy"], { stdio: "inherit", env: process.env });
    uploadServer.listen({ onUnhandledRequest: "error" });
  });

  afterEach(() => uploadServer.resetHandlers());
  afterAll(() => { uploadServer.close(); rmSync(dir, { recursive: true, force: true }); });

  beforeEach(async () => {
    const { prisma } = await import("@/lib/db");
    await prisma.job.deleteMany();
    await prisma.upload.deleteMany();
    await prisma.platformConnection.deleteMany();
    resetConfigCache();
  });

  async function connectedUser() {
    const { prisma, ensureSeedUser } = await import("@/lib/db");
    const { encryptToken } = await import("@/lib/token-crypto");
    const user = await ensureSeedUser();
    await prisma.platformConnection.create({ data: {
      userId: user.id, platform: "tiktok", accessTokenEncrypted: encryptToken("access-token"),
      refreshTokenEncrypted: encryptToken("refresh-token"), accessTokenExpiresAt: new Date(Date.now() + 60_000), externalAccountId: "open-id-123",
    } });
    return user;
  }

  async function pendingTikTokJob(userId: string) {
    const { prisma } = await import("@/lib/db");
    const upload = await prisma.upload.create({
      data: {
        userId, title: "My Short", description: "A short clip", fileName: "clip.mp4", filePath: videoPath, fileSize: 11,
        jobs: { create: [{ platform: "tiktok", status: "pending" }] },
      },
      include: { jobs: true },
    });
    return upload.jobs[0];
  }

  it("initializes a SELF_ONLY post with the title and description, uploads video bytes, and returns its publish id", async () => {
    const user = await connectedUser();
    uploadServer.use(
      http.post(initUrl, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer access-token");
        await expect(request.json()).resolves.toMatchObject({
          post_info: { title: "My Short\nA short clip", privacy_level: "SELF_ONLY" },
          source_info: { source: "FILE_UPLOAD", video_size: 11, total_chunk_count: 1 },
        });
        return HttpResponse.json({ data: { publish_id: "publish-123", upload_url: "https://upload.tiktok.test/video/1" } });
      }),
      http.put("https://upload.tiktok.test/video/1", async ({ request }) => {
        expect(Buffer.from(await request.arrayBuffer()).toString()).toBe("video bytes");
        return new HttpResponse(null, { status: 201 });
      }),
    );
    const { TikTokAdapter } = await import("@/lib/adapters/tiktok-adapter");
    await expect(new TikTokAdapter().upload({ userId: user.id, title: "My Short", description: "A short clip", filePath: videoPath }))
      .resolves.toEqual({ url: "tiktok://publish/publish-123" });
  });

  it.each([429, 500])("classifies TikTok %i responses as retryable", async (status) => {
    const user = await connectedUser();
    uploadServer.use(http.post(initUrl, () => HttpResponse.json({ error: {} }, { status })));
    const { TikTokAdapter } = await import("@/lib/adapters/tiktok-adapter");
    await expect(new TikTokAdapter().upload({ userId: user.id, title: "My Short", description: "", filePath: videoPath }))
      .rejects.toMatchObject({ kind: "retryable" });
  });

  it("classifies TikTok authentication rejection as terminal", async () => {
    const user = await connectedUser();
    uploadServer.use(http.post(initUrl, () => HttpResponse.json({ error: {} }, { status: 401 })));
    const { TikTokAdapter } = await import("@/lib/adapters/tiktok-adapter");
    await expect(new TikTokAdapter().upload({ userId: user.id, title: "My Short", description: "", filePath: videoPath }))
      .rejects.toMatchObject({ kind: "terminal" });
  });

  it("hands a TikTok rate limit to the job engine for backoff", async () => {
    const user = await connectedUser();
    const job = await pendingTikTokJob(user.id);
    let calls = 0;
    uploadServer.use(http.post(initUrl, () => {
      calls += 1;
      return HttpResponse.json({ error: {} }, { status: 429 });
    }));
    const { createJobEngine } = await import("@/lib/job-engine");
    const { prisma } = await import("@/lib/db");
    const now = new Date("2026-01-01T00:00:00.000Z");
    const engine = createJobEngine({ clock: { now: () => now }, random: () => 0, backoffBaseMs: 1_000 });

    await engine.tick();
    await engine.tick();

    const stored = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(calls).toBe(1);
    expect(stored.status).toBe("pending");
    expect(stored.nextAttemptAt).toEqual(new Date(now.getTime() + 500));
  });

  it("does not retry a terminal TikTok authentication rejection", async () => {
    const user = await connectedUser();
    const job = await pendingTikTokJob(user.id);
    let calls = 0;
    uploadServer.use(http.post(initUrl, () => {
      calls += 1;
      return HttpResponse.json({ error: {} }, { status: 401 });
    }));
    const { createJobEngine } = await import("@/lib/job-engine");
    const { prisma } = await import("@/lib/db");
    const engine = createJobEngine({ clock: { now: () => new Date("2026-01-01T00:00:00.000Z") } });

    await engine.tick();
    await engine.tick();

    expect(calls).toBe(1);
    await expect(prisma.job.findUniqueOrThrow({ where: { id: job.id } })).resolves.toMatchObject({ status: "failed" });
  });
});
