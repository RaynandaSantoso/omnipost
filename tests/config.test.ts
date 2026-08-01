import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "@/lib/config";

describe("loadConfig", () => {
  it("accepts a sqlite file: DATABASE_URL", () => {
    const config = loadConfig({
      DATABASE_URL: "file:./dev.db",
    });

    expect(config.DATABASE_URL).toBe("file:./dev.db");
  });

  it("accepts an HTTPS public origin used by platform callback URLs", () => {
    const config = loadConfig({
      DATABASE_URL: "file:./dev.db",
      PUBLIC_BASE_URL: "https://omnipost.ngrok-free.app",
      TIKTOK_REDIRECT_URI:
        "https://omnipost.ngrok-free.app/api/platforms/tiktok/callback",
      INSTAGRAM_REDIRECT_URI:
        "https://omnipost.ngrok-free.app/api/platforms/instagram/callback",
    });

    expect(config.PUBLIC_BASE_URL).toBe("https://omnipost.ngrok-free.app");
  });

  it.each([
    "http://omnipost.ngrok-free.app",
    "https://omnipost.ngrok-free.app/a/path",
    "https://omnipost.ngrok-free.app?mode=dev",
    "https://omnipost.ngrok-free.app?",
    "https://omnipost.ngrok-free.app#fragment",
    "https://omnipost.ngrok-free.app#",
    "https://operator:password@omnipost.ngrok-free.app",
  ])("rejects a public base URL that is not an HTTPS origin", (publicBaseUrl) => {
    expect(() =>
      loadConfig({
        DATABASE_URL: "file:./dev.db",
        PUBLIC_BASE_URL: publicBaseUrl,
      }),
    ).toThrow(/PUBLIC_BASE_URL/);
  });

  it.each([
    ["TIKTOK_REDIRECT_URI", "https://other.ngrok-free.app/api/platforms/tiktok/callback"],
    [
      "INSTAGRAM_REDIRECT_URI",
      "https://other.ngrok-free.app/api/platforms/instagram/callback",
    ],
  ])("rejects %s when it uses a different public origin", (name, redirectUri) => {
    let caught: unknown;
    try {
      loadConfig({
        DATABASE_URL: "file:./dev.db",
        PUBLIC_BASE_URL: "https://omnipost.ngrok-free.app",
        [name]: redirectUri,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as Error).message).toContain(name);
    expect((caught as Error).message).not.toContain(redirectUri);
    expect((caught as Error).message).not.toContain("other.ngrok-free.app");
  });

  it("fails fast naming DATABASE_URL when it is missing", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it("fails fast naming DATABASE_URL when malformed, without leaking the value", () => {
    const secretValue = "postgres://user:supersecret@host/db";

    let caught: unknown;
    try {
      loadConfig({ DATABASE_URL: secretValue });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    const message = (caught as Error).message;
    expect(message).toContain("DATABASE_URL");
    expect(message).not.toContain(secretValue);
    expect(message).not.toContain("supersecret");
  });

  it("defaults the job engine policy when it is not configured", () => {
    const config = loadConfig({ DATABASE_URL: "file:./dev.db" });

    expect(config.JOB_MAX_ATTEMPTS).toBe(5);
    expect(config.JOB_LEASE_MS).toBe(30_000);
    expect(config.JOB_BACKOFF_BASE_MS).toBe(1_000);
    expect(config.JOB_BACKOFF_MAX_MS).toBe(300_000);
  });

  it("reads a configured attempt budget as a number", () => {
    const config = loadConfig({
      DATABASE_URL: "file:./dev.db",
      JOB_MAX_ATTEMPTS: "3",
    });

    expect(config.JOB_MAX_ATTEMPTS).toBe(3);
  });

  it("fails fast naming a malformed job engine setting", () => {
    expect(() =>
      loadConfig({ DATABASE_URL: "file:./dev.db", JOB_MAX_ATTEMPTS: "0" }),
    ).toThrow(/JOB_MAX_ATTEMPTS/);
    expect(() =>
      loadConfig({ DATABASE_URL: "file:./dev.db", JOB_LEASE_MS: "soon" }),
    ).toThrow(/JOB_LEASE_MS/);
  });
});
