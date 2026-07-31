import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { resetConfigCache } from "@/lib/config";
import { UNTRACKED_TRANSFER } from "@/lib/platform-adapter";

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

      transfer: UNTRACKED_TRANSFER,
    })).resolves.toEqual({ url: "https://www.youtube.com/watch?v=video-123" });
    expect(resumableUrl).toBeTruthy();
  });

  describe("chunked transfer", () => {
    const chunkSizeBytes = 10;
    const body = "0123456789abcdefghijklmno"; // 25 bytes: two full chunks and a short one
    const sessionUrl = "https://upload.youtube.test/session/chunked";
    let chunkedPath: string;

    beforeEach(() => {
      chunkedPath = path.join(dir, "chunked.mp4");
      writeFileSync(chunkedPath, body);
    });

    // Records every chunk YouTube sees, answering 308 until the last one.
    function acceptChunks(options: { confirmed?: (end: number) => number } = {}) {
      const chunks: { range: string | null; body: string }[] = [];
      uploadServer.use(
        http.post(youtubeUploadUrl, () =>
          new HttpResponse(null, { status: 200, headers: { Location: sessionUrl } }),
        ),
        http.put(sessionUrl, async ({ request }) => {
          const range = request.headers.get("content-range");
          const text = Buffer.from(await request.arrayBuffer()).toString();
          chunks.push({ range, body: text });
          const end = Number(range?.match(/bytes (\d+)-(\d+)\//)?.[2] ?? 0);
          if (end + 1 >= body.length) return HttpResponse.json({ id: "video-chunked" });
          const confirmed = options.confirmed?.(end) ?? end;
          return new HttpResponse(null, {
            status: 308,
            headers: { Range: `bytes=0-${confirmed}` },
          });
        }),
      );
      return chunks;
    }

    async function adapter(overrides = {}) {
      const { YouTubeAdapter } = await import("@/lib/adapters/youtube-adapter");
      return new YouTubeAdapter({ chunkSizeBytes, ...overrides });
    }

    function trackerSpy() {
      return {
        begin: vi.fn<(sessionUrl: string) => Promise<void>>(async () => {}),
        record: vi.fn<(bytesUploaded: number) => Promise<void>>(async () => {}),
      };
    }

    it("sends the video as Content-Range chunks and completes only on the final response", async () => {
      const user = await connectedUser();
      const chunks = acceptChunks();

      await expect((await adapter()).upload({
        userId: user.id,
        title: "My Short",
        description: "",
        filePath: chunkedPath,

        transfer: UNTRACKED_TRANSFER,
      })).resolves.toEqual({ url: "https://www.youtube.com/watch?v=video-chunked" });

      expect(chunks.map((chunk) => chunk.range)).toEqual([
        "bytes 0-9/25",
        "bytes 10-19/25",
        "bytes 20-24/25",
      ]);
      expect(chunks.map((chunk) => chunk.body).join("")).toBe(body);
    });

    it("persists the session URL before any bytes are sent, then each confirmed offset", async () => {
      const user = await connectedUser();
      const transfer = trackerSpy();
      let sentBeforeBegin = 0;
      const chunks = acceptChunks();
      transfer.begin.mockImplementation(async () => {
        sentBeforeBegin = chunks.length;
      });

      await (await adapter()).upload({
        userId: user.id,
        title: "My Short",
        description: "",
        filePath: chunkedPath,
        transfer,
      });

      expect(transfer.begin).toHaveBeenCalledWith(sessionUrl);
      expect(sentBeforeBegin).toBe(0);
      // Intermediate offsets, not just the final one: a crash between
      // chunks must leave the real confirmed offset behind.
      expect(transfer.record.mock.calls.map(([bytes]) => bytes)).toEqual([10, 20, 25]);
    });

    it("resumes from the offset YouTube confirms rather than the offset it sent", async () => {
      const user = await connectedUser();
      const transfer = trackerSpy();
      // YouTube acknowledges only half of the first chunk.
      const chunks = acceptChunks({ confirmed: (end) => (end === 9 ? 4 : end) });

      await (await adapter()).upload({
        userId: user.id,
        title: "My Short",
        description: "",
        filePath: chunkedPath,
        transfer,
      });

      expect(chunks[1].range).toBe("bytes 5-14/25");
      expect(transfer.record.mock.calls.map(([bytes]) => bytes)).toEqual([5, 15, 25]);
    });

    it("never reads more than one chunk of the file at a time", async () => {
      const user = await connectedUser();
      acceptChunks();
      const { openVideoFile } = await import("@/lib/video-file");
      const reads: number[] = [];
      const openFile = async (filePath: string) => {
        const file = await openVideoFile(filePath);
        return {
          size: file.size,
          async read(offset: number, length: number) {
            const bytes = await file.read(offset, length);
            reads.push(bytes.byteLength);
            return bytes;
          },
          close: () => file.close(),
        };
      };

      await (await adapter({ openFile })).upload({
        userId: user.id,
        title: "My Short",
        description: "",
        filePath: chunkedPath,

        transfer: UNTRACKED_TRANSFER,
      });

      expect(reads.length).toBeGreaterThan(1);
      expect(Math.max(...reads)).toBeLessThanOrEqual(chunkSizeBytes);
    });

    it("keeps a failed chunk retryable and does not report the job done", async () => {
      const user = await connectedUser();
      const transfer = trackerSpy();
      uploadServer.use(
        http.post(youtubeUploadUrl, () =>
          new HttpResponse(null, { status: 200, headers: { Location: sessionUrl } }),
        ),
        http.put(sessionUrl, ({ request }) => {
          const end = Number(request.headers.get("content-range")?.match(/-(\d+)\//)?.[1] ?? 0);
          if (end >= 19) return HttpResponse.json({ error: {} }, { status: 503 });
          return new HttpResponse(null, { status: 308, headers: { Range: `bytes=0-${end}` } });
        }),
      );

      await expect((await adapter()).upload({
        userId: user.id,
        title: "My Short",
        description: "",
        filePath: chunkedPath,
        transfer,
      })).rejects.toMatchObject({ kind: "retryable" });
      expect(transfer.record).toHaveBeenLastCalledWith(10);
    });

    it("gives up on a session that stops accepting new bytes", async () => {
      const user = await connectedUser();
      let puts = 0;
      uploadServer.use(
        http.post(youtubeUploadUrl, () =>
          new HttpResponse(null, { status: 200, headers: { Location: sessionUrl } }),
        ),
        // Always confirms the same offset: without a forward-progress guard
        // the adapter would re-send chunk one forever.
        http.put(sessionUrl, () => {
          puts += 1;
          return new HttpResponse(null, { status: 308, headers: { Range: "bytes=0-4" } });
        }),
      );

      await expect((await adapter()).upload({
        userId: user.id,
        title: "My Short",
        description: "",
        filePath: chunkedPath,
        transfer: UNTRACKED_TRANSFER,
      })).rejects.toMatchObject({ kind: "retryable" });
      expect(puts).toBe(2);
    });
  });

  it.each([429, 500])("classifies YouTube %i responses as retryable", async (status) => {
    const user = await connectedUser();
    uploadServer.use(http.post(youtubeUploadUrl, () => HttpResponse.json({ error: {} }, { status })));
    const { YouTubeAdapter } = await import("@/lib/adapters/youtube-adapter");

    await expect(new YouTubeAdapter().upload({ userId: user.id, title: "My Short", description: "", filePath: videoPath, transfer: UNTRACKED_TRANSFER }))
      .rejects.toMatchObject({ kind: "retryable" });
  });

  it("classifies a YouTube authentication rejection as terminal", async () => {
    const user = await connectedUser();
    uploadServer.use(http.post(youtubeUploadUrl, () => HttpResponse.json({ error: {} }, { status: 401 })));
    const { YouTubeAdapter } = await import("@/lib/adapters/youtube-adapter");

    await expect(new YouTubeAdapter().upload({ userId: user.id, title: "My Short", description: "", filePath: videoPath, transfer: UNTRACKED_TRANSFER }))
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

    await expect(new YouTubeAdapter().upload({ userId: user.id, title: "My Short", description: "", filePath: videoPath, transfer: UNTRACKED_TRANSFER }))
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

    await expect(new YouTubeAdapter().upload({ userId: user.id, title: "My Short", description: "", filePath: videoPath, transfer: UNTRACKED_TRANSFER }))
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
