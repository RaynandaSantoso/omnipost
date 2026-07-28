import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { resetConfigCache } from "@/lib/config";

const uploadServer = setupServer();
const youtubeUploadUrl = "https://www.googleapis.com/upload/youtube/v3/videos";

describe("YouTubeAdapter", () => {
  let dir: string;
  let videoPath: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "omnipost-youtube-adapter-"));
    process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
    process.env.YOUTUBE_CLIENT_ID = "client-id";
    process.env.YOUTUBE_CLIENT_SECRET = "client-secret";
    process.env.YOUTUBE_REDIRECT_URI = "http://localhost/api/platforms/youtube/callback";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    resetConfigCache();
    writeFileSync(path.join(dir, "test.db"), "");
    videoPath = path.join(dir, "clip.mp4");
    writeFileSync(videoPath, "video bytes");
    execFileSync("npx", ["--no-install", "prisma", "migrate", "deploy"], {
      stdio: "inherit",
      env: process.env,
    });
    uploadServer.listen({ onUnhandledRequest: "error" });
  });

  afterEach(() => uploadServer.resetHandlers());

  afterAll(() => {
    uploadServer.close();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const { prisma } = await import("@/lib/db");
    await prisma.platformConnection.deleteMany();
    resetConfigCache();
  });

  async function connectedUser(expiresAt = new Date(Date.now() + 60_000)) {
    const { prisma, ensureSeedUser } = await import("@/lib/db");
    const { encryptToken } = await import("@/lib/token-crypto");
    const user = await ensureSeedUser();
    await prisma.platformConnection.create({
      data: {
        userId: user.id,
        platform: "youtube",
        accessTokenEncrypted: encryptToken("access-token"),
        refreshTokenEncrypted: encryptToken("refresh-token"),
        accessTokenExpiresAt: expiresAt,
        externalAccountId: "channel-123",
      },
    });
    return user;
  }

  it("uploads the title, description, and video bytes and returns the published link", async () => {
    const user = await connectedUser();
    let resumableUrl = "";
    uploadServer.use(
      http.post(youtubeUploadUrl, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer access-token");
        expect(new URL(request.url).searchParams.get("uploadType")).toBe("resumable");
        await expect(request.json()).resolves.toEqual({
          snippet: { title: "My Short", description: "A short clip" },
          status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
        });
        resumableUrl = "https://upload.youtube.test/session/1";
        return new HttpResponse(null, { status: 200, headers: { Location: resumableUrl } });
      }),
      http.put("https://upload.youtube.test/session/1", async ({ request }) => {
        expect(request.headers.get("content-type")).toBe("video/mp4");
        expect(Buffer.from(await request.arrayBuffer()).toString()).toBe("video bytes");
        return HttpResponse.json({ id: "video-123" });
      }),
    );

    const { YouTubeAdapter } = await import("@/lib/adapters/youtube-adapter");
    await expect(new YouTubeAdapter().upload({
      userId: user.id,
      title: "My Short",
      description: "A short clip",
      filePath: videoPath,
    })).resolves.toEqual({ url: "https://www.youtube.com/watch?v=video-123" });
    expect(resumableUrl).toBeTruthy();
  });

  it.each([429, 500])("classifies YouTube %i responses as retryable", async (status) => {
    const user = await connectedUser();
    uploadServer.use(http.post(youtubeUploadUrl, () => HttpResponse.json({ error: {} }, { status })));
    const { YouTubeAdapter } = await import("@/lib/adapters/youtube-adapter");

    await expect(new YouTubeAdapter().upload({ userId: user.id, title: "My Short", description: "", filePath: videoPath }))
      .rejects.toMatchObject({ kind: "retryable" });
  });

  it("classifies a YouTube authentication rejection as terminal", async () => {
    const user = await connectedUser();
    uploadServer.use(http.post(youtubeUploadUrl, () => HttpResponse.json({ error: {} }, { status: 401 })));
    const { YouTubeAdapter } = await import("@/lib/adapters/youtube-adapter");

    await expect(new YouTubeAdapter().upload({ userId: user.id, title: "My Short", description: "", filePath: videoPath }))
      .rejects.toMatchObject({ kind: "terminal" });
  });

  it("classifies a rejected credential refresh as terminal", async () => {
    const user = await connectedUser(new Date(Date.now() - 1));
    uploadServer.use(
      http.post("https://oauth2.googleapis.com/token", () =>
        HttpResponse.json({ error: "invalid_grant" }, { status: 401 }),
      ),
    );
    const { YouTubeAdapter } = await import("@/lib/adapters/youtube-adapter");

    await expect(new YouTubeAdapter().upload({ userId: user.id, title: "My Short", description: "", filePath: videoPath }))
      .rejects.toMatchObject({ kind: "terminal" });
  });

  it("refreshes an expired connection before starting the upload", async () => {
    const user = await connectedUser(new Date(Date.now() - 1));
    uploadServer.use(
      http.post("https://oauth2.googleapis.com/token", async ({ request }) => {
        expect(await request.text()).toContain("refresh_token=refresh-token");
        return HttpResponse.json({ access_token: "refreshed-token", expires_in: 3600 });
      }),
      http.post(youtubeUploadUrl, ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer refreshed-token");
        return new HttpResponse(null, { status: 200, headers: { Location: "https://upload.youtube.test/session/2" } });
      }),
      http.put("https://upload.youtube.test/session/2", () => HttpResponse.json({ id: "video-456" })),
    );
    const { YouTubeAdapter } = await import("@/lib/adapters/youtube-adapter");

    await expect(new YouTubeAdapter().upload({ userId: user.id, title: "My Short", description: "", filePath: videoPath }))
      .resolves.toEqual({ url: "https://www.youtube.com/watch?v=video-456" });
  });

  it("hands an MSW-faked rate limit to the job engine for backoff", async () => {
    const user = await connectedUser();
    const { prisma } = await import("@/lib/db");
    const upload = await prisma.upload.create({
      data: {
        userId: user.id,
        title: "My Short",
        description: "A short clip",
        fileName: "clip.mp4",
        filePath: videoPath,
        fileSize: 11,
        jobs: { create: { platform: "youtube", status: "pending" } },
      },
      include: { jobs: true },
    });
    uploadServer.use(http.post(youtubeUploadUrl, () => HttpResponse.json({ error: {} }, { status: 429 })));
    const { createJobEngine } = await import("@/lib/job-engine");
    const now = new Date("2026-01-01T00:00:00.000Z");
    const engine = createJobEngine({
      clock: { now: () => now },
      random: () => 0,
      backoffBaseMs: 1_000,
    });

    await engine.tick();

    const job = await prisma.job.findUniqueOrThrow({ where: { id: upload.jobs[0].id } });
    expect(job.status).toBe("pending");
    expect(job.error).toContain("429");
    expect(job.nextAttemptAt).toEqual(new Date(now.getTime() + 500));
  });
});
