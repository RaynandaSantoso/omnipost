import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { resetConfigCache } from "@/lib/config";

const graphOrigin = "https://graph.facebook.com";
const tokenUrl = `${graphOrigin}/v23.0/oauth/access_token`;
const accountsUrl = `${graphOrigin}/v23.0/me/accounts`;
const permissionsUrl = `${graphOrigin}/v23.0/me/permissions`;
const oauthServer = setupServer();

describe("Instagram OAuth routes", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "omnipost-instagram-oauth-"));
    process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
    writeFileSync(path.join(dir, "test.db"), "");
    process.env.INSTAGRAM_APP_ID = "app-id";
    process.env.INSTAGRAM_APP_SECRET = "app-secret";
    process.env.PUBLIC_BASE_URL = "https://omnipost.test";
    process.env.INSTAGRAM_REDIRECT_URI =
      "https://omnipost.test/api/platforms/instagram/callback";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
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

  it("names every missing Instagram OAuth setting only when connect is attempted", async () => {
    const { GET: start } = await import("@/app/api/platforms/instagram/connect/route");
    const appId = process.env.INSTAGRAM_APP_ID;
    const appSecret = process.env.INSTAGRAM_APP_SECRET;
    delete process.env.INSTAGRAM_APP_ID;
    delete process.env.INSTAGRAM_APP_SECRET;
    resetConfigCache();

    try {
      const response = await start();
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({
        error:
          "Instagram OAuth requires missing configuration: INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET",
      });
    } finally {
      process.env.INSTAGRAM_APP_ID = appId;
      process.env.INSTAGRAM_APP_SECRET = appSecret;
      resetConfigCache();
    }
  });

  it("persists the eligible Instagram account and encrypted Meta credentials", async () => {
    const { GET: start } = await import("@/app/api/platforms/instagram/connect/route");
    const { GET: callback } = await import("@/app/api/platforms/instagram/callback/route");
    const { decryptToken } = await import("@/lib/token-crypto");
    const { prisma } = await import("@/lib/db");
    const authorizationUrl = new URL((await start()).headers.get("location")!);
    const state = authorizationUrl.searchParams.get("state");

    expect(authorizationUrl.origin).toBe("https://www.facebook.com");
    expect(authorizationUrl.searchParams.get("client_id")).toBe("app-id");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      process.env.INSTAGRAM_REDIRECT_URI,
    );
    expect(authorizationUrl.searchParams.get("scope")).toContain(
      "instagram_content_publish",
    );

    oauthServer.use(
      http.get(tokenUrl, ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("grant_type") === "fb_exchange_token") {
          expect(url.searchParams.get("fb_exchange_token")).toBe("short-user-token");
          return HttpResponse.json({ access_token: "long-user-token", expires_in: 5_184_000 });
        }
        expect(url.searchParams.get("code")).toBe("code-123");
        expect(url.searchParams.get("client_secret")).toBe("app-secret");
        return HttpResponse.json({ access_token: "short-user-token", expires_in: 3600 });
      }),
      http.get(accountsUrl, ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer long-user-token");
        return HttpResponse.json({
          data: [
            {
              access_token: "page-access-token",
              instagram_business_account: { id: "ig-123", username: "my.creator" },
            },
          ],
        });
      }),
    );

    const response = await callback(
      new Request(
        `https://omnipost.test/api/platforms/instagram/callback?code=code-123&state=${state}`,
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://omnipost.test/?instagram=connected",
    );
    const connection = await prisma.platformConnection.findFirstOrThrow();
    expect(connection.platform).toBe("instagram");
    expect(connection.externalAccountId).toBe("ig-123");
    expect(connection.externalAccountLabel).toBe("my.creator");
    expect(decryptToken(connection.accessTokenEncrypted)).toBe("page-access-token");
    expect(decryptToken(connection.refreshTokenEncrypted)).toBe("long-user-token");
    expect(connection.accessTokenExpiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("rejects a personal or unlinked account with setup guidance and persists nothing", async () => {
    const { GET: start } = await import("@/app/api/platforms/instagram/connect/route");
    const { GET: callback } = await import("@/app/api/platforms/instagram/callback/route");
    const { prisma } = await import("@/lib/db");
    const state = new URL((await start()).headers.get("location")!).searchParams.get("state");
    oauthServer.use(
      http.get(tokenUrl, ({ request }) =>
        HttpResponse.json(
          new URL(request.url).searchParams.has("code")
            ? { access_token: "short-user-token", expires_in: 3600 }
            : { access_token: "long-user-token", expires_in: 5_184_000 },
        ),
      ),
      http.get(accountsUrl, () => HttpResponse.json({ data: [{ id: "page-1" }] })),
    );

    const response = await callback(
      new Request(
        `https://omnipost.test/api/platforms/instagram/callback?code=code-123&state=${state}`,
      ),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/Business or Creator.*Facebook Page/i),
    });
    expect(await prisma.platformConnection.count()).toBe(0);
  });

  it("follows Meta pagination to find a linked professional account", async () => {
    const { GET: start } = await import("@/app/api/platforms/instagram/connect/route");
    const { GET: callback } = await import("@/app/api/platforms/instagram/callback/route");
    const { prisma } = await import("@/lib/db");
    const state = new URL((await start()).headers.get("location")!).searchParams.get("state");
    oauthServer.use(
      http.get(tokenUrl, ({ request }) => HttpResponse.json(
        new URL(request.url).searchParams.has("code")
          ? { access_token: "short-user-token", expires_in: 3600 }
          : { access_token: "long-user-token", expires_in: 5_184_000 },
      )),
      http.get(accountsUrl, ({ request }) => {
        const after = new URL(request.url).searchParams.get("after");
        return after === "next-page"
          ? HttpResponse.json({ data: [{
              access_token: "page-access-token",
              instagram_business_account: { id: "ig-later", username: "later.creator" },
            }] })
          : HttpResponse.json({
              data: [{ id: "page-without-instagram" }],
              paging: { next: `${accountsUrl}?after=next-page` },
            });
      }),
    );

    const response = await callback(new Request(
      `https://omnipost.test/api/platforms/instagram/callback?code=code-123&state=${state}`,
    ));

    expect(response.status).toBe(307);
    await expect(prisma.platformConnection.findFirstOrThrow()).resolves.toMatchObject({
      externalAccountId: "ig-later",
      externalAccountLabel: "later.creator",
    });
  });

  it("rejects missing, expired, replayed, and non-exact callback state before Meta calls", async () => {
    const { GET: start } = await import("@/app/api/platforms/instagram/connect/route");
    const { GET: callback } = await import("@/app/api/platforms/instagram/callback/route");
    const { prisma } = await import("@/lib/db");
    let outboundRequests = 0;
    oauthServer.use(http.all("*", () => { outboundRequests += 1; return HttpResponse.error(); }));

    expect((await callback(new Request("https://omnipost.test/api/platforms/instagram/callback?code=x"))).status).toBe(400);
    expect((await callback(new Request("https://omnipost.test/api/platforms/instagram/callback?code=x&state=forged"))).status).toBe(400);

    const expiredState = new URL((await start()).headers.get("location")!).searchParams.get("state")!;
    await prisma.oAuthState.update({
      where: { value: expiredState },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    expect((await callback(new Request(`https://omnipost.test/api/platforms/instagram/callback?code=x&state=${expiredState}`))).status).toBe(400);

    const state = new URL((await start()).headers.get("location")!).searchParams.get("state");
    expect((await callback(new Request(`https://other.test/api/platforms/instagram/callback?code=x&state=${state}`))).status).toBe(400);

    const replayState = new URL((await start()).headers.get("location")!).searchParams.get("state");
    oauthServer.use(
      http.get(tokenUrl, ({ request }) => HttpResponse.json(
        new URL(request.url).searchParams.has("code")
          ? { access_token: "short", expires_in: 3600 }
          : { access_token: "long", expires_in: 5_184_000 },
      )),
      http.get(accountsUrl, () => HttpResponse.json({ data: [] })),
    );
    await callback(new Request(`https://omnipost.test/api/platforms/instagram/callback?code=x&state=${replayState}`));
    expect((await callback(new Request(`https://omnipost.test/api/platforms/instagram/callback?code=x&state=${replayState}`))).status).toBe(400);
    expect(outboundRequests).toBe(0);
  });

  it("reports status, refreshes expired credentials, persists replacements, and disconnects", async () => {
    const { prisma, ensureSeedUser } = await import("@/lib/db");
    const { decryptToken, encryptToken } = await import("@/lib/token-crypto");
    const { accessTokenForInstagram } = await import("@/lib/instagram-oauth");
    const { GET, DELETE } = await import("@/app/api/platforms/instagram/route");
    const user = await ensureSeedUser();
    let revoked = false;
    const connection = await prisma.platformConnection.create({
      data: {
        userId: user.id,
        platform: "instagram",
        accessTokenEncrypted: encryptToken("expired-page-token"),
        refreshTokenEncrypted: encryptToken("old-user-token"),
        accessTokenExpiresAt: new Date(Date.now() - 1),
        externalAccountId: "ig-123",
        externalAccountLabel: "my.creator",
      },
    });
    oauthServer.use(
      http.get(tokenUrl, ({ request }) => {
        expect(new URL(request.url).searchParams.get("fb_exchange_token")).toBe("old-user-token");
        return HttpResponse.json({ access_token: "fresh-user-token", expires_in: 5_184_000 });
      }),
      http.get(accountsUrl, () => HttpResponse.json({
        data: [{ access_token: "fresh-page-token", instagram_business_account: { id: "ig-123", username: "my.creator" } }],
      })),
      http.delete(permissionsUrl, ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer fresh-user-token");
        revoked = true;
        return HttpResponse.json({ success: true });
      }),
    );

    expect(await (await GET()).json()).toMatchObject({
      connected: true,
      externalAccountLabel: "my.creator",
      reconnectNeeded: false,
    });
    await expect(accessTokenForInstagram(user.id)).resolves.toBe("fresh-page-token");
    const updated = await prisma.platformConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(decryptToken(updated.accessTokenEncrypted)).toBe("fresh-page-token");
    expect(decryptToken(updated.refreshTokenEncrypted)).toBe("fresh-user-token");
    expect((await DELETE()).status).toBe(204);
    expect(revoked).toBe(true);
    expect((await (await GET()).json()).connected).toBe(false);
  });

  it("renews a token before it expires", async () => {
    const { prisma, ensureSeedUser } = await import("@/lib/db");
    const { encryptToken } = await import("@/lib/token-crypto");
    const { accessTokenForInstagram } = await import("@/lib/instagram-oauth");
    const user = await ensureSeedUser();
    await prisma.platformConnection.create({
      data: {
        userId: user.id,
        platform: "instagram",
        accessTokenEncrypted: encryptToken("soon-expiring-page-token"),
        refreshTokenEncrypted: encryptToken("valid-user-token"),
        accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        externalAccountId: "ig-123",
      },
    });
    oauthServer.use(
      http.get(tokenUrl, () => HttpResponse.json({ access_token: "renewed-user-token", expires_in: 5_184_000 })),
      http.get(accountsUrl, () => HttpResponse.json({ data: [{
        access_token: "renewed-page-token",
        instagram_business_account: { id: "ig-123", username: "my.creator" },
      }] })),
    );

    await expect(accessTokenForInstagram(user.id)).resolves.toBe("renewed-page-token");
  });

  it("marks the connection reconnect-needed when renewal fails", async () => {
    const { prisma, ensureSeedUser } = await import("@/lib/db");
    const { encryptToken } = await import("@/lib/token-crypto");
    const { accessTokenForInstagram, instagramConnectionStatus } = await import("@/lib/instagram-oauth");
    const user = await ensureSeedUser();
    await prisma.platformConnection.create({
      data: {
        userId: user.id,
        platform: "instagram",
        accessTokenEncrypted: encryptToken("expired-page-token"),
        refreshTokenEncrypted: encryptToken("old-user-token"),
        accessTokenExpiresAt: new Date(Date.now() - 1),
        externalAccountId: "ig-123",
        externalAccountLabel: "my.creator",
      },
    });
    oauthServer.use(http.get(tokenUrl, () => new HttpResponse(null, { status: 401 })));

    await expect(accessTokenForInstagram(user.id)).rejects.toThrow("reconnecting");
    await expect(instagramConnectionStatus(user.id)).resolves.toMatchObject({ reconnectNeeded: true });
  });

  it("leaves the connection healthy when renewal fails transiently", async () => {
    const { prisma, ensureSeedUser } = await import("@/lib/db");
    const { encryptToken } = await import("@/lib/token-crypto");
    const {
      accessTokenForInstagram,
      instagramConnectionStatus,
    } = await import("@/lib/instagram-oauth");
    const user = await ensureSeedUser();
    await prisma.platformConnection.create({
      data: {
        userId: user.id,
        platform: "instagram",
        accessTokenEncrypted: encryptToken("expired-page-token"),
        refreshTokenEncrypted: encryptToken("old-user-token"),
        accessTokenExpiresAt: new Date(Date.now() - 1),
        externalAccountId: "ig-123",
      },
    });
    oauthServer.use(http.get(tokenUrl, () => new HttpResponse(null, { status: 503 })));

    await expect(accessTokenForInstagram(user.id)).rejects.toMatchObject({
      kind: "retryable",
    });
    await expect(instagramConnectionStatus(user.id)).resolves.toMatchObject({
      reconnectNeeded: false,
    });
  });
});
