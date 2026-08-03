import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { instagramConnectionStatusText, JobMetadataEditor, JobOutcome, JobStatusDetails, OutboundTextPreview, overrideDraftFor, parseHashtagInput, PlatformOverrideEditors, tiktokConnectionStatusText, transferPercent, youtubeConnectionStatusText } from "@/app/page";

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

describe("parseHashtagInput", () => {
  it.each([
    ["launch demo", ["launch", "demo"]],
    ["launch, demo", ["launch", "demo"]],
    ["  launch   demo  ", ["launch", "demo"]],
    ["", []],
    ["   ", []],
  ])("splits free text into a hashtag list", (raw, expected) => {
    expect(parseHashtagInput(raw)).toEqual(expected);
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

  it("shows the composed hashtags per platform's convention", () => {
    const html = renderToStaticMarkup(createElement(OutboundTextPreview, {
      platforms: ["youtube", "tiktok"],
      title: "My Short",
      description: "A short clip",
      hashtags: ["launch", "demo"],
    }));

    expect(html).toContain("A short clip\n\n#launch #demo");
    expect(html).toContain("My Short\nA short clip #launch #demo");
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

describe("JobMetadataEditor", () => {
  const baseJob = {
    id: "job-1",
    platform: "youtube" as const,
    status: "pending" as const,
    resultUrl: null,
    error: null,
    titleOverride: "YouTube title",
    descriptionOverride: null,
    metadataSource: "overridden" as const,
    effectiveMetadata: { title: "YouTube title", description: "Shared description" },
    metadataAppliesTo: "next-attempt" as const,
  };

  it("shows source and shape-aware title-and-description controls", () => {
    const html = renderToStaticMarkup(createElement(JobMetadataEditor, {
      job: baseJob,
      onSave: () => {},
    }));

    expect(html).toContain("Overridden");
    expect(html).toContain('name="job-job-1-title"');
    expect(html).toContain('name="job-job-1-description"');
    expect(html).toContain("Clear override");
  });

  it("uses one caption control and explains edits during an active attempt", () => {
    const html = renderToStaticMarkup(createElement(JobMetadataEditor, {
      job: {
        ...baseJob,
        platform: "tiktok",
        status: "uploading",
        titleOverride: "Finished caption",
        descriptionOverride: null,
        effectiveMetadata: { title: "Finished caption", description: "" },
        metadataAppliesTo: "future-attempt",
      },
      onSave: () => {},
    }));

    expect(html).toContain("Caption");
    expect(html).not.toContain('name="job-job-1-description"');
    expect(html).toContain("future attempt");
  });

  it("starts a shared caption draft with the complete composed caption", () => {
    const html = renderToStaticMarkup(createElement(JobMetadataEditor, {
      job: {
        ...baseJob,
        platform: "instagram",
        titleOverride: null,
        descriptionOverride: null,
        metadataSource: "shared",
        effectiveMetadata: { title: "Shared title", description: "Shared description" },
      },
      onSave: () => {},
    }));

    expect(html).toContain(">Shared title\nShared description</textarea>");
  });

  it("edits future text while separately auditing an active attempt snapshot", () => {
    const html = renderToStaticMarkup(createElement(JobMetadataEditor, {
      job: {
        ...baseJob,
        platform: "tiktok",
        status: "uploading",
        titleOverride: null,
        descriptionOverride: null,
        overrideSource: "shared",
        metadataSource: "overridden",
        effectiveMetadata: { title: "Caption currently in flight", description: "" },
        savedMetadata: { title: "Future shared title", description: "Future shared description" },
      },
      onSave: () => {},
    }));

    expect(html).toContain("Future shared title\nFuture shared description");
    expect(html).not.toContain("Caption currently in flight");
  });
});

describe("JobStatusDetails", () => {
  it("renders an overridden YouTube title and description beside current progress", () => {
    const html = renderToStaticMarkup(createElement(JobStatusDetails, {
      job: {
        id: "youtube-job",
        platform: "youtube",
        status: "uploading",
        resultUrl: null,
        error: null,
        bytesUploaded: 512,
        metadataSource: "overridden",
        effectiveMetadata: {
          title: "Exact YouTube title",
          description: "Exact YouTube description",
        },
      },
      fileSize: 2048,
      onRetry: () => {},
      onSaveMetadata: () => {},
    }));

    expect(html).toContain("Uploading 25%");
    expect(html).toContain("Overridden");
    expect(html).toContain("Title");
    expect(html).toContain("Exact YouTube title");
    expect(html).toContain("Description");
    expect(html).toContain("Exact YouTube description");
  });

  it.each([
    ["instagram" as const, "instagram://media/media-123", "Published to Instagram (media media-123)"],
    ["tiktok" as const, "tiktok://publish/video-123", "Posted privately to your TikTok account (SELF_ONLY)."],
  ])("renders the exact shared %s caption beside historical outcome details", (platform, resultUrl, outcome) => {
    const html = renderToStaticMarkup(createElement(JobStatusDetails, {
      job: {
        id: `${platform}-job`,
        platform,
        status: "done",
        resultUrl,
        error: null,
        metadataSource: "shared",
        effectiveMetadata: {
          title: "Shared title",
          description: "Shared description",
        },
      },
      history: true,
      onRetry: () => {},
      onSaveMetadata: () => {},
    }));

    expect(html).toContain("Done");
    expect(html).toContain("Shared");
    expect(html).toContain("Caption");
    expect(html).toContain("Shared title\nShared description");
    expect(html).toContain(outcome);
  });
});
