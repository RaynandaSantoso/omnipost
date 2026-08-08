import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { resetConfigCache } from "@/lib/config";

// Instagram Login spreads one handshake across three hosts: the authorize
// screen belongs to instagram.com, the code exchange to api.instagram.com, and
// everything token- or account-shaped to graph.instagram.com. No Facebook host
// appears anywhere, which is the point of the flow — and `onUnhandledRequest:
// "error"` below turns any stray call to one into a failing test.
const authorizeOrigin = "https://www.instagram.com";
const codeExchangeUrl = "https://api.instagram.com/oauth/access_token";
const longLivedTokenUrl = "https://graph.instagram.com/access_token";
const refreshTokenUrl = "https://graph.instagram.com/refresh_access_token";
const accountUrl = "https://graph.instagram.com/me";
const oauthServer = setupServer();

const SIXTY_DAYS_SECONDS = 60 * 24 * 60 * 60;

// The three handlers a successful connect needs, so a test that is really
// about state handling or renewal doesn't restate the whole handshake.
function handshakeHandlers(options: {
  shortLivedToken?: string;
  longLivedToken?: string;
  accountId?: string;
  username?: string;
} = {}) {
  const {
    shortLivedToken = "short-lived-token",
    longLivedToken = "long-lived-token",
    accountId = "ig-123",
    username = "my.creator",
  } = options;
  return [
    http.post(codeExchangeUrl, () =>
      HttpResponse.json({ access_token: shortLivedToken, user_id: accountId }),
    ),
    http.get(longLivedTokenUrl, () =>
      HttpResponse.json({ access_token: longLivedToken, expires_in: SIXTY_DAYS_SECONDS }),
    ),
    http.get(accountUrl, () => HttpResponse.json({ id: accountId, username })),
  ];
}

describe("Instagram OAuth routes", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "omnipost-instagram-oauth-"));
    process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
    writeFileSync(path.join(dir, "test.db"), "");
    process.env.INSTAGRAM_APP_ID = "app-id";
    process.env.INSTAGRAM_APP_SECRET = "app-secret";
    process.env.PUBLIC_BASE_URL = "https://omnipost.test";
    process.env.ACCESS_PASSWORD = "shared test password";
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

  it("sends the operator to Instagram's own authorize screen", async () => {
    const { GET: start } = await import("@/app/api/platforms/instagram/connect/route");
    const authorizationUrl = new URL((await start()).headers.get("location")!);

    // Not facebook.com/dialog/oauth: this flow asks Instagram directly, so no
    // Facebook Page ever enters the picture.
    expect(authorizationUrl.origin).toBe(authorizeOrigin);
    expect(authorizationUrl.pathname).toBe("/oauth/authorize");
    expect(authorizationUrl.searchParams.get("client_id")).toBe("app-id");
    expect(authorizationUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      process.env.INSTAGRAM_REDIRECT_URI,
    );
    expect(authorizationUrl.searchParams.get("scope")).toBe(
      "instagram_business_basic,instagram_business_content_publish",
    );
    expect(authorizationUrl.searchParams.get("state")).toBeTruthy();
  });

  it("persists the Instagram account and its long-lived token", async () => {
    const { GET: start } = await import("@/app/api/platforms/instagram/connect/route");
    const { GET: callback } = await import("@/app/api/platforms/instagram/callback/route");
    const { decryptToken } = await import("@/lib/token-crypto");
    const { prisma } = await import("@/lib/db");
    const state = new URL((await start()).headers.get("location")!).searchParams.get("state");

    oauthServer.use(
      // A form POST, unlike the query-string GET the Facebook flow used.
      http.post(codeExchangeUrl, async ({ request }) => {
        const body = new URLSearchParams(await request.text());
        expect(body.get("client_id")).toBe("app-id");
        expect(body.get("client_secret")).toBe("app-secret");
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("redirect_uri")).toBe(process.env.INSTAGRAM_REDIRECT_URI);
        expect(body.get("code")).toBe("code-123");
        return HttpResponse.json({ access_token: "short-lived-token", user_id: 17841406994877984 });
      }),
      http.get(longLivedTokenUrl, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("grant_type")).toBe("ig_exchange_token");
        expect(url.searchParams.get("client_secret")).toBe("app-secret");
        expect(url.searchParams.get("access_token")).toBe("short-lived-token");
        return HttpResponse.json({ access_token: "long-lived-token", expires_in: SIXTY_DAYS_SECONDS });
      }),
      http.get(accountUrl, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("access_token")).toBe("long-lived-token");
        expect(url.searchParams.get("fields")).toBe("id,username");
        return HttpResponse.json({ id: "ig-123", username: "my.creator" });
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
    // Instagram Login issues one long-lived token that both renews itself and
    // authorizes publishing, so the two columns hold the same secret.
    expect(decryptToken(connection.accessTokenEncrypted)).toBe("long-lived-token");
    expect(decryptToken(connection.refreshTokenEncrypted)).toBe("long-lived-token");
    expect(connection.accessTokenExpiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("refuses to store a connection Instagram will not name an account for", async () => {
    const { GET: start } = await import("@/app/api/platforms/instagram/connect/route");
    const { GET: callback } = await import("@/app/api/platforms/instagram/callback/route");
    const { prisma } = await import("@/lib/db");
    const state = new URL((await start()).headers.get("location")!).searchParams.get("state");
    // The account read comes first: within one `use` call msw honours the
    // earliest matching handler, so this has to outrank the default below it.
    oauthServer.use(
      http.get(accountUrl, () => HttpResponse.json({ id: "ig-123" })),
      ...handshakeHandlers(),
    );

    const response = await callback(
      new Request(
        `https://omnipost.test/api/platforms/instagram/callback?code=code-123&state=${state}`,
      ),
    );

    expect(response.status).toBe(502);
    expect(await prisma.platformConnection.count()).toBe(0);
  });

  it("rejects missing, expired, replayed, and non-exact callback state before any Instagram call", async () => {
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
    oauthServer.use(...handshakeHandlers());
    await callback(new Request(`https://omnipost.test/api/platforms/instagram/callback?code=x&state=${replayState}`));
    expect((await callback(new Request(`https://omnipost.test/api/platforms/instagram/callback?code=x&state=${replayState}`))).status).toBe(400);
    expect(outboundRequests).toBe(0);
  });

  it("reports status, renews an expiring token, and disconnects", async () => {
    const { prisma, ensureSeedUser } = await import("@/lib/db");
    const { decryptToken, encryptToken } = await import("@/lib/token-crypto");
    const { accessTokenForInstagram } = await import("@/lib/instagram-oauth");
    const { GET, DELETE } = await import("@/app/api/platforms/instagram/route");
    const user = await ensureSeedUser();
    const connection = await prisma.platformConnection.create({
      data: {
        userId: user.id,
        platform: "instagram",
        accessTokenEncrypted: encryptToken("stale-token"),
        refreshTokenEncrypted: encryptToken("stale-token"),
        accessTokenExpiresAt: new Date(Date.now() - 1),
        externalAccountId: "ig-123",
        externalAccountLabel: "my.creator",
      },
    });
    oauthServer.use(
      http.get(refreshTokenUrl, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("grant_type")).toBe("ig_refresh_token");
        expect(url.searchParams.get("access_token")).toBe("stale-token");
        return HttpResponse.json({ access_token: "fresh-token", expires_in: SIXTY_DAYS_SECONDS });
      }),
    );

    expect(await (await GET()).json()).toMatchObject({
      connected: true,
      externalAccountLabel: "my.creator",
      reconnectNeeded: false,
    });
    // Renewing costs exactly one call: no account re-read, which is why an
    // unhandled request to graph.instagram.com/me would fail this test.
    await expect(accessTokenForInstagram(user.id)).resolves.toBe("fresh-token");
    const updated = await prisma.platformConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(decryptToken(updated.accessTokenEncrypted)).toBe("fresh-token");
    expect(decryptToken(updated.refreshTokenEncrypted)).toBe("fresh-token");

    // Instagram Login has no revoke endpoint, so disconnect is local only.
    // Any outbound call here would fail the test as an unhandled request.
    expect((await DELETE()).status).toBe(204);
    expect((await (await GET()).json()).connected).toBe(false);
    expect(await prisma.platformConnection.count()).toBe(0);
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
        accessTokenEncrypted: encryptToken("soon-expiring-token"),
        refreshTokenEncrypted: encryptToken("soon-expiring-token"),
        accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        externalAccountId: "ig-123",
      },
    });
    oauthServer.use(
      http.get(refreshTokenUrl, () =>
        HttpResponse.json({ access_token: "renewed-token", expires_in: SIXTY_DAYS_SECONDS }),
      ),
    );

    await expect(accessTokenForInstagram(user.id)).resolves.toBe("renewed-token");
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
        accessTokenEncrypted: encryptToken("expired-token"),
        refreshTokenEncrypted: encryptToken("expired-token"),
        accessTokenExpiresAt: new Date(Date.now() - 1),
        externalAccountId: "ig-123",
        externalAccountLabel: "my.creator",
      },
    });
    oauthServer.use(http.get(refreshTokenUrl, () => new HttpResponse(null, { status: 401 })));

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
        accessTokenEncrypted: encryptToken("expired-token"),
        refreshTokenEncrypted: encryptToken("expired-token"),
        accessTokenExpiresAt: new Date(Date.now() - 1),
        externalAccountId: "ig-123",
      },
    });
    oauthServer.use(http.get(refreshTokenUrl, () => new HttpResponse(null, { status: 503 })));

    await expect(accessTokenForInstagram(user.id)).rejects.toMatchObject({
      kind: "retryable",
    });
    await expect(instagramConnectionStatus(user.id)).resolves.toMatchObject({
      reconnectNeeded: false,
    });
  });
});
