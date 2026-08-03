import { describe, expect, it } from "vitest";
import {
  applyHashtags,
  composeCaption,
  formatHashtags,
  outboundTextFor,
  uploadPolicyFor,
} from "@/lib/platform-upload-policy";

describe("platform text policy", () => {
  it("declares the text shape and documented limits for every Platform", () => {
    expect(uploadPolicyFor("dry-run").text).toMatchObject({
      kind: "title-and-description",
      titleMaxLength: null,
      descriptionMaxLength: null,
    });
    expect(uploadPolicyFor("youtube").text).toMatchObject({
      kind: "title-and-description",
      titleMaxLength: 100,
      descriptionMaxLength: 5_000,
    });
    expect(uploadPolicyFor("tiktok").text).toMatchObject({
      kind: "caption",
      captionMaxLength: 2_200,
    });
    expect(uploadPolicyFor("instagram").text).toMatchObject({
      kind: "caption",
      captionMaxLength: 2_200,
    });
  });

  it.each([
    ["Title", "Description", "Title\nDescription"],
    ["Title", "", "Title"],
    ["", "Description", "Description"],
    ["", "", ""],
  ])("composes caption fields with the established newline rule", (title, description, expected) => {
    expect(composeCaption({ title, description })).toBe(expected);
  });

  it("renders title-and-description and caption shapes without platform-specific callers", () => {
    const authored = { title: "My Short", description: "A short clip" };

    expect(outboundTextFor("youtube", authored)).toEqual([
      { key: "title", label: "Title", maxLength: 100, value: "My Short" },
      { key: "description", label: "Description", maxLength: 5_000, value: "A short clip" },
    ]);
    expect(outboundTextFor("tiktok", authored)).toEqual([
      { key: "caption", label: "Caption", maxLength: 2_200, value: "My Short\nA short clip" },
    ]);
    expect(outboundTextFor("instagram", authored)).toEqual([
      { key: "caption", label: "Caption", maxLength: 2_200, value: "My Short\nA short clip" },
    ]);
  });

  it.each([
    [["launch", "demo"], "#launch #demo"],
    [["#already-tagged"], "#already-tagged"],
    [[" spaced ", ""], "#spaced"],
    [[], ""],
  ])("formats a hashtag set as space-separated, #-prefixed text", (hashtags, expected) => {
    expect(formatHashtags(hashtags)).toBe(expected);
  });

  it("places hashtags in the description for title-and-description platforms", () => {
    const authored = { title: "My Short", description: "A short clip" };
    expect(applyHashtags("youtube", authored, ["launch", "demo"])).toEqual({
      title: "My Short",
      description: "A short clip\n\n#launch #demo",
    });
  });

  it("appends hashtags inline to the end of the caption for caption platforms", () => {
    const authored = { title: "My Short", description: "A short clip" };
    const applied = applyHashtags("tiktok", authored, ["launch", "demo"]);
    expect(outboundTextFor("tiktok", applied)).toEqual([
      { key: "caption", label: "Caption", maxLength: 2_200, value: "My Short\nA short clip #launch #demo" },
    ]);
  });

  it("returns the authored text unchanged when there are no hashtags", () => {
    const authored = { title: "My Short", description: "A short clip" };
    expect(applyHashtags("youtube", authored, [])).toBe(authored);
    expect(applyHashtags("tiktok", authored, [])).toBe(authored);
  });
});
