import { describe, expect, it } from "vitest";
import {
  applyHashtags,
  composeCaption,
  composedCaptionViolation,
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
    ["Title", "Description", "Title\n\nDescription"],
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
      { key: "caption", label: "Caption", maxLength: 2_200, value: "My Short\n\nA short clip" },
    ]);
    expect(outboundTextFor("instagram", authored)).toEqual([
      { key: "caption", label: "Caption", maxLength: 2_200, value: "My Short\n\nA short clip" },
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

  it("sets hashtags off as their own block at the end of the caption for caption platforms", () => {
    const authored = { title: "My Short", description: "A short clip" };
    const applied = applyHashtags("tiktok", authored, ["launch", "demo"]);
    expect(outboundTextFor("tiktok", applied)).toEqual([
      { key: "caption", label: "Caption", maxLength: 2_200, value: "My Short\n\nA short clip\n\n#launch #demo" },
    ]);
  });

  it("returns the authored text unchanged when there are no hashtags", () => {
    const authored = { title: "My Short", description: "A short clip" };
    expect(applyHashtags("youtube", authored, [])).toBe(authored);
    expect(applyHashtags("tiktok", authored, [])).toBe(authored);
  });
});

describe("composed caption length", () => {
  const overflowing = { title: "", description: "x".repeat(2_201) };

  it("names the platform and its limit when the composed caption overflows", () => {
    expect(composedCaptionViolation("tiktok", overflowing))
      .toBe("tiktok caption must be 2200 characters or fewer");
  });

  it("measures the composed caption rather than any single field", () => {
    // Both fields fit comfortably on their own. What the platform actually
    // receives is the two of them joined, and that does not.
    const authored = { title: "x".repeat(1_200), description: "y".repeat(1_200) };
    expect(composedCaptionViolation("tiktok", authored))
      .toContain("2200 characters or fewer");
  });

  it("counts hashtags as part of the caption they are composed into", () => {
    // The gap this closes: the hashtags are what tip the caption over, and
    // the field they land in was the one nothing ever measured.
    const authored = { title: "Title", description: "y".repeat(2_190) };
    expect(composedCaptionViolation("tiktok", authored)).toBeNull();
    expect(composedCaptionViolation(
      "tiktok",
      applyHashtags("tiktok", authored, ["overflow"]),
    )).toContain("2200 characters or fewer");
  });

  it("blocks only the platform whose limit the text overflows", () => {
    expect(composedCaptionViolation("instagram", overflowing)).not.toBeNull();
    expect(composedCaptionViolation("youtube", overflowing)).toBeNull();
  });

  it("leaves platforms with no caption limit alone", () => {
    expect(composedCaptionViolation("youtube", overflowing)).toBeNull();
    expect(composedCaptionViolation("dry-run", overflowing)).toBeNull();
  });

  it("accepts a caption sitting exactly on the limit", () => {
    expect(composedCaptionViolation("instagram", {
      title: "",
      description: "x".repeat(2_200),
    })).toBeNull();
  });
});
