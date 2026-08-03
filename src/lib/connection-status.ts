// Everything the dashboard needs to render one platform's account link, in
// one place. The connect/status UI reads this map instead of branching per
// platform, so adding a platform is one entry here plus its API routes.
//
// A ConnectionStatus is the dashboard's *view* of a PlatformConnection (the
// glossary term, and the Prisma model): whether the account is linked and how
// to say so. It deliberately carries no tokens.

import type { Platform } from "@/lib/platform";

/**
 * The platforms a user can link an account to. A strict subset of `Platform`:
 * "dry-run" uploads nowhere and so has no account to connect.
 */
export const CONNECTABLE_PLATFORMS = [
  "youtube",
  "tiktok",
  "instagram",
] as const satisfies readonly Platform[];

export type ConnectablePlatform = (typeof CONNECTABLE_PLATFORMS)[number];

/** The shape every `GET /api/platforms/<platform>` route returns. */
export interface ConnectionStatus {
  connected: boolean;
  externalAccountId: string | null;
  externalAccountLabel: string | null;
  reconnectNeeded: boolean;
}

export interface ConnectionPresentation {
  /**
   * A caveat about posting to this platform, shown under the row. Only some
   * platforms carry one — it stays per-platform rather than being invented
   * for the ones that never had it.
   */
  disclaimer?: string;
  /**
   * How the linked account reads once connected, when the raw label isn't how
   * the platform writes it. Defaults to the label, then the account id.
   */
  accountName?: (status: ConnectionStatus) => string | null;
}

export const CONNECTION_PRESENTATION: Record<ConnectablePlatform, ConnectionPresentation> = {
  youtube: {},
  tiktok: {
    disclaimer:
      "Posts are private (SELF_ONLY) until TikTok approves this app for public posting.",
  },
  instagram: {
    disclaimer:
      "Requires an Instagram Business or Creator account linked to a Facebook Page.",
    accountName: (status) => status.externalAccountLabel
      ? `@${status.externalAccountLabel.replace(/^@/, "")}`
      : status.externalAccountId,
  },
};

/** Where the dashboard reads status from, and sends DELETE to disconnect. */
export function connectionRoute(platform: ConnectablePlatform): string {
  return `/api/platforms/${platform}`;
}

/** Where the connect button sends the user to start the OAuth handshake. */
export function connectRoute(platform: ConnectablePlatform): string {
  return `${connectionRoute(platform)}/connect`;
}

/**
 * The empty status the UI shows once a disconnect succeeds. A factory rather
 * than a shared constant so no two platforms ever hold the same object.
 */
export function disconnected(): ConnectionStatus {
  return {
    connected: false,
    externalAccountId: null,
    externalAccountLabel: null,
    reconnectNeeded: false,
  };
}

export function connectionStatusText(
  platform: ConnectablePlatform,
  status: ConnectionStatus | null,
): string {
  if (!status?.connected) return "Not connected";
  // A stale token is worth saying before the account name — the name alone
  // would read as if the link still worked.
  if (status.reconnectNeeded) return "Reconnect needed";
  const { accountName } = CONNECTION_PRESENTATION[platform];
  const account = accountName?.(status)
    ?? status.externalAccountLabel
    ?? status.externalAccountId;
  return `Connected to ${account}`;
}
