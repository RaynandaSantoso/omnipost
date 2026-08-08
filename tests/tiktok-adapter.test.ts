import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { resetConfigCache } from "@/lib/config";
import { UNTRACKED_TRANSFER } from "@/lib/platform-adapter";

const uploadServer = setupServer();
const initUrl = "https://open.tiktokapis.com/v2/post/publish/video/init/";
const statusUrl = "https://open.tiktokapis.com/v2/post/publish/status/fetch/";

describe("TikTokAdapter", () => {
  let dir: string;
  let videoPath: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "omnipost-tiktok-adapter-"));
    process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
    process.env.TIKTOK_CLIENT_KEY = "client-key";
    process.env.TIKTOK_CLIENT_SECRET = "client-secret";
    process.env.PUBLIC_BASE_URL = "https://omnipost.test";
    process.env.ACCESS_PASSWORD = "shared test password";
    process.env.TIKTOK_REDIRECT_URI =
      "https://omnipost.test/api/platforms/tiktok/callback";
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
    let statusRequests = 0;
    uploadServer.use(
      http.post(initUrl, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer access-token");
        expect(request.headers.get("content-type")).toBe(
          "application/json; charset=UTF-8",
        );
        await expect(request.json()).resolves.toMatchObject({
          post_info: { title: "My Short\n\nA short clip", privacy_level: "SELF_ONLY" },
          source_info: { source: "FILE_UPLOAD", video_size: 11, total_chunk_count: 1 },
        });
        return HttpResponse.json({ data: { publish_id: "publish-123", upload_url: "https://upload.tiktok.test/video/1" } });
      }),
      http.put("https://upload.tiktok.test/video/1", async ({ request }) => {
        expect(request.headers.get("content-length")).toBe("11");
        expect(request.headers.get("content-type")).toBe("video/mp4");
        expect(Buffer.from(await request.arrayBuffer()).toString()).toBe("video bytes");
        return new HttpResponse(null, { status: 201 });
      }),
      http.post(statusUrl, async ({ request }) => {
        statusRequests += 1;
        await expect(request.json()).resolves.toEqual({ publish_id: "publish-123" });
        return HttpResponse.json({
          data: { status: "PUBLISH_COMPLETE" },
          error: { code: "ok" },
        });
      }),
    );
    const { TikTokAdapter } = await import("@/lib/adapters/tiktok-adapter");
    await expect(new TikTokAdapter().upload({ userId: user.id, title: "My Short", description: "A short clip", filePath: videoPath, transfer: UNTRACKED_TRANSFER }))
      .resolves.toEqual({ url: "tiktok://publish/publish-123" });
    expect(statusRequests).toBe(1);
  });

  it("publishes a finished caption override without appending the shared description", async () => {
    const user = await connectedUser();
    const { prisma } = await import("@/lib/db");
    const upload = await prisma.upload.create({
      data: {
        userId: user.id,
        title: "Shared title",
        description: "Shared description",
        fileName: "clip.mp4",
        filePath: videoPath,
        fileSize: 11,
        jobs: {
          create: {
            platform: "tiktok",
            status: "pending",
            titleOverride: "Finished caption #shorts",
          },
        },
      },
      include: { jobs: true },
    });
    uploadServer.use(
      http.post(initUrl, async ({ request }) => {
        await expect(request.json()).resolves.toMatchObject({
          post_info: { title: "Finished caption #shorts" },
        });
        return HttpResponse.json({
          data: {
            publish_id: "publish-override",
            upload_url: "https://upload.tiktok.test/video/override",
          },
          error: { code: "ok" },
        });
      }),
      http.put("https://upload.tiktok.test/video/override", () =>
        new HttpResponse(null, { status: 201 }),
      ),
      http.post(statusUrl, () => HttpResponse.json({
        data: { status: "PUBLISH_COMPLETE" },
        error: { code: "ok" },
      })),
    );
    const { createJobEngine } = await import("@/lib/job-engine");

    await createJobEngine().tick();

    const job = await prisma.job.findUniqueOrThrow({
      where: { id: upload.jobs[0].id },
    });
    expect(job.status).toBe("done");
    expect(job.resultUrl).toBe("tiktok://publish/publish-override");
  });

  it.each([429, 500])("classifies TikTok %i responses as retryable", async (status) => {
    const user = await connectedUser();
    uploadServer.use(http.post(initUrl, () => HttpResponse.json({ error: {} }, { status })));
    const { TikTokAdapter } = await import("@/lib/adapters/tiktok-adapter");
    await expect(new TikTokAdapter().upload({ userId: user.id, title: "My Short", description: "", filePath: videoPath, transfer: UNTRACKED_TRANSFER }))
      .rejects.toMatchObject({ kind: "retryable" });
  });

  it("classifies TikTok authentication rejection as terminal", async () => {
    const user = await connectedUser();
    uploadServer.use(http.post(initUrl, () => HttpResponse.json({ error: {} }, { status: 401 })));
    const { TikTokAdapter } = await import("@/lib/adapters/tiktok-adapter");
    await expect(new TikTokAdapter().upload({ userId: user.id, title: "My Short", description: "", filePath: videoPath, transfer: UNTRACKED_TRANSFER }))
      .rejects.toMatchObject({ kind: "terminal" });
  });

  it.each([
    ["rate_limit_exceeded", "retryable"],
    ["internal_error", "retryable"],
    ["spam_risk_user_banned_from_posting", "terminal"],
    ["access_token_invalid", "terminal"],
  ] as const)("maps TikTok error code %s to %s", async (code, kind) => {
    const user = await connectedUser();
    uploadServer.use(
      http.post(initUrl, () =>
        HttpResponse.json({ error: { code, message: "TikTok rejected the request" } }),
      ),
    );
    const { TikTokAdapter } = await import("@/lib/adapters/tiktok-adapter");

    await expect(
      new TikTokAdapter().upload({
        userId: user.id,
        title: "My Short",
        description: "",
        filePath: videoPath,
        transfer: UNTRACKED_TRANSFER,
      }),
    ).rejects.toMatchObject({ kind, message: expect.stringContaining(code) });
  });

  it("uses the uploaded video's supported MIME type", async () => {
    const user = await connectedUser();
    const webmPath = path.join(dir, "clip.webm");
    writeFileSync(webmPath, "webm bytes");
    uploadServer.use(
      http.post(initUrl, () =>
        HttpResponse.json({
          data: {
            publish_id: "publish-webm",
            upload_url: "https://upload.tiktok.test/video/webm",
          },
          error: { code: "ok" },
        }),
      ),
      http.put("https://upload.tiktok.test/video/webm", ({ request }) => {
        expect(request.headers.get("content-type")).toBe("video/webm");
        return new HttpResponse(null, { status: 201 });
      }),
      http.post(statusUrl, () =>
        HttpResponse.json({
          data: { status: "PUBLISH_COMPLETE" },
          error: { code: "ok" },
        }),
      ),
    );
    const { TikTokAdapter } = await import("@/lib/adapters/tiktok-adapter");

    await expect(
      new TikTokAdapter().upload({
        userId: user.id,
        title: "My Short",
        description: "",
        filePath: webmPath,

        transfer: UNTRACKED_TRANSFER,
      }),
    ).resolves.toEqual({ url: "tiktok://publish/publish-webm" });
  });

  it.each([
    ["internal", "retryable"],
    ["spam_risk_text", "terminal"],
  ] as const)("maps final TikTok publish failure %s to %s", async (reason, kind) => {
    const user = await connectedUser();
    uploadServer.use(
      http.post(initUrl, () =>
        HttpResponse.json({
          data: {
            publish_id: "publish-failed",
            upload_url: "https://upload.tiktok.test/video/failed",
          },
          error: { code: "ok" },
        }),
      ),
      http.put(
        "https://upload.tiktok.test/video/failed",
        () => new HttpResponse(null, { status: 201 }),
      ),
      http.post(statusUrl, () =>
        HttpResponse.json({
          data: { status: "FAILED", fail_reason: reason },
          error: { code: "ok" },
        }),
      ),
    );
    const { TikTokAdapter } = await import("@/lib/adapters/tiktok-adapter");

    await expect(
      new TikTokAdapter().upload({
        userId: user.id,
        title: "My Short",
        description: "",
        filePath: videoPath,
        transfer: UNTRACKED_TRANSFER,
      }),
    ).rejects.toMatchObject({ kind, message: expect.stringContaining(reason) });
  });

  it("waits for TikTok processing to reach PUBLISH_COMPLETE", async () => {
    const user = await connectedUser();
    let statusRequests = 0;
    const sleeps: number[] = [];
    uploadServer.use(
      http.post(initUrl, () =>
        HttpResponse.json({
          data: {
            publish_id: "publish-processing",
            upload_url: "https://upload.tiktok.test/video/processing",
          },
          error: { code: "ok" },
        }),
      ),
      http.put(
        "https://upload.tiktok.test/video/processing",
        () => new HttpResponse(null, { status: 201 }),
      ),
      http.post(statusUrl, () => {
        statusRequests += 1;
        return HttpResponse.json({
          data: {
            status: statusRequests === 1 ? "PROCESSING_UPLOAD" : "PUBLISH_COMPLETE",
          },
          error: { code: "ok" },
        });
      }),
    );
    const { TikTokAdapter } = await import("@/lib/adapters/tiktok-adapter");
    const adapter = new TikTokAdapter({
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      maxStatusChecks: 2,
    });

    await expect(
      adapter.upload({
        userId: user.id,
        title: "My Short",
        description: "",
        filePath: videoPath,
        transfer: UNTRACKED_TRANSFER,
      }),
    ).resolves.toEqual({ url: "tiktok://publish/publish-processing" });
    expect(statusRequests).toBe(2);
    expect(sleeps).toEqual([2_000]);
  });

  it("retries a transient status check without starting a second post", async () => {
    const user = await connectedUser();
    let initRequests = 0;
    let statusRequests = 0;
    uploadServer.use(
      http.post(initUrl, () => {
        initRequests += 1;
        return HttpResponse.json({
          data: {
            publish_id: "publish-status-retry",
            upload_url: "https://upload.tiktok.test/video/status-retry",
          },
          error: { code: "ok" },
        });
      }),
      http.put(
        "https://upload.tiktok.test/video/status-retry",
        () => new HttpResponse(null, { status: 201 }),
      ),
      http.post(statusUrl, () => {
        statusRequests += 1;
        return statusRequests === 1
          ? HttpResponse.json(
              { error: { code: "rate_limit_exceeded" } },
              { status: 429 },
            )
          : HttpResponse.json({
              data: { status: "PUBLISH_COMPLETE" },
              error: { code: "ok" },
            });
      }),
    );
    const { TikTokAdapter } = await import("@/lib/adapters/tiktok-adapter");
    const adapter = new TikTokAdapter({
      sleep: async () => undefined,
      maxStatusChecks: 2,
    });

    await expect(
      adapter.upload({
        userId: user.id,
        title: "My Short",
        description: "",
        filePath: videoPath,
        transfer: UNTRACKED_TRANSFER,
      }),
    ).resolves.toEqual({ url: "tiktok://publish/publish-status-retry" });
    expect(initRequests).toBe(1);
    expect(statusRequests).toBe(2);
  });

  it("rejects a video above TikTok's single-chunk limit before contacting TikTok", async () => {
    const user = await connectedUser();
    const largeVideoPath = path.join(dir, "large.mp4");
    writeFileSync(largeVideoPath, "");
    truncateSync(largeVideoPath, 64 * 1024 * 1024 + 1);
    let requests = 0;
    uploadServer.use(
      http.all("*", () => {
        requests += 1;
        return HttpResponse.error();
      }),
    );
    const { TikTokAdapter } = await import("@/lib/adapters/tiktok-adapter");

    await expect(
      new TikTokAdapter().upload({
        userId: user.id,
        title: "My Short",
        description: "",
        filePath: largeVideoPath,

        transfer: UNTRACKED_TRANSFER,
      }),
    ).rejects.toMatchObject({
      kind: "terminal",
      message: expect.stringContaining("64 MB"),
    });
    expect(requests).toBe(0);
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
