import { describe, expect, it } from "vitest";
import {
  CONNECTABLE_PLATFORMS,
  connectRoute,
  connectionRoute,
  connectionStatusText,
  disconnected,
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
