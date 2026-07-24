import { randomBytes } from "node:crypto";
import { getConfig } from "@/lib/config";
import { prisma } from "@/lib/db";
import { decryptToken, encryptToken } from "@/lib/token-crypto";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels?part=id&mine=true";
const STATE_TTL_MS = 10 * 60 * 1000;
export const YOUTUBE_PLATFORM = "youtube";

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
};

function getValidatedYouTubeOAuthConfig() {
  const config = getConfig();
  if (!config.YOUTUBE_CLIENT_ID || !config.YOUTUBE_CLIENT_SECRET || !config.YOUTUBE_REDIRECT_URI) {
    throw new Error("YouTube OAuth requires YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, and YOUTUBE_REDIRECT_URI");
  }
  const redirect = new URL(config.YOUTUBE_REDIRECT_URI);
  if (redirect.search || redirect.hash || redirect.username || redirect.password) {
    throw new Error("YOUTUBE_REDIRECT_URI must not include query parameters, a fragment, or credentials");
  }
  return config as Required<Pick<typeof config, "YOUTUBE_CLIENT_ID" | "YOUTUBE_CLIENT_SECRET" | "YOUTUBE_REDIRECT_URI">> & typeof config;
}

async function json(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

export async function startYouTubeConnect(userId: string): Promise<string> {
  const config = getValidatedYouTubeOAuthConfig();
  // Reading the key here makes a misconfigured new connection fail before
  // the user is sent away to Google.
  encryptToken("key-check");
  const state = randomBytes(32).toString("base64url");
  await prisma.oAuthState.create({
    data: {
      userId,
      value: state,
      redirectUri: config.YOUTUBE_REDIRECT_URI,
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    },
  });
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: config.YOUTUBE_CLIENT_ID,
    redirect_uri: config.YOUTUBE_REDIRECT_URI,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/youtube.upload",
    access_type: "offline",
    prompt: "consent",
    state,
  }).toString();
  return url.toString();
}

export async function completeYouTubeConnect(requestUrl: string, code: string, state: string): Promise<void> {
  const config = getValidatedYouTubeOAuthConfig();
  const received = new URL(requestUrl);
  const configured = new URL(config.YOUTUBE_REDIRECT_URI);
  // Query parameters are issued by Google, so compare the actual callback
  // destination rather than the full URL including code/state.
  received.search = "";
  received.hash = "";
  if (received.href !== configured.href) {
    throw new Error("OAuth callback redirect URI does not exactly match YOUTUBE_REDIRECT_URI");
  }

  const saved = await prisma.oAuthState.findUnique({ where: { value: state } });
  if (!saved || saved.expiresAt <= new Date() || saved.redirectUri !== config.YOUTUBE_REDIRECT_URI) {
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
      client_id: config.YOUTUBE_CLIENT_ID,
      client_secret: config.YOUTUBE_CLIENT_SECRET,
      redirect_uri: config.YOUTUBE_REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
  const tokens = (await json(tokenResponse)) as TokenResponse | null;
  if (!tokenResponse.ok || !tokens?.access_token || !tokens.refresh_token || !tokens.expires_in) {
    throw new Error("Google could not complete the YouTube connection");
  }
  const channelResponse = await fetch(CHANNELS_URL, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const channels = (await json(channelResponse)) as { items?: Array<{ id?: string }> } | null;
  const channelId = channels?.items?.[0]?.id;
  if (!channelResponse.ok || !channelId) {
    throw new Error("Google did not return a YouTube channel for this account");
  }

  await prisma.platformConnection.upsert({
    where: { userId_platform: { userId: saved.userId, platform: YOUTUBE_PLATFORM } },
    create: {
      userId: saved.userId,
      platform: YOUTUBE_PLATFORM,
      accessTokenEncrypted: encryptToken(tokens.access_token),
      refreshTokenEncrypted: encryptToken(tokens.refresh_token),
      accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      channelId,
    },
    update: {
      accessTokenEncrypted: encryptToken(tokens.access_token),
      refreshTokenEncrypted: encryptToken(tokens.refresh_token),
      accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      channelId,
      refreshError: null,
    },
  });
}

export async function youtubeConnectionStatus(userId: string) {
  const connection = await prisma.platformConnection.findUnique({
    where: { userId_platform: { userId, platform: YOUTUBE_PLATFORM } },
  });
  return connection
    ? { connected: true, channelId: connection.channelId, reconnectNeeded: Boolean(connection.refreshError) }
    : { connected: false, channelId: null, reconnectNeeded: false };
}

export async function disconnectYouTube(userId: string): Promise<void> {
  await prisma.platformConnection.deleteMany({ where: { userId, platform: YOUTUBE_PLATFORM } });
}

export async function accessTokenForYouTube(userId: string): Promise<string> {
  const connection = await prisma.platformConnection.findUnique({
    where: { userId_platform: { userId, platform: YOUTUBE_PLATFORM } },
  });
  if (!connection) throw new Error("YouTube is not connected");
  if (connection.accessTokenExpiresAt > new Date()) return decryptToken(connection.accessTokenEncrypted);

  const config = getValidatedYouTubeOAuthConfig();
  let refreshed: TokenResponse | null = null;
  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.YOUTUBE_CLIENT_ID,
        client_secret: config.YOUTUBE_CLIENT_SECRET,
        refresh_token: decryptToken(connection.refreshTokenEncrypted),
        grant_type: "refresh_token",
      }),
    });
    refreshed = (await json(response)) as TokenResponse | null;
    if (!response.ok || !refreshed?.access_token || !refreshed.expires_in) throw new Error("refresh failed");
  } catch {
    await prisma.platformConnection.update({
      where: { id: connection.id },
      data: { refreshError: "YouTube connection needs reconnecting." },
    });
    throw new Error("YouTube connection needs reconnecting.");
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
