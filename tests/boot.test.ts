import { describe, expect, it } from "vitest";
import { bootFailureReport, localOnlyNotice } from "@/lib/boot";
import { ConfigError, LOCAL_ONLY_ENV_VAR } from "@/lib/config";

describe("bootFailureReport", () => {
  it("contradicts the Ready line Next has already printed", () => {
    const report = bootFailureReport(new ConfigError("Invalid configuration"));

    expect(report).toContain("did not start");
    expect(report).toContain("Ready");
  });

  it("ends with the failure itself, so it is the last thing read", () => {
    const report = bootFailureReport(new ConfigError("DATABASE_URL is required"));

    expect(report.trimEnd().endsWith("DATABASE_URL is required")).toBe(true);
  });

  // Next falls back to another port when the configured one is taken, so a URL
  // built here would eventually point somewhere the operator never used.
  it("points at the address Next printed rather than naming one", () => {
    expect(bootFailureReport(new ConfigError("nope"))).not.toMatch(/localhost:\d+/);
  });

  it("describes a thrown non-Error without losing it", () => {
    expect(bootFailureReport("something odd")).toContain("something odd");
  });
});

describe("localOnlyNotice", () => {
  it("names the platforms a local-only run cannot connect", () => {
    const notice = localOnlyNotice({
      DATABASE_URL: "file:./dev.db",
      TIKTOK_REDIRECT_URI: "https://omnipost.ngrok-free.app/api/platforms/tiktok/callback",
      INSTAGRAM_REDIRECT_URI:
        "https://omnipost.ngrok-free.app/api/platforms/instagram/callback",
      [LOCAL_ONLY_ENV_VAR]: "1",
    });

    expect(notice).toContain("TikTok");
    expect(notice).toContain("Instagram");
    expect(notice).toContain("PUBLIC_BASE_URL");
  });

  it("reads as one platform when only one is skipped", () => {
    const notice = localOnlyNotice({
      DATABASE_URL: "file:./dev.db",
      TIKTOK_REDIRECT_URI: "https://omnipost.ngrok-free.app/api/platforms/tiktok/callback",
      [LOCAL_ONLY_ENV_VAR]: "1",
    });

    expect(notice).toContain("skipping TikTok configuration");
    expect(notice).toContain("that platform cannot be connected");
  });

  it("says nothing when there is nothing to skip", () => {
    expect(
      localOnlyNotice({
        DATABASE_URL: "file:./dev.db",
        [LOCAL_ONLY_ENV_VAR]: "1",
      }),
    ).toBeNull();
  });

  it("says nothing for a run that is not local-only", () => {
    expect(
      localOnlyNotice({
        DATABASE_URL: "file:./dev.db",
        TIKTOK_REDIRECT_URI: "https://omnipost.ngrok-free.app/api/platforms/tiktok/callback",
      }),
    ).toBeNull();
  });
});
