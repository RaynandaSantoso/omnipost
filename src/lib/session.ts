import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE_NAME = "omnipost_session";
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, sliding

// The session secret is derived from the configured password rather than a
// separate env var: it keeps setup to one variable, and rotating the
// password naturally invalidates every outstanding session.
function deriveSecret(password: string): Buffer {
  return createHash("sha256").update(password).digest();
}

function sign(secret: Buffer, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

// Token shape: `<expiresAtMs>.<hmac-hex>`. Opaque, not JWT — there is
// exactly one claim, so a standard format would only add parsing surface.
export function createSessionToken(
  password: string,
  now: number = Date.now(),
): string {
  const expiresAt = now + SESSION_MAX_AGE_MS;
  const secret = deriveSecret(password);
  const signature = sign(secret, String(expiresAt));
  return `${expiresAt}.${signature}`;
}

export function verifySessionToken(
  token: string,
  password: string,
  now: number = Date.now(),
): boolean {
  const [expiresAtRaw, signature] = token.split(".");
  if (!expiresAtRaw || !signature) {
    return false;
  }

  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    return false;
  }

  const secret = deriveSecret(password);
  const expected = sign(secret, expiresAtRaw);

  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(signature, "hex");
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

export function isHttps(request: Request): boolean {
  return (
    new URL(request.url).protocol === "https:" ||
    request.headers.get("x-forwarded-proto") === "https"
  );
}

let warnedAboutPlaintext = false;

// Where the app can detect plaintext (no HTTPS and no
// X-Forwarded-Proto: https), it logs a startup-style warning rather than
// refusing to boot — TLS termination is a documented deployment
// precondition, not something the app can enforce from behind a proxy.
// Warn once per process so a plaintext deployment isn't silent, without
// spamming the log on every request.
export function warnIfPlaintext(request: Request): void {
  if (isHttps(request) || warnedAboutPlaintext) {
    return;
  }
  warnedAboutPlaintext = true;
  console.warn(
    "[omnipost] Received a request over plaintext HTTP. Non-localhost deployments " +
      "must run behind a TLS-terminating reverse proxy — see README.",
  );
}

interface CookieResponse {
  cookies: {
    set(name: string, value: string, options: Record<string, unknown>): void;
  };
}

export function issueSessionCookie(
  response: CookieResponse,
  request: Request,
  password: string,
): void {
  response.cookies.set(SESSION_COOKIE_NAME, createSessionToken(password), {
    httpOnly: true,
    secure: isHttps(request),
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_MS / 1000,
  });
}

// Test-only: isolate the once-per-process plaintext warning between test cases.
export function resetPlaintextWarning(): void {
  warnedAboutPlaintext = false;
}
