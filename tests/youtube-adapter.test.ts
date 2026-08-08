import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { resetConfigCache } from "@/lib/config";
import { UNTRACKED_TRANSFER, type ResumableTransfer } from "@/lib/platform-adapter";

const uploadServer = setupServer();
const youtubeUploadUrl = "https://www.googleapis.com/upload/youtube/v3/videos";
const tiktokInitUrl = "https://open.tiktokapis.com/v2/post/publish/video/init/";
const tiktokStatusUrl = "https://open.tiktokapis.com/v2/post/publish/status/fetch/";

describe("YouTubeAdapter", () => {
  let dir: string;
  let videoPath: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "omnipost-youtube-adapter-"));
    process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
    process.env.YOUTUBE_CLIENT_ID = "client-id";
    process.env.YOUTUBE_CLIENT_SECRET = "client-secret";
    process.env.YOUTUBE_REDIRECT_URI = "http://localhost/api/platforms/youtube/callback";
    process.env.TIKTOK_CLIENT_KEY = "client-key";
    process.env.TIKTOK_CLIENT_SECRET = "client-secret";
    process.env.PUBLIC_BASE_URL = "https://omnipost.test";
    process.env.ACCESS_PASSWORD = "shared test password";
    process.env.TIKTOK_REDIRECT_URI = "https://omnipost.test/api/platforms/tiktok/callback";
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

  it("publishes one Job's override while a sibling sends shared metadata", async () => {
    const user = await connectedUser();
    const { prisma } = await import("@/lib/db");
    const { encryptToken } = await import("@/lib/token-crypto");
    await prisma.platformConnection.create({
      data: {
        userId: user.id,
        platform: "tiktok",
        accessTokenEncrypted: encryptToken("tiktok-access-token"),
        refreshTokenEncrypted: encryptToken("tiktok-refresh-token"),
        accessTokenExpiresAt: new Date(Date.now() + 60_000),
        externalAccountId: "open-id-123",
      },
    });
    const upload = await prisma.upload.create({
      data: {
        userId: user.id,
        title: "Shared title",
        description: "Shared description",
        fileName: "clip.mp4",
        filePath: videoPath,
        fileSize: 11,
        jobs: {
          create: [
            {
              platform: "youtube",
              status: "pending",
              titleOverride: "YouTube title",
              descriptionOverride: "YouTube description",
            },
            { platform: "tiktok", status: "pending" },
          ],
        },
      },
      include: { jobs: true },
    });
    uploadServer.use(
      http.post(youtubeUploadUrl, async ({ request }) => {
        await expect(request.json()).resolves.toMatchObject({
          snippet: {
            title: "YouTube title",
            description: "YouTube description",
          },
        });
        return new HttpResponse(null, {
          status: 200,
          headers: { Location: "https://upload.youtube.test/session/override" },
        });
      }),
      http.put("https://upload.youtube.test/session/override", () =>
        HttpResponse.json({ id: "video-override" }),
      ),
      http.post(tiktokInitUrl, async ({ request }) => {
        await expect(request.json()).resolves.toMatchObject({
          post_info: { title: "Shared title\n\nShared description" },
        });
        return HttpResponse.json({
          data: {
            publish_id: "publish-shared",
            upload_url: "https://upload.tiktok.test/video/shared",
          },
          error: { code: "ok" },
        });
      }),
      http.put("https://upload.tiktok.test/video/shared", () =>
        new HttpResponse(null, { status: 201 }),
      ),
      http.post(tiktokStatusUrl, () => HttpResponse.json({
        data: { status: "PUBLISH_COMPLETE" },
        error: { code: "ok" },
      })),
    );
    const { createJobEngine } = await import("@/lib/job-engine");

    await createJobEngine().tick();

    const jobs = await prisma.job.findMany({
      where: { uploadId: upload.id },
      orderBy: { platform: "asc" },
    });
    expect(jobs.map((job) => [job.platform, job.status, job.resultUrl])).toEqual([
      ["tiktok", "done", "tiktok://publish/publish-shared"],
      ["youtube", "done", "https://www.youtube.com/watch?v=video-override"],
    ]);
  });

  describe("chunked transfer", () => {
    const chunkSizeBytes = 10;
    const body = "0123456789abcdefghijklmno"; // 25 bytes: two full chunks and a short one
    const sessionUrl = "https://upload.youtube.test/session/chunked";
    const freshSessionUrl = "https://upload.youtube.test/session/fresh";
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

    function trackerSpy(resumable: ResumableTransfer | null = null) {
      return {
        resumable,
        begin: vi.fn<(sessionUrl: string) => Promise<void>>(async () => {}),
        record: vi.fn<(bytesUploaded: number) => Promise<void>>(async () => {}),
        forget: vi.fn<() => Promise<void>>(async () => {}),
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

    describe("resuming an interrupted transfer", () => {
      // A crashed attempt: the offset it managed to persist is deliberately
      // behind what YouTube turns out to be holding.
      const crashed: ResumableTransfer = { sessionUrl, bytesUploaded: 5 };

      // Answers the resume-query however the test wants, then behaves like a
      // normal session for the chunks that follow.
      function resumeWith(answer: () => Response) {
        const puts: { range: string | null; body: string }[] = [];
        // Both sessions accept chunks identically; only the resume-query
        // (which the fresh session never sees) and the resulting video id
        // tell them apart.
        const session = (videoId: string, onQuery?: () => Response) =>
          async ({ request }: { request: Request }) => {
            const range = request.headers.get("content-range");
            puts.push({ range, body: Buffer.from(await request.arrayBuffer()).toString() });
            if (onQuery && range === `bytes */${body.length}`) return onQuery();
            const end = Number(range?.match(/bytes (\d+)-(\d+)\//)?.[2] ?? 0);
            if (end + 1 >= body.length) return HttpResponse.json({ id: videoId });
            return new HttpResponse(null, { status: 308, headers: { Range: `bytes=0-${end}` } });
          };
        uploadServer.use(
          http.post(youtubeUploadUrl, () =>
            new HttpResponse(null, { status: 200, headers: { Location: freshSessionUrl } }),
          ),
          http.put(sessionUrl, session("video-resumed", answer)),
          http.put(freshSessionUrl, session("video-restarted")),
        );
        return puts;
      }

      it("asks YouTube what it holds and continues from that offset, not the stored one", async () => {
        const user = await connectedUser();
        const transfer = trackerSpy(crashed);
        // YouTube holds 15 bytes; the crashed attempt only persisted 5.
        const puts = resumeWith(() =>
          new HttpResponse(null, { status: 308, headers: { Range: "bytes=0-14" } }),
        );

        await expect((await adapter()).upload({
          userId: user.id,
          title: "My Short",
          description: "",
          filePath: chunkedPath,
          transfer,
        })).resolves.toEqual({ url: "https://www.youtube.com/watch?v=video-resumed" });

        expect(puts[0].range).toBe("bytes */25");
        expect(puts[0].body).toBe("");
        expect(puts[1].range).toBe("bytes 15-24/25");
        // No fresh session was started, so nothing already sent is re-sent.
        expect(transfer.begin).not.toHaveBeenCalled();
        expect(transfer.record).toHaveBeenCalledWith(15);
      });

      it("falls back to the persisted offset when the resume-query is unavailable", async () => {
        const user = await connectedUser();
        const transfer = trackerSpy(crashed);
        const puts = resumeWith(() => HttpResponse.json({ error: {} }, { status: 503 }));

        await expect((await adapter()).upload({
          userId: user.id,
          title: "My Short",
          description: "",
          filePath: chunkedPath,
          transfer,
        })).resolves.toEqual({ url: "https://www.youtube.com/watch?v=video-resumed" });

        expect(puts[0].range).toBe("bytes */25");
        expect(puts[1].range).toBe("bytes 5-14/25");
        expect(transfer.begin).not.toHaveBeenCalled();
      });

      it("falls back to the persisted offset when YouTube cannot be reached at all", async () => {
        const user = await connectedUser();
        const transfer = trackerSpy(crashed);
        const puts = resumeWith(() => HttpResponse.error());

        await expect((await adapter()).upload({
          userId: user.id,
          title: "My Short",
          description: "",
          filePath: chunkedPath,
          transfer,
        })).resolves.toEqual({ url: "https://www.youtube.com/watch?v=video-resumed" });

        expect(puts[1].range).toBe("bytes 5-14/25");
        expect(transfer.forget).not.toHaveBeenCalled();
      });

      it("keeps a job alive when the fallback offset meets a session YouTube has dropped", async () => {
        const user = await connectedUser();
        uploadServer.use(
          http.put(sessionUrl, ({ request }) => {
            // Unreachable for the query, gone for the chunk: without this
            // being retryable, the 404 would read as terminal and kill a
            // job whose next attempt would just start a new session.
            const range = request.headers.get("content-range");
            if (range === `bytes */${body.length}`) return HttpResponse.error();
            return HttpResponse.json({ error: {} }, { status: 404 });
          }),
        );

        await expect((await adapter()).upload({
          userId: user.id,
          title: "My Short",
          description: "",
          filePath: chunkedPath,
          transfer: { ...UNTRACKED_TRANSFER, resumable: crashed },
        })).rejects.toMatchObject({ kind: "retryable" });
      });

      it("starts a fresh session from zero when the stored one has expired", async () => {
        const user = await connectedUser();
        const transfer = trackerSpy(crashed);
        const puts = resumeWith(() => HttpResponse.json({ error: {} }, { status: 404 }));

        await expect((await adapter()).upload({
          userId: user.id,
          title: "My Short",
          description: "",
          filePath: chunkedPath,
          transfer,
        })).resolves.toEqual({ url: "https://www.youtube.com/watch?v=video-restarted" });

        // An expired session is a normal outcome, not a job failure: the
        // stale state is dropped and the video goes up from byte zero.
        expect(transfer.forget).toHaveBeenCalled();
        expect(transfer.begin).toHaveBeenCalledWith(freshSessionUrl);
        expect(puts[1].range).toBe("bytes 0-9/25");
      });

      it("completes without re-sending when YouTube already has the whole video", async () => {
        const user = await connectedUser();
        const transfer = trackerSpy(crashed);
        // The crash landed between YouTube accepting the last chunk and the
        // job recording its result; re-uploading would publish twice.
        const puts = resumeWith(() => HttpResponse.json({ id: "video-already-done" }));

        await expect((await adapter()).upload({
          userId: user.id,
          title: "My Short",
          description: "",
          filePath: chunkedPath,
          transfer,
        })).resolves.toEqual({ url: "https://www.youtube.com/watch?v=video-already-done" });

        expect(puts).toHaveLength(1);
        expect(transfer.begin).not.toHaveBeenCalled();
      });
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

  it("resumes a crashed job's transfer through the job engine, from YouTube's offset", async () => {
    const user = await connectedUser();
    const { prisma } = await import("@/lib/db");
    const interruptedUrl = "https://upload.youtube.test/session/interrupted";
    const upload = await prisma.upload.create({
      data: {
        userId: user.id,
        title: "My Short",
        description: "A short clip",
        fileName: "clip.mp4",
        filePath: videoPath,
        fileSize: 11,
        jobs: {
          // Crashed mid-transfer: the lease has lapsed with nothing
          // completed, and the offset it persisted lags what YouTube took.
          create: {
            platform: "youtube",
            status: "uploading",
            attempts: 1,
            leaseExpiresAt: new Date("2025-12-31T23:59:59.000Z"),
            uploadSessionUrl: interruptedUrl,
            bytesUploaded: BigInt(2),
          },
        },
      },
      include: { jobs: true },
    });

    const ranges: (string | null)[] = [];
    uploadServer.use(
      http.put(interruptedUrl, async ({ request }) => {
        const range = request.headers.get("content-range");
        ranges.push(range);
        if (range === "bytes */11") {
          return new HttpResponse(null, { status: 308, headers: { Range: "bytes=0-5" } });
        }
        expect(Buffer.from(await request.arrayBuffer()).toString()).toBe("bytes");
        return HttpResponse.json({ id: "video-resumed-e2e" });
      }),
    );
    const { createJobEngine } = await import("@/lib/job-engine");

    await createJobEngine({ clock: { now: () => new Date("2026-01-01T00:00:00.000Z") } }).tick();

    // No fresh session was requested (MSW would have errored on an
    // unhandled POST), and only the six bytes YouTube lacked were sent.
    expect(ranges).toEqual(["bytes */11", "bytes 6-10/11"]);
    const job = await prisma.job.findUniqueOrThrow({ where: { id: upload.jobs[0].id } });
    expect(job.status).toBe("done");
    expect(job.resultUrl).toBe("https://www.youtube.com/watch?v=video-resumed-e2e");
    expect(job.bytesUploaded).toBe(BigInt(11));
  });
});
