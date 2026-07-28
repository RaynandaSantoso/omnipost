// Runs once when a new Next.js server instance boots. This is the boot-time
// gate: bad config must fail here, before the app serves a single request.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  try {
    const { getConfig } = await import("@/lib/config");
    getConfig();

    const { runMigrations } = await import("@/lib/migrate");
    runMigrations();

    const { ensureSeedUser } = await import("@/lib/db");
    await ensureSeedUser();

    // A database containing credentials without the encryption key is not a
    // viable instance: fail at boot instead of discovering it mid-upload.
    const { prisma } = await import("@/lib/db");
    const connection = await prisma.platformConnection.findFirst();
    if (connection) {
      const { assertTokenEncryptionKey } = await import("@/lib/token-crypto");
      assertTokenEncryptionKey();
    }

    // One-off backfill for connections created before externalAccountLabel
    // existed. Runs every boot but is a no-op once every connection has a
    // label, so it's cheap to leave in place rather than tracking "has this
    // run before" separately.
    const { backfillExternalAccountLabels } = await import("@/lib/youtube-oauth");
    await backfillExternalAccountLabels();

    const { registerShutdownHandlers } = await import("@/lib/shutdown");
    registerShutdownHandlers();

    const { recoverStalledJobs, startJobRunner } = await import(
      "@/lib/job-runner"
    );
    // Before this instance claims anything, settle whatever the previous
    // one left behind — otherwise a job interrupted by a restart sits in
    // "uploading" until its lease lapses, or forever if it was orphaned.
    await recoverStalledJobs();
    startJobRunner();
  } catch (error) {
    // Next.js logs a thrown instrumentation error but does not itself exit
    // the process — left alone, the server keeps accepting requests in a
    // half-booted state. Force the exit so an orchestrator sees the failure.
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
