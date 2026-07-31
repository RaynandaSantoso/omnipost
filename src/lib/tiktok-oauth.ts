import { randomBytes } from "node:crypto";
import { getConfig } from "@/lib/config";
import { prisma } from "@/lib/db";
import type { Platform } from "@/lib/platform";
import { decryptToken, encryptToken } from "@/lib/token-crypto";

const AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/";
const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const USER_INFO_URL = "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name";
const STATE_TTL_MS = 10 * 60 * 1000;
export const TIKTOK_PLATFORM = "tiktok" satisfies Platform;

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
};

function getValidatedTikTokOAuthConfig() {
  const config = getConfig();
  const required = [
    ["TIKTOK_CLIENT_KEY", config.TIKTOK_CLIENT_KEY],
    ["TIKTOK_CLIENT_SECRET", config.TIKTOK_CLIENT_SECRET],
    ["TIKTOK_REDIRECT_URI", config.TIKTOK_REDIRECT_URI],
  ] as const;
  const missing = required.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`TikTok OAuth requires missing configuration: ${missing.join(", ")}`);
  }
  const validated = config as Required<
    Pick<typeof config, "TIKTOK_CLIENT_KEY" | "TIKTOK_CLIENT_SECRET" | "TIKTOK_REDIRECT_URI">
  > &
    typeof config;
  const redirect = new URL(validated.TIKTOK_REDIRECT_URI);
  if (redirect.search || redirect.hash || redirect.username || redirect.password) {
    throw new Error("TIKTOK_REDIRECT_URI must not include query parameters, a fragment, or credentials");
  }
  return validated;
}

async function json(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

async function fetchTikTokUser(accessToken: string): Promise<{ id: string; label: string | null } | null> {
  const response = await fetch(USER_INFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  const body = (await json(response)) as {
    data?: { user?: { open_id?: string; display_name?: string } };
  } | null;
  const id = body?.data?.user?.open_id;
  if (!response.ok || !id) return null;
  return { id, label: body?.data?.user?.display_name ?? null };
}

export async function startTikTokConnect(userId: string): Promise<string> {
  const config = getValidatedTikTokOAuthConfig();
  // Reading the key here makes a misconfigured new connection fail before
  // the user is sent away to TikTok.
  encryptToken("key-check");
  const state = randomBytes(32).toString("base64url");
  await prisma.oAuthState.create({
    data: {
      userId,
      value: state,
      redirectUri: config.TIKTOK_REDIRECT_URI,
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    },
  });
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_key: config.TIKTOK_CLIENT_KEY,
    redirect_uri: config.TIKTOK_REDIRECT_URI,
    response_type: "code",
    scope: "user.info.basic,video.publish",
    state,
  }).toString();
  return url.toString();
}

export async function completeTikTokConnect(requestUrl: string, code: string, state: string): Promise<void> {
  const config = getValidatedTikTokOAuthConfig();
  const received = new URL(requestUrl);
  const configured = new URL(config.TIKTOK_REDIRECT_URI);
  // Query parameters are issued by TikTok, so compare the actual callback
  // destination rather than the full URL including code/state.
  received.search = "";
  received.hash = "";
  if (received.href !== configured.href) {
    throw new Error("OAuth callback redirect URI does not exactly match TIKTOK_REDIRECT_URI");
  }

  const saved = await prisma.oAuthState.findUnique({ where: { value: state } });
  if (!saved || saved.expiresAt <= new Date() || saved.redirectUri !== config.TIKTOK_REDIRECT_URI) {
    throw new Error("OAuth state is invalid or expired");
  }
  // Consume before outbound calls: replaying a callback must never exchange
  // its authorization code twice.
  await prisma.oAuthState.delete({ where: { id: saved.id } });

  const tokenResponse = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_key: config.TIKTOK_CLIENT_KEY,
      client_secret: config.TIKTOK_CLIENT_SECRET,
      redirect_uri: config.TIKTOK_REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
  const tokens = (await json(tokenResponse)) as TokenResponse | null;
  if (!tokenResponse.ok || !tokens?.access_token || !tokens.refresh_token || !tokens.expires_in) {
    throw new Error("TikTok could not complete the connection");
  }
  const account = await fetchTikTokUser(tokens.access_token);
  if (!account) {
    throw new Error("TikTok did not return an account for this connection");
  }

  await prisma.platformConnection.upsert({
    where: { userId_platform: { userId: saved.userId, platform: TIKTOK_PLATFORM } },
    create: {
      userId: saved.userId,
      platform: TIKTOK_PLATFORM,
      accessTokenEncrypted: encryptToken(tokens.access_token),
      refreshTokenEncrypted: encryptToken(tokens.refresh_token),
      accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      externalAccountId: account.id,
      externalAccountLabel: account.label,
    },
    update: {
      accessTokenEncrypted: encryptToken(tokens.access_token),
      refreshTokenEncrypted: encryptToken(tokens.refresh_token),
      accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      externalAccountId: account.id,
      externalAccountLabel: account.label,
      refreshError: null,
    },
  });
}

export async function tiktokConnectionStatus(userId: string) {
  const connection = await prisma.platformConnection.findUnique({
    where: { userId_platform: { userId, platform: TIKTOK_PLATFORM } },
  });
  return connection
    ? {
        connected: true,
        externalAccountId: connection.externalAccountId,
        externalAccountLabel: connection.externalAccountLabel,
        reconnectNeeded: Boolean(connection.refreshError),
      }
    : { connected: false, externalAccountId: null, externalAccountLabel: null, reconnectNeeded: false };
}

export async function disconnectTikTok(userId: string): Promise<void> {
  await prisma.platformConnection.deleteMany({ where: { userId, platform: TIKTOK_PLATFORM } });
}

export async function accessTokenForTikTok(userId: string): Promise<string> {
  const connection = await prisma.platformConnection.findUnique({
    where: { userId_platform: { userId, platform: TIKTOK_PLATFORM } },
  });
  if (!connection) throw new Error("TikTok is not connected");
  if (connection.accessTokenExpiresAt > new Date()) return decryptToken(connection.accessTokenEncrypted);

  const config = getValidatedTikTokOAuthConfig();
  let refreshed: TokenResponse | null = null;
  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key: config.TIKTOK_CLIENT_KEY,
        client_secret: config.TIKTOK_CLIENT_SECRET,
        refresh_token: decryptToken(connection.refreshTokenEncrypted),
        grant_type: "refresh_token",
      }),
    });
    refreshed = (await json(response)) as TokenResponse | null;
    if (!response.ok || !refreshed?.access_token || !refreshed.expires_in) throw new Error("refresh failed");
  } catch {
    await prisma.platformConnection.update({
      where: { id: connection.id },
      data: { refreshError: "TikTok connection needs reconnecting." },
    });
    throw new Error("TikTok connection needs reconnecting.");
  }
  await prisma.platformConnection.update({
    where: { id: connection.id },
    data: {
      accessTokenEncrypted: encryptToken(refreshed.access_token),
      refreshTokenEncrypted: refreshed.refresh_token ? encryptToken(refreshed.refresh_token) : connection.refreshTokenEncrypted,
      accessTokenExpiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
      refreshError: null,
    },
  });
  return refreshed.access_token;
}
