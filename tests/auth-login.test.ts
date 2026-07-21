import { beforeEach, describe, expect, it } from "vitest";
import { resetConfigCache } from "@/lib/config";
import { resetRateLimitState } from "@/lib/rate-limit";

function loginRequest(password: unknown, ip = "9.9.9.9") {
  return new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ password }),
  });
}

describe("POST /api/auth/login", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = "file:./dev.db";
    resetConfigCache();
    resetRateLimitState();
  });

  it("rejects with 400 when no access password is configured", async () => {
    delete process.env.ACCESS_PASSWORD;
    resetConfigCache();
    const { POST } = await import("@/app/api/auth/login/route");

    const response = await POST(loginRequest("anything"));

    expect(response.status).toBe(400);
  });

  it("issues a session cookie for the correct password", async () => {
    process.env.ACCESS_PASSWORD = "correct horse";
    resetConfigCache();
    const { POST } = await import("@/app/api/auth/login/route");

    const response = await POST(loginRequest("correct horse"));

    expect(response.status).toBe(200);
    const cookie = response.cookies.get("omnipost_session");
    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("lax");
  });

  it("rejects an incorrect password with 401 and no cookie", async () => {
    process.env.ACCESS_PASSWORD = "correct horse";
    resetConfigCache();
    const { POST } = await import("@/app/api/auth/login/route");

    const response = await POST(loginRequest("wrong password"));

    expect(response.status).toBe(401);
    expect(response.cookies.get("omnipost_session")).toBeUndefined();
  });

  it("rate-limits repeated failed attempts from the same source", async () => {
    process.env.ACCESS_PASSWORD = "correct horse";
    resetConfigCache();
    const { POST } = await import("@/app/api/auth/login/route");

    await POST(loginRequest("wrong", "8.8.8.8"));
    const second = await POST(loginRequest("wrong", "8.8.8.8"));

    expect(second.status).toBe(429);
    expect(second.headers.get("Retry-After")).toBeTruthy();
  });

  it("does not rate-limit a different source after one failure", async () => {
    process.env.ACCESS_PASSWORD = "correct horse";
    resetConfigCache();
    const { POST } = await import("@/app/api/auth/login/route");

    await POST(loginRequest("wrong", "8.8.8.8"));
    const otherSource = await POST(loginRequest("correct horse", "1.1.1.1"));

    expect(otherSource.status).toBe(200);
  });

  it("keys the rate limit on the last X-Forwarded-For hop, not a spoofable leading one", async () => {
    process.env.ACCESS_PASSWORD = "correct horse";
    resetConfigCache();
    const { POST } = await import("@/app/api/auth/login/route");

    // Same real client (last hop, set by our own reverse proxy) on every
    // attempt, but a different attacker-claimed leading hop each time.
    await POST(loginRequest("wrong", "1.1.1.1, 8.8.8.8"));
    const second = await POST(loginRequest("wrong", "2.2.2.2, 8.8.8.8"));

    expect(second.status).toBe(429);
  });
});
