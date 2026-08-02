import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { instagramConnectionStatusText, JobOutcome, OutboundTextPreview, overrideDraftFor, PlatformOverrideEditors, tiktokConnectionStatusText, transferPercent, youtubeConnectionStatusText } from "@/app/page";

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

describe("instagramConnectionStatusText", () => {
  it("renders the connected username and reconnect status", () => {
    expect(instagramConnectionStatusText({
      connected: true,
      externalAccountId: "ig-123",
      externalAccountLabel: "my.creator",
      reconnectNeeded: false,
    })).toBe("Connected to @my.creator");
    expect(instagramConnectionStatusText({
      connected: true,
      externalAccountId: "ig-123",
      externalAccountLabel: "my.creator",
      reconnectNeeded: true,
    })).toBe("Reconnect needed");
  });

  it("reports not connected without a connection", () => {
    expect(instagramConnectionStatusText(null)).toBe("Not connected");
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

  it("renders Instagram processing in the unified job outcome", () => {
    const html = renderToStaticMarkup(createElement(JobOutcome, {
      job: { id: "job-3", platform: "instagram", status: "uploading", resultUrl: null, error: null },
      onRetry: () => {},
    }));
    expect(html).toContain("Instagram is fetching and processing your Reel");
  });

  it("renders a completed Instagram media reference without a custom-scheme link", () => {
    const html = renderToStaticMarkup(createElement(JobOutcome, {
      job: { id: "job-4", platform: "instagram", status: "done", resultUrl: "instagram://media/media-456", error: null },
      onRetry: () => {},
    }));
    expect(html).toContain("Published to Instagram (media media-456)");
    expect(html).not.toContain("href=");
  });

  it("renders actionable Instagram reconnect guidance", () => {
    const html = renderToStaticMarkup(createElement(JobOutcome, {
      job: { id: "job-5", platform: "instagram", status: "failed", resultUrl: null, error: "Instagram connection needs reconnecting" },
      onRetry: () => {},
    }));
    expect(html).toContain("Instagram needs to be reconnected");
  });
});

describe("transferPercent", () => {
  const uploading = {
    id: "job-1",
    platform: "youtube" as const,
    status: "uploading" as const,
    resultUrl: null,
    error: null,
    bytesUploaded: 512,
  };

  it("reports the share of the video the platform has confirmed", () => {
    expect(transferPercent(uploading, 2048)).toBe(25);
  });

  it("shows nothing before the transfer reports a first offset", () => {
    expect(transferPercent({ ...uploading, bytesUploaded: null }, 2048)).toBeNull();
  });

  it("shows nothing for a job that is not transferring", () => {
    expect(transferPercent({ ...uploading, status: "pending" }, 2048)).toBeNull();
    expect(transferPercent({ ...uploading, status: "done" }, 2048)).toBeNull();
  });

  it("shows nothing when the upload size is unknown", () => {
    expect(transferPercent(uploading, undefined)).toBeNull();
  });
});

describe("OutboundTextPreview", () => {
  it("shows the exact declared outbound fields for each connected platform", () => {
    const html = renderToStaticMarkup(createElement(OutboundTextPreview, {
      platforms: ["youtube", "tiktok", "instagram"],
      title: "My Short",
      description: "A short clip",
    }));

    expect(html).toContain("YouTube");
    expect(html).toContain("TikTok");
    expect(html).toContain("Instagram");
    expect(html.match(/>Title</g)).toHaveLength(1);
    expect(html.match(/>Description</g)).toHaveLength(1);
    expect(html.match(/>Caption</g)).toHaveLength(2);
    expect(html.match(/My Short\nA short clip/g)).toHaveLength(2);
  });

  it("shows override-resolved outbound text instead of stale shared text", () => {
    const html = renderToStaticMarkup(createElement(OutboundTextPreview, {
      platforms: ["youtube", "tiktok"],
      title: "Shared title",
      description: "Shared description",
      overrides: {
        youtube: { title: "YouTube title", description: "YouTube description" },
        tiktok: { title: "Finished TikTok caption" },
      },
    }));

    expect(html).toContain("YouTube title");
    expect(html).toContain("YouTube description");
    expect(html).toContain("Finished TikTok caption");
    expect(html).not.toContain("Finished TikTok caption\nShared description");
  });
});

describe("PlatformOverrideEditors", () => {
  it("starts shape-aware drafts from the exact shared outbound text", () => {
    const shared = { title: "Shared title", description: "Shared description" };

    expect(overrideDraftFor("youtube", shared)).toEqual({
      title: "Shared title",
      description: "Shared description",
    });
    expect(overrideDraftFor("tiktok", shared)).toEqual({
      title: "Shared title\nShared description",
    });
    expect(overrideDraftFor("instagram", shared)).toEqual({
      title: "Shared title\nShared description",
    });
  });

  it("renders collapsed editors and distinguishes shared from overridden targets", () => {
    const html = renderToStaticMarkup(createElement(PlatformOverrideEditors, {
      platforms: ["youtube", "tiktok", "instagram"],
      title: "Shared title",
      description: "Shared description",
      overrides: {
        youtube: { title: "YouTube title", description: "YouTube description" },
      },
      onChange: () => {},
    }));

    expect(html).not.toContain("<details open");
    expect(html.match(/>Shared</g)).toHaveLength(2);
    expect(html.match(/>Overridden</g)).toHaveLength(1);
    expect(html.match(/>Customize</g)).toHaveLength(2);
    expect(html).toContain("Clear override");
    expect(html).toContain('name="overrides.youtube.title"');
    expect(html).toContain('value="YouTube title"');
    expect(html).toContain('name="overrides.youtube.description"');
    expect(html).toContain(">YouTube description</textarea>");
  });
});
