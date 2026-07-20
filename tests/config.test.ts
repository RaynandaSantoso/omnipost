import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "@/lib/config";

describe("loadConfig", () => {
  it("accepts a sqlite file: DATABASE_URL", () => {
    const config = loadConfig({
      DATABASE_URL: "file:./dev.db",
    });

    expect(config.DATABASE_URL).toBe("file:./dev.db");
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
});
