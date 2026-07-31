import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { resetConfigCache } from "@/lib/config";

const tokenUrl = "https://open.tiktokapis.com/v2/oauth/token/";
const userInfoUrl = "https://open.tiktokapis.com/v2/user/info/";
const oauthServer = setupServer();

describe("TikTok OAuth routes", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "omnipost-tiktok-oauth-"));
    process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
    writeFileSync(path.join(dir, "test.db"), "");
    process.env.TIKTOK_CLIENT_KEY = "client-key";
    process.env.TIKTOK_CLIENT_SECRET = "client-secret";
    process.env.TIKTOK_REDIRECT_URI = "http://localhost/api/platforms/tiktok/callback";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    resetConfigCache();
    execFileSync("npx", ["--no-install", "prisma", "migrate", "deploy"], {
      stdio: "inherit",
      env: process.env,
    });
    oauthServer.listen({ onUnhandledRequest: "error" });
  });

  afterAll(() => {
    oauthServer.close();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    resetConfigCache();
    const { prisma } = await import("@/lib/db");
    await prisma.oAuthState.deleteMany();
    await prisma.platformConnection.deleteMany();
    oauthServer.resetHandlers();
  });

  it("names only the missing TikTok OAuth configuration", async () => {
    const { GET: start } = await import("@/app/api/platforms/tiktok/connect/route");
    const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
    delete process.env.TIKTOK_CLIENT_SECRET;
    resetConfigCache();

    try {
      const response = await start();
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe(
        "TikTok OAuth requires missing configuration: TIKTOK_CLIENT_SECRET",
      );
    } finally {
      process.env.TIKTOK_CLIENT_SECRET = clientSecret;
      resetConfigCache();
    }
  });

  it("persists encrypted credentials after a state-validated callback", async () => {
    const { GET: start } = await import("@/app/api/platforms/tiktok/connect/route");
    const { GET: callback } = await import("@/app/api/platforms/tiktok/callback/route");
    const { prisma } = await import("@/lib/db");

    const started = await start();
    expect(started.status).toBe(307);
    const authorizationUrl = new URL(started.headers.get("location")!);
    expect(authorizationUrl.origin).toBe("https://www.tiktok.com");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      process.env.TIKTOK_REDIRECT_URI,
    );
    expect(authorizationUrl.searchParams.get("client_key")).toBe("client-key");
    const state = authorizationUrl.searchParams.get("state");
    expect(state).toBeTruthy();

    oauthServer.use(
      http.post(tokenUrl, async ({ request }) => {
        const form = await request.formData();
        expect(form.get("code")).toBe("code-123");
        expect(form.get("client_key")).toBe("client-key");
        expect(form.get("client_secret")).toBe("client-secret");
        expect(form.get("redirect_uri")).toBe(process.env.TIKTOK_REDIRECT_URI);
        expect(form.get("grant_type")).toBe("authorization_code");
        return HttpResponse.json({
          access_token: "plain-access-token",
          refresh_token: "plain-refresh-token",
          expires_in: 86400,
          open_id: "open-id-123",
        });
      }),
      http.get(userInfoUrl, ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer plain-access-token");
        expect(new URL(request.url).searchParams.get("fields")).toBe("open_id,display_name");
        return HttpResponse.json({
          data: { user: { open_id: "open-id-123", display_name: "My TikTok" } },
        });
      }),
    );

    const completed = await callback(
      new Request(
        `http://localhost/api/platforms/tiktok/callback?code=code-123&state=${state}`,
      ),
    );

    expect(completed.status).toBe(307);
    expect(completed.headers.get("location")).toBe("http://localhost/?tiktok=connected");
    const connection = await prisma.platformConnection.findFirstOrThrow();
    expect(connection.platform).toBe("tiktok");
    expect(connection.externalAccountId).toBe("open-id-123");
    expect(connection.externalAccountLabel).toBe("My TikTok");
    expect(connection.accessTokenEncrypted).not.toContain("plain-access-token");
    expect(connection.refreshTokenEncrypted).not.toContain("plain-refresh-token");
  });

  it("rejects a callback with missing or invalid state without contacting TikTok", async () => {
    const { GET: callback } = await import("@/app/api/platforms/tiktok/callback/route");
    let outboundRequests = 0;
    oauthServer.use(
      http.all("*", () => {
        outboundRequests += 1;
        return HttpResponse.error();
      }),
    );

    const response = await callback(
      new Request("http://localhost/api/platforms/tiktok/callback?code=code-123&state=forged"),
    );

    expect(response.status).toBe(400);
    expect(outboundRequests).toBe(0);
  });

  it("rejects a callback that arrives at a URI other than the configured redirect URI", async () => {
    const { GET: start } = await import("@/app/api/platforms/tiktok/connect/route");
    const { GET: callback } = await import("@/app/api/platforms/tiktok/callback/route");
    const state = new URL((await start()).headers.get("location")!).searchParams.get("state");
    let outboundRequests = 0;
    oauthServer.use(
      http.all("*", () => {
        outboundRequests += 1;
        return HttpResponse.error();
      }),
    );

    const response = await callback(
      new Request(`http://other-host/api/platforms/tiktok/callback?code=code-123&state=${state}`),
    );

    expect(response.status).toBe(400);
    expect(outboundRequests).toBe(0);
  });

  it("rejects a same-origin callback at a different path", async () => {
    const { GET: start } = await import("@/app/api/platforms/tiktok/connect/route");
    const { GET: callback } = await import("@/app/api/platforms/tiktok/callback/route");
    const state = new URL((await start()).headers.get("location")!).searchParams.get("state");
    let outboundRequests = 0;
    oauthServer.use(
      http.all("*", () => {
        outboundRequests += 1;
        return HttpResponse.error();
      }),
    );

    const response = await callback(
      new Request(`http://localhost/api/platforms/tiktok/other?code=code-123&state=${state}`),
    );

    expect(response.status).toBe(400);
    expect(outboundRequests).toBe(0);
  });

  it("reports a connected account and disconnects it", async () => {
    const { prisma, ensureSeedUser } = await import("@/lib/db");
    const { encryptToken } = await import("@/lib/token-crypto");
    const { GET, DELETE } = await import("@/app/api/platforms/tiktok/route");
    const user = await ensureSeedUser();
    await prisma.platformConnection.create({
      data: {
        userId: user.id,
        platform: "tiktok",
        accessTokenEncrypted: encryptToken("access"),
        refreshTokenEncrypted: encryptToken("refresh"),
        accessTokenExpiresAt: new Date(Date.now() + 60_000),
        externalAccountId: "open-id-123",
        externalAccountLabel: "My TikTok",
      },
    });

    expect(await (await GET()).json()).toEqual({
      connected: true,
      externalAccountId: "open-id-123",
      externalAccountLabel: "My TikTok",
      reconnectNeeded: false,
    });
    expect((await DELETE()).status).toBe(204);
    expect(await (await GET()).json()).toEqual({
      connected: false,
      externalAccountId: null,
      externalAccountLabel: null,
      reconnectNeeded: false,
    });
  });

  it("refreshes an expired token and persists the replacement encrypted", async () => {
    const { prisma, ensureSeedUser } = await import("@/lib/db");
    const { encryptToken } = await import("@/lib/token-crypto");
    const { accessTokenForTikTok } = await import("@/lib/tiktok-oauth");
    const user = await ensureSeedUser();
    const connection = await prisma.platformConnection.create({
      data: {
        userId: user.id,
        platform: "tiktok",
        accessTokenEncrypted: encryptToken("expired-access"),
        refreshTokenEncrypted: encryptToken("old-refresh"),
        accessTokenExpiresAt: new Date(Date.now() - 1),
        externalAccountId: "open-id-123",
      },
    });
    oauthServer.use(
      http.post(tokenUrl, async ({ request }) => {
        const form = await request.formData();
        expect(form.get("refresh_token")).toBe("old-refresh");
        expect(form.get("grant_type")).toBe("refresh_token");
        return HttpResponse.json({
          access_token: "fresh-access",
          refresh_token: "fresh-refresh",
          expires_in: 86400,
        });
      }),
    );

    await expect(accessTokenForTikTok(user.id)).resolves.toBe("fresh-access");
    const updated = await prisma.platformConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(updated.accessTokenEncrypted).not.toContain("fresh-access");
    expect(updated.refreshError).toBeNull();
  });

  it("marks the connection as needing reconnect when refresh fails", async () => {
    const { prisma, ensureSeedUser } = await import("@/lib/db");
    const { encryptToken } = await import("@/lib/token-crypto");
    const { accessTokenForTikTok, tiktokConnectionStatus } = await import("@/lib/tiktok-oauth");
    const user = await ensureSeedUser();
    await prisma.platformConnection.create({
      data: {
        userId: user.id,
        platform: "tiktok",
        accessTokenEncrypted: encryptToken("expired-access"),
        refreshTokenEncrypted: encryptToken("old-refresh"),
        accessTokenExpiresAt: new Date(Date.now() - 1),
        externalAccountId: "open-id-123",
      },
    });
    oauthServer.use(
      http.post(tokenUrl, () => new HttpResponse(null, { status: 401 })),
    );

    await expect(accessTokenForTikTok(user.id)).rejects.toThrow("reconnecting");
    await expect(tiktokConnectionStatus(user.id)).resolves.toEqual({
      connected: true,
      externalAccountId: "open-id-123",
      externalAccountLabel: null,
      reconnectNeeded: true,
    });
  });

  it("never logs OAuth tokens or the encryption key while connecting", async () => {
    const { GET: start } = await import("@/app/api/platforms/tiktok/connect/route");
    const { GET: callback } = await import("@/app/api/platforms/tiktok/callback/route");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const state = new URL((await start()).headers.get("location")!).searchParams.get("state");
    oauthServer.use(
      http.post(tokenUrl, () =>
        HttpResponse.json({
          access_token: "never-log-access",
          refresh_token: "never-log-refresh",
          expires_in: 86400,
          open_id: "open-id-123",
        }),
      ),
      http.get(userInfoUrl, () =>
        HttpResponse.json({ data: { user: { open_id: "open-id-123" } } }),
      ),
    );

    await callback(new Request(`http://localhost/api/platforms/tiktok/callback?code=code-123&state=${state}`));

    const output = log.mock.calls.flat().join(" ");
    expect(output).not.toContain("never-log-access");
    expect(output).not.toContain("never-log-refresh");
    expect(output).not.toContain(process.env.TOKEN_ENCRYPTION_KEY!);
    log.mockRestore();
  });
});
