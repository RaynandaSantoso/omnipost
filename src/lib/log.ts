import { randomUUID } from "node:crypto";

// A short id linking one terminal log line to the error message a caller
// sees, without exposing exception detail (stack, Prisma internals) to the
// client. Never pass raw request/response bodies here — only Error.message
// and Error.stack are logged, so a caller must not stuff secrets into those.
export function logError(scope: string, error: unknown): string {
  const requestId = randomUUID().slice(0, 8);
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  console.error(`[omnipost] [${scope}] [${requestId}] ${message}${stack ? `\n${stack}` : ""}`);
  return requestId;
}
