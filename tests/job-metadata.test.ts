import { describe, expect, it } from "vitest";
import { resolveJobMetadata } from "@/lib/job-metadata";

describe("resolveJobMetadata", () => {
  it("falls back to the Upload's shared text when a Job has no overrides", () => {
    expect(resolveJobMetadata(
      { platform: "youtube", titleOverride: null, descriptionOverride: null },
      { title: "Shared title", description: "Shared description" },
    )).toEqual({
      title: "Shared title",
      description: "Shared description",
    });
  });

  it("applies one Job's overrides without changing a sibling Job", () => {
    const upload = { title: "Shared title", description: "Shared description" };

    expect(resolveJobMetadata(
      {
        platform: "youtube",
        titleOverride: "YouTube title",
        descriptionOverride: "YouTube description",
      },
      upload,
    )).toEqual({
      title: "YouTube title",
      description: "YouTube description",
    });
    expect(resolveJobMetadata(
      { platform: "instagram", titleOverride: null, descriptionOverride: null },
      upload,
    )).toEqual(upload);
  });

  it("treats a caption override as finished outbound text", () => {
    expect(resolveJobMetadata(
      {
        platform: "tiktok",
        titleOverride: "A finished TikTok caption #shorts",
        descriptionOverride: null,
      },
      { title: "Shared title", description: "Shared description" },
    )).toEqual({
      title: "A finished TikTok caption #shorts",
      description: "",
    });
  });

  it("composes the Upload's shared hashtags into the description for a title-and-description platform", () => {
    expect(resolveJobMetadata(
      { platform: "youtube", titleOverride: null, descriptionOverride: null },
      { title: "Shared title", description: "Shared description", hashtags: ["launch", "demo"] },
    )).toEqual({
      title: "Shared title",
      description: "Shared description\n\n#launch #demo",
    });
  });

  it("composes the Upload's shared hashtags inline for a caption platform with no override", () => {
    expect(resolveJobMetadata(
      { platform: "tiktok", titleOverride: null, descriptionOverride: null },
      { title: "Shared title", description: "Shared description", hashtags: ["launch"] },
    )).toEqual({
      title: "Shared title",
      description: "Shared description #launch",
    });
  });

  it("does not append hashtags on top of a finished caption override", () => {
    expect(resolveJobMetadata(
      {
        platform: "tiktok",
        titleOverride: "A finished TikTok caption #shorts",
        descriptionOverride: null,
      },
      { title: "Shared title", description: "Shared description", hashtags: ["launch"] },
    )).toEqual({
      title: "A finished TikTok caption #shorts",
      description: "",
    });
  });

  it("leaves resolved text unchanged when the Upload has no hashtags", () => {
    expect(resolveJobMetadata(
      { platform: "youtube", titleOverride: null, descriptionOverride: null },
      { title: "Shared title", description: "Shared description", hashtags: [] },
    )).toEqual({
      title: "Shared title",
      description: "Shared description",
    });
  });

  it("composes a Job's overridden hashtags instead of the Upload's shared set", () => {
    expect(resolveJobMetadata(
      {
        platform: "youtube",
        titleOverride: null,
        descriptionOverride: null,
        hashtagsOverride: JSON.stringify(["tiktokonly"]),
      },
      { title: "Shared title", description: "Shared description", hashtags: ["launch", "demo"] },
    )).toEqual({
      title: "Shared title",
      description: "Shared description\n\n#tiktokonly",
    });
  });

  it("does not compose hashtags for a Job whose override explicitly clears them to none", () => {
    expect(resolveJobMetadata(
      {
        platform: "youtube",
        titleOverride: null,
        descriptionOverride: null,
        hashtagsOverride: JSON.stringify([]),
      },
      { title: "Shared title", description: "Shared description", hashtags: ["launch"] },
    )).toEqual({
      title: "Shared title",
      description: "Shared description",
    });
  });

  it("leaves a sibling Job's hashtags on the Upload's shared set", () => {
    const upload = { title: "Shared title", description: "Shared description", hashtags: ["launch"] };
    expect(resolveJobMetadata(
      { platform: "instagram", titleOverride: null, descriptionOverride: null },
      upload,
    )).toEqual({
      title: "Shared title",
      description: "Shared description #launch",
    });
  });

  it("does not compose hashtags on top of a finished caption override even with a hashtag override set", () => {
    expect(resolveJobMetadata(
      {
        platform: "tiktok",
        titleOverride: "A finished TikTok caption #shorts",
        descriptionOverride: null,
        hashtagsOverride: JSON.stringify(["ignored"]),
      },
      { title: "Shared title", description: "Shared description", hashtags: ["launch"] },
    )).toEqual({
      title: "A finished TikTok caption #shorts",
      description: "",
    });
  });
});
