import { createHash, timingSafeEqual } from "node:crypto";

// Hash both sides to a fixed-length digest before comparing: comparing
// raw strings of different lengths short-circuits (and therefore leaks
// length via timing) before reaching a constant-time comparison at all.
export function verifyPassword(candidate: string, configured: string): boolean {
  const candidateDigest = createHash("sha256").update(candidate).digest();
  const configuredDigest = createHash("sha256").update(configured).digest();
  return timingSafeEqual(candidateDigest, configuredDigest);
}
