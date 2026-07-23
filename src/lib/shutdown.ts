import { prisma } from "@/lib/db";
import { drainJobs, stopJobRunner } from "@/lib/job-runner";

let handlersRegistered = false;

// Drain path: stop claiming new work, let in-flight uploads finish, hand
// back any lease still held so the next instance can pick that job up
// immediately instead of waiting out a lease nobody will renew, then
// disconnect.
export function registerShutdownHandlers(): void {
  if (handlersRegistered) {
    return;
  }
  handlersRegistered = true;

  const drain = async (signal: NodeJS.Signals) => {
    console.log(`Received ${signal}, draining before shutdown...`);
    stopJobRunner();
    try {
      await drainJobs();
    } catch (error) {
      console.error("failed to drain in-flight jobs", error);
    }
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on("SIGTERM", drain);
  process.on("SIGINT", drain);
}
