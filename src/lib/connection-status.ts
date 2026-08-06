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

/**
 * How far along the dashboard is in learning one platform's status.
 *
 * This is deliberately three states rather than `ConnectionStatus | null`.
 * Null collapsed "still asking", "asked and there is no account linked", and
 * "asked and could not reach the server" into one value, and the UI rendered
 * the middle one for all three — so a connected dashboard announced three
 * disconnected accounts on every reload, and a failed request was
 * indistinguishable from a genuine answer.
 */
export type ConnectionLoadState =
  | { phase: "loading" }
  | { phase: "loaded"; status: ConnectionStatus }
  | { phase: "unavailable" };

export function connectionLoading(): ConnectionLoadState {
  return { phase: "loading" };
}

export function connectionLoaded(status: ConnectionStatus): ConnectionLoadState {
  return { phase: "loaded", status };
}

/** The status request itself failed — no claim is made about the account. */
export function connectionUnavailable(): ConnectionLoadState {
  return { phase: "unavailable" };
}

/** The received status, or null while there isn't one to reason about yet. */
export function connectionOf(state: ConnectionLoadState): ConnectionStatus | null {
  return state.phase === "loaded" ? state.status : null;
}

export function connectionStateText(
  platform: ConnectablePlatform,
  state: ConnectionLoadState,
): string {
  if (state.phase === "loading") return "Checking...";
  // Not "Not connected": nothing was learned, so nothing may be asserted.
  if (state.phase === "unavailable") return "Status unavailable";
  return connectionStatusText(platform, state.status);
}

/** Every connectable platform's state, as the dashboard currently knows it. */
export type ConnectionsView = Record<ConnectablePlatform, ConnectionLoadState>;

/** The starting point for a dashboard that has asked nothing yet. */
export function loadingConnections(): ConnectionsView {
  return Object.fromEntries(
    CONNECTABLE_PLATFORMS.map((platform) => [platform, connectionLoading()]),
  ) as ConnectionsView;
}

/**
 * Whether every platform has answered — including the ones whose request
 * failed, since waiting longer will not improve that answer. Until this is
 * true, no question whose answer depends on which platforms are connected
 * (which file limits apply, above all) can be answered honestly.
 */
export function connectionsSettled(connections: ConnectionsView): boolean {
  return CONNECTABLE_PLATFORMS.every(
    (platform) => connections[platform].phase !== "loading",
  );
}
