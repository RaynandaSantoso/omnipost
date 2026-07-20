import { prisma } from "@/lib/db";

let handlersRegistered = false;

// Stub drain path: safe today because no Job can be mid-flight yet. Once the
// job engine exists, extend this to wait for/release in-flight leases before
// disconnecting.
export function registerShutdownHandlers(): void {
  if (handlersRegistered) {
    return;
  }
  handlersRegistered = true;

  const drain = async (signal: NodeJS.Signals) => {
    console.log(`Received ${signal}, draining before shutdown...`);
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on("SIGTERM", drain);
  process.on("SIGINT", drain);
}
