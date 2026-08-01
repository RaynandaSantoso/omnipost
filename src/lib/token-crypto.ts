import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import { getConfig } from "@/lib/config";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

export class TokenCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenCryptoError";
  }
}

function encryptionKey(): Buffer {
  const raw = getConfig().TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new TokenCryptoError(
      "TOKEN_ENCRYPTION_KEY is required for encrypted credentials and public media URLs",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new TokenCryptoError("TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  return key;
}

export function assertTokenEncryptionKey(): void {
  encryptionKey();
}

export function derivePublicMediaSigningKey(): Buffer {
  return createHmac("sha256", encryptionKey())
    .update("omnipost-public-media-v1")
    .digest();
}

export function encryptToken(token: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv, encrypted, tag].map((part) =>
    typeof part === "string" ? part : part.toString("base64url"),
  ).join(".");
}

export function decryptToken(value: string): string {
  const [version, ivValue, encryptedValue, tagValue] = value.split(".");
  if (version !== "v1" || !ivValue || !encryptedValue || !tagValue) {
    throw new TokenCryptoError("stored token ciphertext is invalid");
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, encryptionKey(), Buffer.from(ivValue, "base64url"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new TokenCryptoError("stored token could not be decrypted; reconnect YouTube");
  }
}
