import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { resetConfigCache } from "@/lib/config";
import { createSessionToken, SESSION_COOKIE_NAME } from "@/lib/session";

function isPassthrough(response: Response): boolean {
  return response.headers.get("x-middleware-next") === "1";
}

function requestFor(path: string, cookie?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (cookie) {
    headers.cookie = `${SESSION_COOKIE_NAME}=${cookie}`;
  }
  return new NextRequest(new URL(path, "http://localhost"), { headers });
}

describe("middleware access gate", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = "file:./dev.db";
  });

  it("passes every request through when no password is configured", async () => {
    delete process.env.ACCESS_PASSWORD;
    resetConfigCache();
    const { middleware } = await import("@/middleware");

    const response = middleware(requestFor("/dashboard"));

    expect(isPassthrough(response)).toBe(true);
  });

  describe("with a password configured", () => {
    beforeEach(() => {
      process.env.ACCESS_PASSWORD = "correct horse";
      resetConfigCache();
    });

    it("redirects an unauthenticated page request to /login", async () => {
      const { middleware } = await import("@/middleware");

      const response = middleware(requestFor("/dashboard"));

      expect(response.status).toBe(307);
      const location = new URL(response.headers.get("location")!);
      expect(location.pathname).toBe("/login");
      expect(location.searchParams.get("next")).toBe("/dashboard");
    });

    it("rejects an unauthenticated API request with 401 JSON", async () => {
      const { middleware } = await import("@/middleware");

      const response = middleware(requestFor("/api/uploads"));

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    });

    it("leaves the login page and its API reachable without a session", async () => {
      const { middleware } = await import("@/middleware");

      expect(isPassthrough(middleware(requestFor("/login")))).toBe(true);
      expect(isPassthrough(middleware(requestFor("/api/auth/login")))).toBe(true);
    });

    it("leaves the health check reachable without a session", async () => {
      const { middleware } = await import("@/middleware");

      expect(isPassthrough(middleware(requestFor("/api/health")))).toBe(true);
    });

    it("admits a request carrying a valid session and renews the cookie", async () => {
      const { middleware } = await import("@/middleware");
      const token = createSessionToken("correct horse");

      const response = middleware(requestFor("/dashboard", token));

      expect(isPassthrough(response)).toBe(true);
      const renewed = response.cookies.get(SESSION_COOKIE_NAME);
      expect(renewed).toBeDefined();
      const [originalExpiry] = token.split(".");
      const [renewedExpiry] = renewed!.value.split(".");
      expect(Number(renewedExpiry)).toBeGreaterThanOrEqual(Number(originalExpiry));
    });

    it("rejects a tampered session cookie like no session at all", async () => {
      const { middleware } = await import("@/middleware");

      const response = middleware(requestFor("/dashboard", "garbage.value"));

      expect(response.status).toBe(307);
    });
  });
});
