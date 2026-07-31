import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { JobOutcome, tiktokConnectionStatusText, youtubeConnectionStatusText } from "@/app/page";

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

describe("tiktokConnectionStatusText", () => {
  it("renders the label when connected and labeled", () => {
    expect(
      tiktokConnectionStatusText({
        connected: true,
        externalAccountId: "open-id-123",
        externalAccountLabel: "My TikTok",
        reconnectNeeded: false,
      }),
    ).toBe("Connected to My TikTok");
  });

  it("falls back to the raw id when connected but unlabeled", () => {
    expect(
      tiktokConnectionStatusText({
        connected: true,
        externalAccountId: "open-id-123",
        externalAccountLabel: null,
        reconnectNeeded: false,
      }),
    ).toBe("Connected to open-id-123");
  });

  it("reports reconnect needed over the label", () => {
    expect(
      tiktokConnectionStatusText({
        connected: true,
        externalAccountId: "open-id-123",
        externalAccountLabel: "My TikTok",
        reconnectNeeded: true,
      }),
    ).toBe("Reconnect needed");
  });

  it("reports not connected when there is no connection", () => {
    expect(tiktokConnectionStatusText(null)).toBe("Not connected");
    expect(
      tiktokConnectionStatusText({
        connected: false,
        externalAccountId: null,
        externalAccountLabel: null,
        reconnectNeeded: false,
      }),
    ).toBe("Not connected");
  });
});

describe("JobOutcome", () => {
  it("renders a completed TikTok job as a private post", () => {
    const html = renderToStaticMarkup(createElement(JobOutcome, { job: { id: "job-1", platform: "tiktok", status: "done", resultUrl: "tiktok://publish/1", error: null }, onRetry: () => {} }));
    expect(html).toContain("Posted privately to your TikTok account (SELF_ONLY).");
    expect(html).not.toContain("Tap it in TikTok");
    expect(html).not.toContain('href="tiktok://');
  });

  it("renders TikTok-specific recovery guidance for a failed TikTok job", () => {
    const html = renderToStaticMarkup(createElement(JobOutcome, { job: { id: "job-2", platform: "tiktok", status: "failed", resultUrl: null, error: "TikTok connection needs reconnecting" }, onRetry: () => {} }));
    expect(html).toContain("TikTok needs to be reconnected");
    expect(html).not.toContain("YouTube needs");
  });
});
