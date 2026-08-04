import { describe, expect, it } from "vitest";
import {
  ConfigError,
  LOCAL_ONLY_ENV_VAR,
  loadConfig,
  platformsWithSkippedConfig,
} from "@/lib/config";

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

describe("a fresh checkout", () => {
  it("names .env.example when nothing at all is configured", () => {
    let caught: unknown;
    try {
      loadConfig({});
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as Error).message).toContain(".env.example");
  });

  // Next sets NODE_ENV itself, so its presence says nothing about whether the
  // operator has configured anything — the hint has to survive it.
  it("still names .env.example when only the runtime's own NODE_ENV is set", () => {
    expect(() => loadConfig({ NODE_ENV: "development" })).toThrow(/\.env\.example/);
  });

  it("stays quiet about .env.example once anything is configured", () => {
    expect(() => loadConfig({ TOKEN_ENCRYPTION_KEY: "irrelevant" })).toThrow(
      /DATABASE_URL/,
    );
    expect(() => loadConfig({ TOKEN_ENCRYPTION_KEY: "irrelevant" })).not.toThrow(
      /\.env\.example/,
    );
  });
});

describe("local-only mode", () => {
  const tunnelLeftovers = {
    DATABASE_URL: "file:./dev.db",
    TIKTOK_REDIRECT_URI: "https://omnipost.ngrok-free.app/api/platforms/tiktok/callback",
    INSTAGRAM_REDIRECT_URI:
      "https://omnipost.ngrok-free.app/api/platforms/instagram/callback",
  };

  it("starts on a tunnel .env that has lost its public origin", () => {
    const config = loadConfig({ ...tunnelLeftovers, [LOCAL_ONLY_ENV_VAR]: "1" });

    expect(config.DATABASE_URL).toBe("file:./dev.db");
  });

  it("drops the platform config it cannot honour rather than keeping it half-usable", () => {
    const config = loadConfig({ ...tunnelLeftovers, [LOCAL_ONLY_ENV_VAR]: "1" });

    expect(config.TIKTOK_REDIRECT_URI).toBeUndefined();
    expect(config.INSTAGRAM_REDIRECT_URI).toBeUndefined();
  });

  it("names the platforms whose config it skipped", () => {
    expect(platformsWithSkippedConfig({ ...tunnelLeftovers, [LOCAL_ONLY_ENV_VAR]: "1" }))
      .toEqual(["tiktok", "instagram"]);
  });

  it("skips nothing when only the platforms it can honour are configured", () => {
    expect(
      platformsWithSkippedConfig({
        DATABASE_URL: "file:./dev.db",
        YOUTUBE_REDIRECT_URI: "http://localhost:3000/api/platforms/youtube/callback",
        [LOCAL_ONLY_ENV_VAR]: "1",
      }),
    ).toEqual([]);
  });

  it("leaves YouTube alone, since it needs no tunnel", () => {
    const config = loadConfig({
      ...tunnelLeftovers,
      YOUTUBE_REDIRECT_URI: "http://localhost:3000/api/platforms/youtube/callback",
      [LOCAL_ONLY_ENV_VAR]: "1",
    });

    expect(config.YOUTUBE_REDIRECT_URI).toBe(
      "http://localhost:3000/api/platforms/youtube/callback",
    );
  });

  it("still validates the tunnel config when a public origin is present", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: "file:./dev.db",
        PUBLIC_BASE_URL: "https://omnipost.ngrok-free.app",
        TIKTOK_REDIRECT_URI: "https://other.ngrok-free.app/api/platforms/tiktok/callback",
        [LOCAL_ONLY_ENV_VAR]: "1",
      }),
    ).toThrow(/TIKTOK_REDIRECT_URI/);
    expect(platformsWithSkippedConfig({ ...tunnelLeftovers, PUBLIC_BASE_URL: "https://omnipost.ngrok-free.app", [LOCAL_ONLY_ENV_VAR]: "1" }))
      .toEqual([]);
  });

  // Nothing but the dev:app launcher sets the variable, but an environment can
  // inherit anything. Production must refuse this configuration regardless.
  it("is ignored in production, however the variable got there", () => {
    const productionRun = {
      ...tunnelLeftovers,
      NODE_ENV: "production",
      [LOCAL_ONLY_ENV_VAR]: "1",
    };

    expect(() => loadConfig(productionRun)).toThrow(
      /TIKTOK_REDIRECT_URI requires PUBLIC_BASE_URL/,
    );
    expect(platformsWithSkippedConfig(productionRun)).toEqual([]);
  });

  // The relaxation is opt-in and belongs to one command. `npm run dev` and
  // production must keep refusing the same configuration this mode accepts,
  // so a leftover tunnel .env can never quietly reach a deployed instance.
  it("does not relax anything for a run that did not ask for it", () => {
    expect(() => loadConfig(tunnelLeftovers)).toThrow(
      /TIKTOK_REDIRECT_URI requires PUBLIC_BASE_URL/,
    );
    expect(() => loadConfig({ ...tunnelLeftovers, NODE_ENV: "production" })).toThrow(
      /requires PUBLIC_BASE_URL/,
    );
    expect(platformsWithSkippedConfig(tunnelLeftovers)).toEqual([]);
  });
});
