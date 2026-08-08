import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { resetConfigCache } from "@/lib/config";
import { UNTRACKED_TRANSFER } from "@/lib/platform-adapter";

const graphServer = setupServer();
const graphBaseUrl = "https://graph.instagram.com/v23.0";

describe("InstagramAdapter", () => {
  let dir: string;
  let videoPath: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "omnipost-instagram-adapter-"));
    const dbPath = path.join(dir, "test.db");
    writeFileSync(dbPath, "");
    videoPath = path.join(dir, "clip.mp4");
    writeFileSync(videoPath, "video bytes");
    process.env.DATABASE_URL = `file:${dbPath}`;
    process.env.PUBLIC_BASE_URL = "https://omnipost.test";
    process.env.INSTAGRAM_APP_ID = "instagram-app-id";
    process.env.INSTAGRAM_APP_SECRET = "instagram-app-secret";
    process.env.INSTAGRAM_REDIRECT_URI = "https://omnipost.test/api/platforms/instagram/callback";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    resetConfigCache();
    execFileSync("npx", ["--no-install", "prisma", "migrate", "deploy"], {
      stdio: "inherit",
      env: process.env,
    });
    graphServer.listen({ onUnhandledRequest: "error" });
  });

  afterEach(() => graphServer.resetHandlers());
  afterAll(() => {
    graphServer.close();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const { prisma } = await import("@/lib/db");
    await prisma.job.deleteMany();
    await prisma.upload.deleteMany();
    await prisma.platformConnection.deleteMany();
    resetConfigCache();
  });

  async function connectedUpload() {
    const { ensureSeedUser, prisma } = await import("@/lib/db");
    const { encryptToken } = await import("@/lib/token-crypto");
    const user = await ensureSeedUser();
    await prisma.platformConnection.create({
      data: {
        userId: user.id,
        platform: "instagram",
        accessTokenEncrypted: encryptToken("page-token"),
        refreshTokenEncrypted: encryptToken("user-token"),
        // A freshly issued 60-day token: comfortably outside the renewal
        // window, so these tests exercise publishing and not credential
        // renewal. A test that wants renewal moves the expiry itself.
        accessTokenExpiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
        externalAccountId: "ig-user-123",
        externalAccountLabel: "my.creator",
      },
    });
    const upload = await prisma.upload.create({
      data: {
        userId: user.id,
        title: "My Reel",
        description: "A short clip",
        fileName: "clip.mp4",
        filePath: videoPath,
        fileSize: 11,
      },
    });
    return { user, upload };
  }

  function metadataFor(userId: string, uploadId: string) {
    return {
      uploadId,
      userId,
      title: "My Reel",
      description: "A short clip",
      filePath: videoPath,
      transfer: UNTRACKED_TRANSFER,
    };
  }

  it("creates a Reel container from the signed video URL, waits until ready, then publishes it", async () => {
    const { user, upload } = await connectedUpload();
    const statuses = ["IN_PROGRESS", "FINISHED"];
    const sleeps: number[] = [];
    graphServer.use(
      http.post(`${graphBaseUrl}/ig-user-123/media`, async ({ request }) => {
        const form = await request.formData();
        expect(form.get("media_type")).toBe("REELS");
        expect(form.get("caption")).toBe("My Reel\nA short clip");
        expect(form.get("share_to_feed")).toBeNull();
        expect(form.get("access_token")).toBe("page-token");
        const videoUrl = new URL(String(form.get("video_url")));
        expect(videoUrl.origin).toBe("https://omnipost.test");
        expect(videoUrl.pathname).toBe(`/api/uploads/${upload.id}/file`);
        expect(videoUrl.searchParams.get("token")).toMatch(/^v1\./);
        return HttpResponse.json({ id: "container-123" });
      }),
      http.get(`${graphBaseUrl}/container-123`, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("fields")).toBe("status_code,status");
        expect(url.searchParams.get("access_token")).toBe("page-token");
        return HttpResponse.json({ status_code: statuses.shift(), status: "Processing" });
      }),
      http.post(`${graphBaseUrl}/ig-user-123/media_publish`, async ({ request }) => {
        const form = await request.formData();
        expect(form.get("creation_id")).toBe("container-123");
        expect(form.get("access_token")).toBe("page-token");
        return HttpResponse.json({ id: "media-456" });
      }),
    );

    const { InstagramAdapter } = await import("@/lib/adapters/instagram-adapter");
    await expect(new InstagramAdapter({
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
      maxStatusChecks: 2,
    }).upload(metadataFor(user.id, upload.id))).resolves.toEqual({
      url: "instagram://media/media-456",
    });
    expect(sleeps).toEqual([5_000]);
  });

  it.each([429, 500])("classifies an Instagram HTTP %i response as retryable", async (status) => {
    const { user, upload } = await connectedUpload();
    graphServer.use(
      http.post(`${graphBaseUrl}/ig-user-123/media`, () =>
        HttpResponse.json({ error: { message: "Meta unavailable" } }, { status })),
    );
    const { InstagramAdapter } = await import("@/lib/adapters/instagram-adapter");

    await expect(
      new InstagramAdapter().upload(metadataFor(user.id, upload.id)),
    ).rejects.toMatchObject({ kind: "retryable" });
  });

  it("classifies a transient network failure as retryable", async () => {
    const { user, upload } = await connectedUpload();
    graphServer.use(
      http.post(`${graphBaseUrl}/ig-user-123/media`, () => HttpResponse.error()),
    );
    const { InstagramAdapter } = await import("@/lib/adapters/instagram-adapter");

    await expect(
      new InstagramAdapter().upload(metadataFor(user.id, upload.id)),
    ).rejects.toMatchObject({ kind: "retryable" });
  });

  it.each(["ERROR", "EXPIRED"])("classifies the %s processing state as terminal", async (statusCode) => {
    const { user, upload } = await connectedUpload();
    graphServer.use(
      http.post(`${graphBaseUrl}/ig-user-123/media`, () =>
        HttpResponse.json({ id: "container-failed" })),
      http.get(`${graphBaseUrl}/container-failed`, () =>
        HttpResponse.json({
          status_code: statusCode,
          status: "Media download has failed",
        })),
    );
    const { InstagramAdapter } = await import("@/lib/adapters/instagram-adapter");

    await expect(
      new InstagramAdapter().upload(metadataFor(user.id, upload.id)),
    ).rejects.toMatchObject({
      kind: "terminal",
      message: expect.stringContaining("Media download has failed"),
    });
  });

  it("stops polling a media-fetch timeout as an actionable terminal failure", async () => {
    const { user, upload } = await connectedUpload();
    graphServer.use(
      http.post(`${graphBaseUrl}/ig-user-123/media`, () =>
        HttpResponse.json({ id: "container-slow" })),
      http.get(`${graphBaseUrl}/container-slow`, () =>
        HttpResponse.json({ status_code: "IN_PROGRESS", status: "Processing" })),
    );
    const { InstagramAdapter } = await import("@/lib/adapters/instagram-adapter");

    await expect(new InstagramAdapter({ maxStatusChecks: 1 }).upload(
      metadataFor(user.id, upload.id),
    )).rejects.toMatchObject({
      kind: "terminal",
      message: expect.stringMatching(/timed out.*public media URL/i),
    });
  });

  it("classifies authentication rejection as terminal", async () => {
    const { user, upload } = await connectedUpload();
    graphServer.use(
      http.post(`${graphBaseUrl}/ig-user-123/media`, () =>
        HttpResponse.json({ error: { code: 190, message: "Invalid OAuth token" } }, { status: 401 })),
    );
    const { InstagramAdapter } = await import("@/lib/adapters/instagram-adapter");

    await expect(
      new InstagramAdapter().upload(metadataFor(user.id, upload.id)),
    ).rejects.toMatchObject({
      kind: "terminal",
      message: expect.stringContaining("needs reconnecting"),
    });
  });

  it("keeps a transient credential-renewal outage retryable", async () => {
    const { user, upload } = await connectedUpload();
    const { prisma } = await import("@/lib/db");
    await prisma.platformConnection.update({
      where: { userId_platform: { userId: user.id, platform: "instagram" } },
      data: { accessTokenExpiresAt: new Date(Date.now() - 1) },
    });
    graphServer.use(
      http.get("https://graph.instagram.com/refresh_access_token", () =>
        new HttpResponse(null, { status: 503 })),
    );
    const { InstagramAdapter } = await import("@/lib/adapters/instagram-adapter");
    const { instagramConnectionStatus } = await import("@/lib/instagram-oauth");

    await expect(
      new InstagramAdapter().upload(metadataFor(user.id, upload.id)),
    ).rejects.toMatchObject({ kind: "retryable" });
    await expect(instagramConnectionStatus(user.id)).resolves.toMatchObject({
      reconnectNeeded: false,
    });
  });

  it("hands a Meta rate limit to the job engine for existing backoff", async () => {
    const { upload } = await connectedUpload();
    const { prisma } = await import("@/lib/db");
    const job = await prisma.job.create({
      data: { uploadId: upload.id, platform: "instagram", status: "pending" },
    });
    let calls = 0;
    graphServer.use(
      http.post(`${graphBaseUrl}/ig-user-123/media`, () => {
        calls += 1;
        return HttpResponse.json({ error: { code: 4, message: "Rate limited" } }, { status: 400 });
      }),
    );
    const { createJobEngine } = await import("@/lib/job-engine");
    const now = new Date("2026-01-01T00:00:00.000Z");
    const engine = createJobEngine({
      clock: { now: () => now },
      random: () => 0,
      backoffBaseMs: 1_000,
    });

    await engine.tick();
    await engine.tick();

    const stored = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(calls).toBe(1);
    expect(stored.status).toBe("pending");
    expect(stored.nextAttemptAt).toEqual(new Date(now.getTime() + 500));
  });

  it("does not automatically retry a terminal Instagram processing failure", async () => {
    const { upload } = await connectedUpload();
    const { prisma } = await import("@/lib/db");
    const job = await prisma.job.create({
      data: { uploadId: upload.id, platform: "instagram", status: "pending" },
    });
    let createCalls = 0;
    graphServer.use(
      http.post(`${graphBaseUrl}/ig-user-123/media`, () => {
        createCalls += 1;
        return HttpResponse.json({ id: "container-rejected" });
      }),
      http.get(`${graphBaseUrl}/container-rejected`, () =>
        HttpResponse.json({ status_code: "ERROR", status: "Unsupported video format" })),
    );
    const { createJobEngine } = await import("@/lib/job-engine");
    const engine = createJobEngine();

    await engine.tick();
    await engine.tick();

    const stored = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(createCalls).toBe(1);
    expect(stored.status).toBe("failed");
    expect(stored.error).toContain("Unsupported video format");
  });
});
