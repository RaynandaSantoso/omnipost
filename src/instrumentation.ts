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

    const { registerShutdownHandlers } = await import("@/lib/shutdown");
    registerShutdownHandlers();
  } catch (error) {
    // Next.js logs a thrown instrumentation error but does not itself exit
    // the process — left alone, the server keeps accepting requests in a
    // half-booted state. Force the exit so an orchestrator sees the failure.
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
