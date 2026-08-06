import { describe, expect, it } from "vitest";
import {
  CONNECTABLE_PLATFORMS,
  connectRoute,
  connectionLoaded,
  connectionLoading,
  connectionOf,
  connectionRoute,
  connectionStateText,
  connectionStatusText,
  connectionUnavailable,
  connectionsSettled,
  disconnected,
  loadingConnections,
  CONNECTION_PRESENTATION,
  type ConnectablePlatform,
} from "@/lib/connection-status";
import { PLATFORM_LABEL } from "@/lib/platform";

const connected = {
  connected: true,
  externalAccountId: "acct-1",
  externalAccountLabel: "My Channel",
  reconnectNeeded: false,
};

describe("CONNECTABLE_PLATFORMS", () => {
  it("covers every platform a user can link an account to", () => {
    expect([...CONNECTABLE_PLATFORMS]).toEqual(["youtube", "tiktok", "instagram"]);
  });

  it("has a label and presentation metadata for each one", () => {
    for (const platform of CONNECTABLE_PLATFORMS) {
      expect(PLATFORM_LABEL[platform]).toBeTruthy();
      expect(CONNECTION_PRESENTATION[platform]).toBeDefined();
    }
  });
});

describe("routes", () => {
  it("derives the status and connect routes from the platform name", () => {
    expect(connectionRoute("tiktok")).toBe("/api/platforms/tiktok");
    expect(connectRoute("tiktok")).toBe("/api/platforms/tiktok/connect");
  });
});

describe("connectionStatusText", () => {
  it("reports not connected without a connection", () => {
    for (const platform of CONNECTABLE_PLATFORMS) {
      expect(connectionStatusText(platform, null)).toBe("Not connected");
      expect(connectionStatusText(platform, disconnected())).toBe("Not connected");
    }
  });

  it("reports a reconnect ahead of the account name", () => {
    for (const platform of CONNECTABLE_PLATFORMS) {
      expect(connectionStatusText(platform, { ...connected, reconnectNeeded: true }))
        .toBe("Reconnect needed");
    }
  });

  it("names the connected account, falling back to its id", () => {
    expect(connectionStatusText("youtube", connected)).toBe("Connected to My Channel");
    expect(connectionStatusText("youtube", { ...connected, externalAccountLabel: null }))
      .toBe("Connected to acct-1");
  });

  it("renders an Instagram account as an @handle without doubling the @", () => {
    expect(connectionStatusText("instagram", { ...connected, externalAccountLabel: "my.creator" }))
      .toBe("Connected to @my.creator");
    expect(connectionStatusText("instagram", { ...connected, externalAccountLabel: "@my.creator" }))
      .toBe("Connected to @my.creator");
    expect(connectionStatusText("instagram", { ...connected, externalAccountLabel: null }))
      .toBe("Connected to acct-1");
  });
});

describe("CONNECTION_PRESENTATION disclaimers", () => {
  it("keeps the disclaimer platform-specific rather than shared", () => {
    expect(CONNECTION_PRESENTATION.youtube.disclaimer).toBeUndefined();
    expect(CONNECTION_PRESENTATION.tiktok.disclaimer).toContain("SELF_ONLY");
    expect(CONNECTION_PRESENTATION.instagram.disclaimer).toContain("Business or Creator");
  });
});

describe("connectionStateText", () => {
  // The bug this state machine exists to kill: every platform started as
  // null, null read as "Not connected", so a fully connected dashboard
  // claimed three disconnected accounts on every reload.
  it("says it is still checking rather than claiming a platform is disconnected", () => {
    for (const platform of CONNECTABLE_PLATFORMS) {
      const text = connectionStateText(platform, connectionLoading());
      expect(text).toBe("Checking...");
      expect(text).not.toBe("Not connected");
    }
  });

  // A request that never landed is not evidence of anything. Reporting it as
  // "Not connected" invites the operator to reconnect an account that is
  // already linked.
  it("distinguishes a failed status request from a successful not-connected answer", () => {
    for (const platform of CONNECTABLE_PLATFORMS) {
      const failed = connectionStateText(platform, connectionUnavailable());
      const answered = connectionStateText(platform, connectionLoaded(disconnected()));
      expect(failed).toBe("Status unavailable");
      expect(answered).toBe("Not connected");
      expect(failed).not.toBe(answered);
    }
  });

  it("defers to the loaded status text once a platform has answered", () => {
    expect(connectionStateText("youtube", connectionLoaded(connected)))
      .toBe("Connected to My Channel");
    expect(connectionStateText("youtube", connectionLoaded({ ...connected, reconnectNeeded: true })))
      .toBe("Reconnect needed");
    expect(connectionStateText("instagram", connectionLoaded({ ...connected, externalAccountLabel: "my.creator" })))
      .toBe("Connected to @my.creator");
  });
});

describe("connectionOf", () => {
  it("yields a status only once one has actually been received", () => {
    expect(connectionOf(connectionLoading())).toBeNull();
    expect(connectionOf(connectionUnavailable())).toBeNull();
    expect(connectionOf(connectionLoaded(connected))).toEqual(connected);
  });
});

describe("loadingConnections", () => {
  it("starts every connectable platform in the loading phase", () => {
    const connections = loadingConnections();
    for (const platform of CONNECTABLE_PLATFORMS) {
      expect(connections[platform]).toEqual({ phase: "loading" });
    }
  });

  it("hands out a fresh record so one dashboard cannot mutate another's", () => {
    expect(loadingConnections()).not.toBe(loadingConnections());
  });
});

describe("connectionsSettled", () => {
  it("is unsettled while any single platform is still loading", () => {
    for (const pending of CONNECTABLE_PLATFORMS) {
      const connections = Object.fromEntries(
        CONNECTABLE_PLATFORMS.map((platform) => [
          platform,
          platform === pending ? connectionLoading() : connectionLoaded(connected),
        ]),
      ) as ReturnType<typeof loadingConnections>;
      expect(connectionsSettled(connections)).toBe(false);
    }
  });

  it("is unsettled before any platform has answered", () => {
    expect(connectionsSettled(loadingConnections())).toBe(false);
  });

  it("settles once every platform has answered", () => {
    const connections = Object.fromEntries(
      CONNECTABLE_PLATFORMS.map((platform) => [platform, connectionLoaded(disconnected())]),
    ) as ReturnType<typeof loadingConnections>;
    expect(connectionsSettled(connections)).toBe(true);
  });

  // A failed request is an answer: waiting longer will not produce a better
  // one, so the form must stop deferring and validate against what it knows.
  it("counts a failed request as settled rather than waiting forever", () => {
    const connections = Object.fromEntries(
      CONNECTABLE_PLATFORMS.map((platform) => [platform, connectionUnavailable()]),
    ) as ReturnType<typeof loadingConnections>;
    expect(connectionsSettled(connections)).toBe(true);
  });
});

describe("disconnected()", () => {
  it("is a fresh empty status the UI falls back to after a disconnect", () => {
    expect(disconnected()).not.toBe(disconnected());
    const platform: ConnectablePlatform = "youtube";
    expect(disconnected()).toEqual({
      connected: false,
      externalAccountId: null,
      externalAccountLabel: null,
      reconnectNeeded: false,
    });
    expect(connectionStatusText(platform, disconnected())).toBe("Not connected");
  });
});
