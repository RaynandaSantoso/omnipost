import { describe, expect, it } from "vitest";
import { youtubeConnectionStatusText } from "@/app/page";

describe("youtubeConnectionStatusText", () => {
  it("renders the label when connected and labeled", () => {
    expect(
      youtubeConnectionStatusText({
        connected: true,
        externalAccountId: "channel-123",
        externalAccountLabel: "My Channel",
        reconnectNeeded: false,
      }),
    ).toBe("Connected to My Channel");
  });

  it("falls back to the raw id when connected but unlabeled", () => {
    expect(
      youtubeConnectionStatusText({
        connected: true,
        externalAccountId: "channel-123",
        externalAccountLabel: null,
        reconnectNeeded: false,
      }),
    ).toBe("Connected to channel-123");
  });

  it("reports reconnect needed over the label", () => {
    expect(
      youtubeConnectionStatusText({
        connected: true,
        externalAccountId: "channel-123",
        externalAccountLabel: "My Channel",
        reconnectNeeded: true,
      }),
    ).toBe("Reconnect needed");
  });

  it("reports not connected when there is no connection", () => {
    expect(youtubeConnectionStatusText(null)).toBe("Not connected");
    expect(
      youtubeConnectionStatusText({
        connected: false,
        externalAccountId: null,
        externalAccountLabel: null,
        reconnectNeeded: false,
      }),
    ).toBe("Not connected");
  });
});
