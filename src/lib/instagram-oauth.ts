import { randomBytes } from "node:crypto";
import { getConfig } from "@/lib/config";
import { prisma } from "@/lib/db";
import type { Platform } from "@/lib/platform";
import { decryptToken, encryptToken } from "@/lib/token-crypto";

const GRAPH_VERSION = "v23.0";
const AUTHORIZE_URL = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`;
const TOKEN_URL = `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`;
const ACCOUNTS_URL = `https://graph.facebook.com/${GRAPH_VERSION}/me/accounts`;
const PERMISSIONS_URL = `https://graph.facebook.com/${GRAPH_VERSION}/me/permissions`;
const STATE_TTL_MS = 10 * 60 * 1000;
const RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const PROFESSIONAL_ACCOUNT_GUIDANCE =
  "Connect an Instagram Business or Creator account to a Facebook Page, then try again.";
export const INSTAGRAM_PLATFORM = "instagram" satisfies Platform;

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
};

type InstagramAccount = {
  id: string;
  username: string;
  pageAccessToken: string;
};

export class InstagramCredentialFailure extends Error {
  constructor(
    message: string,
    readonly kind: "retryable" | "reconnect",
  ) {
    super(message);
    this.name = "InstagramCredentialFailure";
  }
}

function credentialFailureForResponse(response: Response): InstagramCredentialFailure {
  const retryable = response.status === 429 || response.status >= 500;
  return new InstagramCredentialFailure(
    retryable
      ? "Meta is temporarily unavailable while renewing Instagram credentials"
      : "Instagram connection needs reconnecting.",
    retryable ? "retryable" : "reconnect",
  );
}

function getValidatedInstagramOAuthConfig() {
  const config = getConfig();
  const required = [
    ["INSTAGRAM_APP_ID", config.INSTAGRAM_APP_ID],
    ["INSTAGRAM_APP_SECRET", config.INSTAGRAM_APP_SECRET],
    ["INSTAGRAM_REDIRECT_URI", config.INSTAGRAM_REDIRECT_URI],
  ] as const;
  const missing = required.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `Instagram OAuth requires missing configuration: ${missing.join(", ")}`,
    );
  }
  return config as Required<
    Pick<
      typeof config,
      "INSTAGRAM_APP_ID" | "INSTAGRAM_APP_SECRET" | "INSTAGRAM_REDIRECT_URI"
    >
  > &
    typeof config;
}

async function json(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

async function exchangeCodeForUserToken(code: string): Promise<string> {
  const config = getValidatedInstagramOAuthConfig();
  const url = new URL(TOKEN_URL);
  url.search = new URLSearchParams({
    client_id: config.INSTAGRAM_APP_ID,
    client_secret: config.INSTAGRAM_APP_SECRET,
    redirect_uri: config.INSTAGRAM_REDIRECT_URI,
    code,
  }).toString();
  const response = await fetch(url);
  const token = (await json(response)) as TokenResponse | null;
  if (!response.ok || !token?.access_token) {
    throw new Error("Meta could not complete the Instagram connection");
  }
  return token.access_token;
}

async function exchangeForLongLivedUserToken(
  userToken: string,
): Promise<Required<TokenResponse>> {
  const config = getValidatedInstagramOAuthConfig();
  const url = new URL(TOKEN_URL);
  url.search = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: config.INSTAGRAM_APP_ID,
    client_secret: config.INSTAGRAM_APP_SECRET,
    fb_exchange_token: userToken,
  }).toString();
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new InstagramCredentialFailure(
      "Meta could not be reached while renewing Instagram credentials",
      "retryable",
    );
  }
  const token = (await json(response)) as TokenResponse | null;
  if (!response.ok || !token?.access_token || !token.expires_in) {
    if (!response.ok) throw credentialFailureForResponse(response);
    throw new InstagramCredentialFailure(
      "Meta returned incomplete renewed Instagram credentials",
      "retryable",
    );
  }
  return { access_token: token.access_token, expires_in: token.expires_in };
}

async function findProfessionalAccount(
  userToken: string,
  expectedAccountId?: string,
): Promise<InstagramAccount | null> {
  let url: URL | null = new URL(ACCOUNTS_URL);
  url.searchParams.set(
    "fields",
    "access_token,instagram_business_account{id,username}",
  );
  while (url) {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${userToken}` },
      });
    } catch {
      throw new InstagramCredentialFailure(
        "Meta could not be reached while reading the Instagram account",
        "retryable",
      );
    }
    const body = (await json(response)) as {
      data?: Array<{
        access_token?: string;
        instagram_business_account?: { id?: string; username?: string };
      }>;
      paging?: { next?: string };
    } | null;
    if (!response.ok) {
      throw credentialFailureForResponse(response);
    }
    const accounts = (body?.data ?? []).flatMap((page) => {
      const account = page.instagram_business_account;
      return page.access_token && account?.id && account.username
        ? [{ id: account.id, username: account.username, pageAccessToken: page.access_token }]
        : [];
    });
    const match = expectedAccountId
      ? accounts.find((account) => account.id === expectedAccountId)
      : accounts[0];
    if (match) return match;
    if (!body?.paging?.next) {
      url = null;
      continue;
    }
    const next = new URL(body.paging.next);
    if (next.origin !== new URL(ACCOUNTS_URL).origin) {
      throw new Error("Meta returned an invalid Instagram account page");
    }
    url = next;
  }
  return null;
}

export async function startInstagramConnect(userId: string): Promise<string> {
  const config = getValidatedInstagramOAuthConfig();
  encryptToken("key-check");
  const state = randomBytes(32).toString("base64url");
  await prisma.oAuthState.create({
    data: {
      userId,
      value: state,
      redirectUri: config.INSTAGRAM_REDIRECT_URI,
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    },
  });
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: config.INSTAGRAM_APP_ID,
    redirect_uri: config.INSTAGRAM_REDIRECT_URI,
    response_type: "code",
    scope:
      "pages_show_list,pages_read_engagement,instagram_basic,instagram_content_publish",
    state,
  }).toString();
  return url.toString();
}

export async function completeInstagramConnect(
  requestUrl: string,
  code: string,
  state: string,
): Promise<void> {
  const config = getValidatedInstagramOAuthConfig();
  const received = new URL(requestUrl);
  const configured = new URL(config.INSTAGRAM_REDIRECT_URI);
  received.search = "";
  received.hash = "";
  if (received.href !== configured.href) {
    throw new Error(
      "OAuth callback redirect URI does not exactly match INSTAGRAM_REDIRECT_URI",
    );
  }

  const saved = await prisma.oAuthState.findUnique({ where: { value: state } });
  if (
    !saved ||
    saved.expiresAt <= new Date() ||
    saved.redirectUri !== config.INSTAGRAM_REDIRECT_URI
  ) {
    throw new Error("OAuth state is invalid or expired");
  }
  await prisma.oAuthState.delete({ where: { id: saved.id } });

  const shortToken = await exchangeCodeForUserToken(code);
  const longToken = await exchangeForLongLivedUserToken(shortToken);
  const account = await findProfessionalAccount(longToken.access_token);
  if (!account) throw new Error(PROFESSIONAL_ACCOUNT_GUIDANCE);

  const connectionData = {
    accessTokenEncrypted: encryptToken(account.pageAccessToken),
    refreshTokenEncrypted: encryptToken(longToken.access_token),
    accessTokenExpiresAt: new Date(Date.now() + longToken.expires_in * 1000),
    externalAccountId: account.id,
    externalAccountLabel: account.username,
  };

  await prisma.platformConnection.upsert({
    where: {
      userId_platform: { userId: saved.userId, platform: INSTAGRAM_PLATFORM },
    },
    create: {
      userId: saved.userId,
      platform: INSTAGRAM_PLATFORM,
      ...connectionData,
    },
    update: {
      ...connectionData,
      refreshError: null,
    },
  });
}

export async function instagramConnectionStatus(userId: string) {
  const connection = await prisma.platformConnection.findUnique({
    where: { userId_platform: { userId, platform: INSTAGRAM_PLATFORM } },
  });
  return connection
    ? {
        connected: true,
        externalAccountId: connection.externalAccountId,
        externalAccountLabel: connection.externalAccountLabel,
        reconnectNeeded: Boolean(connection.refreshError),
      }
    : {
        connected: false,
        externalAccountId: null,
        externalAccountLabel: null,
        reconnectNeeded: false,
      };
}

export async function disconnectInstagram(userId: string): Promise<void> {
  const connection = await prisma.platformConnection.findUnique({
    where: { userId_platform: { userId, platform: INSTAGRAM_PLATFORM } },
  });
  if (!connection) return;
  const response = await fetch(PERMISSIONS_URL, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${decryptToken(connection.refreshTokenEncrypted)}`,
    },
  });
  const body = (await json(response)) as { success?: boolean } | null;
  if (!response.ok || body?.success !== true) {
    throw new Error("Meta could not revoke the Instagram connection");
  }
  await prisma.platformConnection.delete({ where: { id: connection.id } });
}

export async function accessTokenForInstagram(userId: string): Promise<string> {
  const connection = await prisma.platformConnection.findUnique({
    where: { userId_platform: { userId, platform: INSTAGRAM_PLATFORM } },
  });
  if (!connection) throw new Error("Instagram is not connected");
  if (connection.accessTokenExpiresAt.getTime() > Date.now() + RENEWAL_WINDOW_MS) {
    return decryptToken(connection.accessTokenEncrypted);
  }

  try {
    const longToken = await exchangeForLongLivedUserToken(
      decryptToken(connection.refreshTokenEncrypted),
    );
    const account = await findProfessionalAccount(
      longToken.access_token,
      connection.externalAccountId,
    );
    if (!account) throw new Error(PROFESSIONAL_ACCOUNT_GUIDANCE);
    await prisma.platformConnection.update({
      where: { id: connection.id },
      data: {
        accessTokenEncrypted: encryptToken(account.pageAccessToken),
        refreshTokenEncrypted: encryptToken(longToken.access_token),
        accessTokenExpiresAt: new Date(Date.now() + longToken.expires_in * 1000),
        externalAccountLabel: account.username,
        refreshError: null,
      },
    });
    return account.pageAccessToken;
  } catch (error) {
    if (error instanceof InstagramCredentialFailure && error.kind === "retryable") {
      throw error;
    }
    await prisma.platformConnection.update({
      where: { id: connection.id },
      data: { refreshError: "Instagram connection needs reconnecting." },
    });
    throw new InstagramCredentialFailure(
      "Instagram connection needs reconnecting.",
      "reconnect",
    );
  }
}

export async function instagramPublishingCredentials(userId: string): Promise<{
  accessToken: string;
  accountId: string;
}> {
  const accessToken = await accessTokenForInstagram(userId);
  const connection = await prisma.platformConnection.findUnique({
    where: { userId_platform: { userId, platform: INSTAGRAM_PLATFORM } },
    select: { externalAccountId: true },
  });
  if (!connection?.externalAccountId) {
    throw new Error("Instagram connection needs reconnecting.");
  }
  return { accessToken, accountId: connection.externalAccountId };
}
