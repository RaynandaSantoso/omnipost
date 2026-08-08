import { randomBytes } from "node:crypto";
import { getConfig } from "@/lib/config";
import { prisma } from "@/lib/db";
import type { Platform } from "@/lib/platform";
import { decryptToken, encryptToken } from "@/lib/token-crypto";

// Instagram API with Instagram Login. The operator authorizes one professional
// Instagram account directly: no Facebook app, Page, or Page token appears at
// any step. The Page-based flow this replaced could not connect an account
// Meta had provisioned without a Page the operator administers — see the
// evidence in issue #38.
//
// Meta splits the handshake over three hosts. The consent screen belongs to
// instagram.com, the code exchange to api.instagram.com, and every token or
// account read to graph.instagram.com. These endpoints carry no version
// segment, as Meta documents them; the publishing adapter's do, and pins one.
const AUTHORIZE_URL = "https://www.instagram.com/oauth/authorize";
const CODE_EXCHANGE_URL = "https://api.instagram.com/oauth/access_token";
const LONG_LIVED_TOKEN_URL = "https://graph.instagram.com/access_token";
const REFRESH_TOKEN_URL = "https://graph.instagram.com/refresh_access_token";
const ACCOUNT_URL = "https://graph.instagram.com/me";
// The `_business_` scopes are Instagram Login's own; they are not the
// `instagram_basic`/`instagram_content_publish` pair the Facebook flow asked
// for, and the two vocabularies are not interchangeable.
const SCOPE = "instagram_business_basic,instagram_business_content_publish";
const STATE_TTL_MS = 10 * 60 * 1000;
const RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000;
export const INSTAGRAM_PLATFORM = "instagram" satisfies Platform;

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
};

type LongLivedToken = {
  accessToken: string;
  expiresInSeconds: number;
};

type InstagramAccount = {
  id: string;
  username: string;
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

// The one form POST in the handshake. Instagram takes the code's credentials
// in the body where the Facebook flow took them as query parameters, and it is
// the only call here that needs the app id and the redirect URI.
async function exchangeCodeForShortLivedToken(code: string): Promise<string> {
  const config = getValidatedInstagramOAuthConfig();
  const response = await fetch(CODE_EXCHANGE_URL, {
    method: "POST",
    body: new URLSearchParams({
      client_id: config.INSTAGRAM_APP_ID,
      client_secret: config.INSTAGRAM_APP_SECRET,
      grant_type: "authorization_code",
      redirect_uri: config.INSTAGRAM_REDIRECT_URI,
      code,
    }),
  });
  const token = (await json(response)) as TokenResponse | null;
  if (!response.ok || !token?.access_token) {
    throw new Error("Instagram could not complete the connection");
  }
  return token.access_token;
}

// Both long-lived token calls — the first exchange and every later renewal —
// answer in the same shape and fail on the same terms, so only the URL differs.
async function longLivedTokenFrom(url: URL): Promise<LongLivedToken> {
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
  return { accessToken: token.access_token, expiresInSeconds: token.expires_in };
}

function exchangeForLongLivedToken(shortLivedToken: string): Promise<LongLivedToken> {
  const config = getValidatedInstagramOAuthConfig();
  const url = new URL(LONG_LIVED_TOKEN_URL);
  url.search = new URLSearchParams({
    grant_type: "ig_exchange_token",
    client_secret: config.INSTAGRAM_APP_SECRET,
    access_token: shortLivedToken,
  }).toString();
  return longLivedTokenFrom(url);
}

// Instagram renews a long-lived token by being shown the token itself: there
// is no separate refresh credential, which is why one value fills both token
// columns. Meta requires the token to be at least a day old and not yet
// expired, so a connection left untouched past 60 days fails here — correctly,
// as a reconnect rather than a retry.
function renewLongLivedToken(currentToken: string): Promise<LongLivedToken> {
  const url = new URL(REFRESH_TOKEN_URL);
  url.search = new URLSearchParams({
    grant_type: "ig_refresh_token",
    access_token: currentToken,
  }).toString();
  return longLivedTokenFrom(url);
}

// All that remains of what was a paginated walk over Facebook Pages hunting
// for one with an Instagram account attached. Instagram Login returns the
// account directly, because the account is the thing that was authorized.
async function readAccount(token: string): Promise<InstagramAccount> {
  const url = new URL(ACCOUNT_URL);
  url.search = new URLSearchParams({
    fields: "id,username",
    access_token: token,
  }).toString();
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new InstagramCredentialFailure(
      "Meta could not be reached while reading the Instagram account",
      "retryable",
    );
  }
  const body = (await json(response)) as { id?: unknown; username?: unknown } | null;
  if (!response.ok) throw credentialFailureForResponse(response);
  if (typeof body?.id !== "string" || typeof body.username !== "string" || !body.username) {
    throw new Error("Instagram did not identify the connected account");
  }
  return { id: body.id, username: body.username };
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
    scope: SCOPE,
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

  const shortLivedToken = await exchangeCodeForShortLivedToken(code);
  const token = await exchangeForLongLivedToken(shortLivedToken);
  const account = await readAccount(token.accessToken);

  const connectionData = {
    // One token, written to both columns. Instagram Login issues a single
    // long-lived token that authorizes publishing *and* renews itself, so the
    // access/refresh split this schema inherited from YouTube has no second
    // value to hold. Storing it twice keeps the column non-null for every
    // platform rather than spending a migration on Instagram's peculiarity;
    // `accessTokenEncrypted` is the copy this module ever reads.
    accessTokenEncrypted: encryptToken(token.accessToken),
    refreshTokenEncrypted: encryptToken(token.accessToken),
    accessTokenExpiresAt: new Date(Date.now() + token.expiresInSeconds * 1000),
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

/**
 * Forget the stored Instagram credentials.
 *
 * Local only, because Instagram Login has no revoke endpoint — the Facebook
 * flow's `DELETE /me/permissions` has no counterpart here. OmniPost holds no
 * usable token afterwards, but Meta still records the grant until the operator
 * removes OmniPost under Instagram's own Apps and websites settings. The
 * dashboard says so beneath the connection row rather than leaving "Disconnect"
 * to imply more than it does.
 */
export async function disconnectInstagram(userId: string): Promise<void> {
  await prisma.platformConnection.deleteMany({
    where: { userId, platform: INSTAGRAM_PLATFORM },
  });
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
    const token = await renewLongLivedToken(decryptToken(connection.accessTokenEncrypted));
    // Re-read the account instead of trusting the stored fields: it keeps the
    // displayed handle current after a rename, and a renewed token that comes
    // back naming somebody else is a reconnect, not a refresh.
    const account = await readAccount(token.accessToken);
    if (account.id !== connection.externalAccountId) {
      throw new Error("The renewed Instagram token belongs to a different account");
    }
    await prisma.platformConnection.update({
      where: { id: connection.id },
      data: {
        accessTokenEncrypted: encryptToken(token.accessToken),
        refreshTokenEncrypted: encryptToken(token.accessToken),
        accessTokenExpiresAt: new Date(Date.now() + token.expiresInSeconds * 1000),
        externalAccountLabel: account.username,
        refreshError: null,
      },
    });
    return token.accessToken;
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
