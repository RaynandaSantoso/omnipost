import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { fileFormatIssue, instagramConnectionStatusText, JobMetadataEditor, JobOutcome, JobStatusDetails, OutboundTextPreview, overrideDraftFor, parseHashtagInput, PlatformConnectionSection, PlatformOverrideEditors, tiktokConnectionStatusText, transferPercent, uploadTargetPlatforms, youtubeConnectionStatusText } from "@/app/page";
import {
  CONNECTABLE_PLATFORMS,
  connectionLoaded,
  connectionLoading,
  connectionUnavailable,
  disconnected,
  type ConnectablePlatform,
  type ConnectionLoadState,
  type ConnectionStatus,
} from "@/lib/connection-status";

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

describe("uploadTargetPlatforms", () => {
  const link = (connected: boolean): ConnectionStatus => ({
    connected,
    externalAccountId: "acct-1",
    externalAccountLabel: null,
    reconnectNeeded: false,
  });

  it("targets every connected platform, in dashboard order", () => {
    expect(uploadTargetPlatforms({
      youtube: connectionLoaded(link(true)),
      tiktok: connectionLoaded(link(false)),
      instagram: connectionLoaded(link(true)),
    })).toEqual(["youtube", "instagram"]);
  });

  it("falls back to a dry run when nothing is connected", () => {
    expect(uploadTargetPlatforms({
      youtube: connectionLoaded(link(false)),
      tiktok: connectionLoaded(link(false)),
      instagram: connectionLoaded(link(false)),
    })).toEqual(["dry-run"]);
  });

  // Only ever read once connectionsSettled() is true — see selectFile. A
  // platform that has not answered is not a target, because there is nothing
  // to target it with.
  it("does not treat an unanswered platform as a target", () => {
    expect(uploadTargetPlatforms({
      youtube: connectionLoading(),
      tiktok: connectionUnavailable(),
      instagram: connectionLoaded(link(true)),
    })).toEqual(["instagram"]);
  });
});

describe("fileFormatIssue", () => {
  const video = { name: "clip.mp4", type: "video/mp4", size: 100 * 1024 * 1024 };

  // The contradiction this issue is about, stated directly: the same file has
  // two different verdicts depending on the target platforms, so a verdict
  // reached before the statuses land is a coin flip the operator sees resolve.
  it("gives one file opposite verdicts for different target platforms", () => {
    expect(fileFormatIssue(video, ["dry-run"])).toBeNull();
    expect(fileFormatIssue(video, ["tiktok"]))
      .toBe("TikTok whole-file uploads must be 64 MB or smaller.");
  });

  it("rejects a file no platform accepts, whoever the targets are", () => {
    expect(fileFormatIssue({ name: "clip.avi", type: "video/avi", size: 10 }, ["dry-run"]))
      .toBe("Use an MP4, WebM, or MOV video file.");
    expect(fileFormatIssue({ ...video, size: 300 * 1024 * 1024 }, ["dry-run"]))
      .toBe("Use a video smaller than 256 MB.");
  });

  it("accepts a file every target platform allows", () => {
    expect(fileFormatIssue({ ...video, size: 10 * 1024 * 1024 }, ["youtube", "tiktok"]))
      .toBeNull();
  });
});

describe("PlatformConnectionSection", () => {
  const render = (platform: ConnectablePlatform, state: ConnectionLoadState) =>
    renderToStaticMarkup(createElement(PlatformConnectionSection, {
      platform,
      state,
      onDisconnect: () => {},
    }));

  const linked: ConnectionStatus = {
    connected: true,
    externalAccountId: "chan-1",
    externalAccountLabel: "My Channel",
    reconnectNeeded: false,
  };

  it("offers each platform's own connect link when it is not connected", () => {
    for (const [platform, label] of [
      ["youtube", "YouTube"],
      ["tiktok", "TikTok"],
      ["instagram", "Instagram"],
    ] as const) {
      const html = render(platform, connectionLoaded(disconnected()));
      expect(html).toContain(`href="/api/platforms/${platform}/connect"`);
      expect(html).toContain(`Connect ${label}`);
      expect(html).toContain("Not connected");
      // The button's own text, not the bare word: a platform's disclaimer may
      // legitimately talk about disconnecting, and that is not a control.
      expect(html).not.toContain(">Disconnect<");
    }
  });

  it("swaps the connect link for a disconnect button once connected", () => {
    const html = render("youtube", connectionLoaded(linked));
    expect(html).toContain("Connected to My Channel");
    expect(html).toContain(">Disconnect<");
    expect(html).not.toContain("/api/platforms/youtube/connect");
  });

  // The reload flicker this issue exists to remove: three connected accounts
  // announcing themselves as disconnected until their fetches land.
  it("reads as loading, not as disconnected, before the status arrives", () => {
    for (const platform of CONNECTABLE_PLATFORMS) {
      const html = render(platform, connectionLoading());
      expect(html).toContain("Checking...");
      expect(html).not.toContain("Not connected");
    }
  });

  // Neither action can be offered honestly yet: "Connect" asserts there is no
  // account and "Disconnect" asserts there is one.
  it("offers no connect or disconnect action while still checking", () => {
    const html = render("youtube", connectionLoading());
    expect(html).not.toContain("/api/platforms/youtube/connect");
    expect(html).not.toContain("Disconnect");
  });

  it("says a status request failed rather than reporting it as disconnected", () => {
    const html = render("youtube", connectionUnavailable());
    expect(html).toContain("Status unavailable");
    expect(html).not.toContain("Not connected");
    expect(html).not.toContain("Disconnect");
    // Connecting is the one action that works whatever the true state is, so
    // a failed check leaves the operator with a way forward.
    expect(html).toContain('href="/api/platforms/youtube/connect"');
  });

  it("names each section for its platform, not just visually", () => {
    for (const [platform, label] of [
      ["youtube", "YouTube"],
      ["tiktok", "TikTok"],
      ["instagram", "Instagram"],
    ] as const) {
      expect(render(platform, connectionLoading()))
        .toContain(`aria-label="${label} connection"`);
    }
  });

  it("keeps each platform's disclaimer with that platform", () => {
    const notConnected = connectionLoaded(disconnected());
    expect(render("tiktok", notConnected)).toContain("Videos upload as private");
    expect(render("instagram", notConnected)).not.toContain("Videos upload as private");
    const youtube = render("youtube", notConnected);
    expect(youtube).not.toContain("Videos upload as private");
  });

  // Each platform has its own request and its own key, so a hung one cannot
  // hold its siblings in a loading state.
  it("renders each platform's own phase independently of its siblings", () => {
    expect(render("youtube", connectionLoaded(linked))).toContain("Connected to My Channel");
    expect(render("tiktok", connectionLoading())).toContain("Checking...");
    expect(render("instagram", connectionLoaded(disconnected()))).toContain("Not connected");
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
    expect(html).toContain("My Short\nA short clip\n\n#launch #demo");
  });

  it("reflects a per-platform hashtag override without changing a sibling platform's shared hashtags", () => {
    const html = renderToStaticMarkup(createElement(OutboundTextPreview, {
      platforms: ["youtube", "tiktok"],
      title: "My Short",
      description: "A short clip",
      hashtags: ["launch", "demo"],
      overrides: {
        youtube: { hashtags: ["tiktokonly"] },
      },
    }));

    expect(html).toContain("A short clip\n\n#tiktokonly");
    expect(html).toContain("My Short\nA short clip\n\n#launch #demo");
    expect(html).not.toContain("#launch #demo #tiktokonly");
  });
});

describe("PlatformOverrideEditors", () => {
  it("starts shape-aware drafts from the exact shared outbound text", () => {
    const shared = { title: "Shared title", description: "Shared description" };

    expect(overrideDraftFor("youtube", shared)).toEqual({
      title: "Shared title",
      description: "Shared description",
      hashtags: [],
    });
    expect(overrideDraftFor("tiktok", shared)).toEqual({
      title: "Shared title\nShared description",
      hashtags: [],
    });
    expect(overrideDraftFor("instagram", shared)).toEqual({
      title: "Shared title\nShared description",
      hashtags: [],
    });
  });

  it("seeds the draft's hashtags from the Upload's shared hashtag set", () => {
    const shared = { title: "Shared title", description: "Shared description" };

    expect(overrideDraftFor("youtube", shared, ["launch", "demo"])).toEqual({
      title: "Shared title",
      description: "Shared description",
      hashtags: ["launch", "demo"],
    });
  });

  it("renders collapsed editors and distinguishes shared from overridden targets", () => {
    const html = renderToStaticMarkup(createElement(PlatformOverrideEditors, {
      platforms: ["youtube", "tiktok", "instagram"],
      title: "Shared title",
      description: "Shared description",
      hashtags: ["launch"],
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
    expect(html).toContain('name="overrides.youtube.hashtags"');
  });

  it("shows the shared hashtag set for a target with no override yet", () => {
    const html = renderToStaticMarkup(createElement(PlatformOverrideEditors, {
      platforms: ["youtube"],
      title: "Shared title",
      description: "Shared description",
      hashtags: ["launch", "demo"],
      overrides: {},
      onChange: () => {},
    }));

    expect(html).toContain("#launch #demo");
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

  it("seeds the hashtags input from a Job's own override, not the Upload's shared set", () => {
    const html = renderToStaticMarkup(createElement(JobMetadataEditor, {
      job: { ...baseJob, hashtagsOverride: ["tiktokonly"] },
      sharedHashtags: ["launch", "demo"],
      onSave: () => {},
    }));

    expect(html).toContain('name="job-job-1-hashtags"');
    expect(html).toContain('value="tiktokonly"');
  });

  it("seeds the hashtags input from the Upload's shared set when the Job has no override", () => {
    const html = renderToStaticMarkup(createElement(JobMetadataEditor, {
      job: { ...baseJob, hashtagsOverride: null },
      sharedHashtags: ["launch", "demo"],
      onSave: () => {},
    }));

    expect(html).toContain('value="launch demo"');
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
