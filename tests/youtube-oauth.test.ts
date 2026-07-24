import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "@/lib/config";

describe("YouTube OAuth routes", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "omnipost-youtube-oauth-"));
    process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
    writeFileSync(path.join(dir, "test.db"), "");
    process.env.YOUTUBE_CLIENT_ID = "client-id";
    process.env.YOUTUBE_CLIENT_SECRET = "client-secret";
    process.env.YOUTUBE_REDIRECT_URI = "http://localhost/api/platforms/youtube/callback";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    resetConfigCache();
    execFileSync("npx", ["--no-install", "prisma", "migrate", "deploy"], {
      stdio: "inherit",
      env: process.env,
    });
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    resetConfigCache();
    const { prisma } = await import("@/lib/db");
    await prisma.oAuthState.deleteMany();
    await prisma.platformConnection.deleteMany();
    vi.unstubAllGlobals();
  });

  it("persists encrypted credentials after a state-validated callback", async () => {
    const { GET: start } = await import("@/app/api/platforms/youtube/connect/route");
    const { GET: callback } = await import("@/app/api/platforms/youtube/callback/route");
    const { prisma } = await import("@/lib/db");

    const started = await start();
    expect(started.status).toBe(307);
    const authorizationUrl = new URL(started.headers.get("location")!);
    expect(authorizationUrl.origin).toBe("https://accounts.google.com");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      process.env.YOUTUBE_REDIRECT_URI,
    );
    const state = authorizationUrl.searchParams.get("state");
    expect(state).toBeTruthy();

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            access_token: "plain-access-token",
            refresh_token: "plain-refresh-token",
            expires_in: 3600,
          }),
        )
        .mockResolvedValueOnce(Response.json({ items: [{ id: "channel-123" }] })),
    );

    const completed = await callback(
      new Request(
        `http://localhost/api/platforms/youtube/callback?code=code-123&state=${state}`,
      ),
    );

    expect(completed.status).toBe(307);
    expect(completed.headers.get("location")).toBe("http://localhost/?youtube=connected");
    const connection = await prisma.platformConnection.findFirstOrThrow();
    expect(connection.channelId).toBe("channel-123");
    expect(connection.accessTokenEncrypted).not.toContain("plain-access-token");
    expect(connection.refreshTokenEncrypted).not.toContain("plain-refresh-token");
  });

  it("rejects a callback with missing or invalid state without contacting Google", async () => {
    const { GET: callback } = await import("@/app/api/platforms/youtube/callback/route");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const response = await callback(
      new Request("http://localhost/api/platforms/youtube/callback?code=code-123&state=forged"),
    );

    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a callback that arrives at a URI other than the configured redirect URI", async () => {
    const { GET: start } = await import("@/app/api/platforms/youtube/connect/route");
    const { GET: callback } = await import("@/app/api/platforms/youtube/callback/route");
    const state = new URL((await start()).headers.get("location")!).searchParams.get("state");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const response = await callback(
      new Request(`http://other-host/api/platforms/youtube/callback?code=code-123&state=${state}`),
    );

    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a same-origin callback at a different path", async () => {
    const { GET: start } = await import("@/app/api/platforms/youtube/connect/route");
    const { GET: callback } = await import("@/app/api/platforms/youtube/callback/route");
    const state = new URL((await start()).headers.get("location")!).searchParams.get("state");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const response = await callback(
      new Request(`http://localhost/api/platforms/youtube/other?code=code-123&state=${state}`),
    );

    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects tampered encrypted tokens rather than decrypting them", async () => {
    const { decryptToken, encryptToken } = await import("@/lib/token-crypto");
    const ciphertext = encryptToken("plain-token");
    const parts = ciphertext.split(".");
    const tag = parts[3];
    parts[3] = `${tag.startsWith("A") ? "B" : "A"}${tag.slice(1)}`;
    const tampered = parts.join(".");

    expect(ciphertext).not.toContain("plain-token");
    expect(() => decryptToken(tampered)).toThrow(/could not be decrypted/);
  });

  it("reports a connected channel and disconnects it", async () => {
    const { prisma, ensureSeedUser } = await import("@/lib/db");
    const { encryptToken } = await import("@/lib/token-crypto");
    const { GET, DELETE } = await import("@/app/api/platforms/youtube/route");
    const user = await ensureSeedUser();
    await prisma.platformConnection.create({
      data: {
        userId: user.id,
        platform: "youtube",
        accessTokenEncrypted: encryptToken("access"),
        refreshTokenEncrypted: encryptToken("refresh"),
        accessTokenExpiresAt: new Date(Date.now() + 60_000),
        channelId: "my-channel",
      },
    });

    expect(await (await GET()).json()).toEqual({
      connected: true,
      channelId: "my-channel",
      reconnectNeeded: false,
    });
    expect((await DELETE()).status).toBe(204);
    expect(await (await GET()).json()).toEqual({
      connected: false,
      channelId: null,
      reconnectNeeded: false,
    });
  });

  it("refreshes an expired token and persists the replacement encrypted", async () => {
    const { prisma, ensureSeedUser } = await import("@/lib/db");
    const { encryptToken } = await import("@/lib/token-crypto");
    const { accessTokenForYouTube } = await import("@/lib/youtube-oauth");
    const user = await ensureSeedUser();
    const connection = await prisma.platformConnection.create({
      data: {
        userId: user.id,
        platform: "youtube",
        accessTokenEncrypted: encryptToken("expired-access"),
        refreshTokenEncrypted: encryptToken("old-refresh"),
        accessTokenExpiresAt: new Date(Date.now() - 1),
        channelId: "my-channel",
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ access_token: "fresh-access", expires_in: 3600 })),
    );

    await expect(accessTokenForYouTube(user.id)).resolves.toBe("fresh-access");
    const updated = await prisma.platformConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(updated.accessTokenEncrypted).not.toContain("fresh-access");
    expect(updated.refreshError).toBeNull();
  });

  it("marks the connection as needing reconnect when refresh fails", async () => {
    const { prisma, ensureSeedUser } = await import("@/lib/db");
    const { encryptToken } = await import("@/lib/token-crypto");
    const { accessTokenForYouTube, youtubeConnectionStatus } = await import("@/lib/youtube-oauth");
    const user = await ensureSeedUser();
    await prisma.platformConnection.create({
      data: {
        userId: user.id,
        platform: "youtube",
        accessTokenEncrypted: encryptToken("expired-access"),
        refreshTokenEncrypted: encryptToken("old-refresh"),
        accessTokenExpiresAt: new Date(Date.now() - 1),
        channelId: "my-channel",
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));

    await expect(accessTokenForYouTube(user.id)).rejects.toThrow("reconnecting");
    await expect(youtubeConnectionStatus(user.id)).resolves.toEqual({
      connected: true,
      channelId: "my-channel",
      reconnectNeeded: true,
    });
  });

  it("never logs OAuth tokens or the encryption key while connecting", async () => {
    const { GET: start } = await import("@/app/api/platforms/youtube/connect/route");
    const { GET: callback } = await import("@/app/api/platforms/youtube/callback/route");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const state = new URL((await start()).headers.get("location")!).searchParams.get("state");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ access_token: "never-log-access", refresh_token: "never-log-refresh", expires_in: 3600 }))
        .mockResolvedValueOnce(Response.json({ items: [{ id: "channel-123" }] })),
    );

    await callback(new Request(`http://localhost/api/platforms/youtube/callback?code=code-123&state=${state}`));

    const output = log.mock.calls.flat().join(" ");
    expect(output).not.toContain("never-log-access");
    expect(output).not.toContain("never-log-refresh");
    expect(output).not.toContain(process.env.TOKEN_ENCRYPTION_KEY!);
    log.mockRestore();
  });

  it("refuses to boot with a stored connection but no encryption key", async () => {
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
        channelId: "my-channel",
      },
    });
    const key = process.env.TOKEN_ENCRYPTION_KEY;
    const runtime = process.env.NEXT_RUNTIME;
    delete process.env.TOKEN_ENCRYPTION_KEY;
    process.env.NEXT_RUNTIME = "nodejs";
    resetConfigCache();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    const { register } = await import("@/instrumentation");
    await register();

    expect(exit).toHaveBeenCalledWith(1);
    expect(log.mock.calls.flat().join(" ")).not.toContain(key!);
    exit.mockRestore();
    log.mockRestore();
    process.env.TOKEN_ENCRYPTION_KEY = key;
    process.env.NEXT_RUNTIME = runtime;
    resetConfigCache();
  });
});
