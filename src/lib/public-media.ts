import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getConfig, isLocalOnlyRun } from "@/lib/config";
import { derivePublicMediaSigningKey } from "@/lib/token-crypto";

export const PUBLIC_MEDIA_URL_LIFETIME_MS = 60 * 60 * 1000; // 1 hour

function signatureFor(uploadId: string, expiresAt: string, nonce: string): Buffer {
  return createHmac("sha256", derivePublicMediaSigningKey())
    .update(`v1\n${uploadId}\n${expiresAt}\n${nonce}`)
    .digest();
}

export function createPublicMediaUrl(uploadId: string, now = Date.now()): URL {
  if (isLocalOnlyRun()) {
    throw new Error("Local-only runs cannot generate public media URLs");
  }
  const publicBaseUrl = getConfig().PUBLIC_BASE_URL;
  if (!publicBaseUrl) {
    throw new Error("PUBLIC_BASE_URL is required to generate a public media URL");
  }
  const expiresAt = String(now + PUBLIC_MEDIA_URL_LIFETIME_MS);
  const nonce = randomBytes(16).toString("base64url");
  const signature = signatureFor(uploadId, expiresAt, nonce).toString("base64url");
  const url = new URL(`/api/uploads/${encodeURIComponent(uploadId)}/file`, publicBaseUrl);
  url.searchParams.set("token", `v1.${expiresAt}.${nonce}.${signature}`);
  return url;
}

export function verifyPublicMediaToken(
  uploadId: string,
  token: string,
  now = Date.now(),
): boolean {
  const parts = token.split(".");
  if (parts.length !== 4) return false;
  const [version, expiresAtRaw, nonce, signature] = parts;
  if (
    version !== "v1" ||
    !/^\d+$/.test(expiresAtRaw) ||
    !/^[A-Za-z0-9_-]{22}$/.test(nonce) ||
    !/^[A-Za-z0-9_-]{43}$/.test(signature)
  ) {
    return false;
  }
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;

  const expected = signatureFor(uploadId, expiresAtRaw, nonce);
  const actual = Buffer.from(signature, "base64url");
  return (
    actual.toString("base64url") === signature &&
    actual.length === expected.length &&
    timingSafeEqual(actual, expected)
  );
}
