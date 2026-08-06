// What a booting instance says about itself. Kept out of instrumentation.ts
// so the Node-only `process.exit` below is never bundled for the Edge runtime,
// where Turbopack would flag it on every boot as an unsupported API.

import { platformsWithSkippedConfig } from "@/lib/config";
import { PLATFORM_LABEL } from "@/lib/platform";

/**
 * The last thing an operator reads when boot fails. Next has already printed
 * `✓ Ready` by the time instrumentation runs, so this has to contradict it
 * outright — otherwise the natural next move is to check the browser rather
 * than scroll up. The failure itself comes last, where it will be read.
 *
 * It points at the address Next printed rather than naming one: Next picks a
 * different port when the configured one is taken, so any URL derived here
 * would sooner or later be the wrong one.
 */
export function bootFailureReport(error: unknown): string {
  const failure = error instanceof Error ? error.message : String(error);
  return [
    "",
    `✗ OmniPost did not start. Ignore the "Ready" line above — nothing is`,
    "  listening on the address it printed.",
    "",
    failure,
  ].join("\n");
}

/**
 * What a local-only run is giving up, or null when it gives up nothing. Said
 * at boot so the operator learns a platform is unconnectable now, rather than
 * from an OAuth route failing later.
 */
export function localOnlyNotice(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const skipped = platformsWithSkippedConfig(env);
  if (skipped.length === 0) return null;

  const names = skipped.map((platform) => PLATFORM_LABEL[platform]).join(" and ");
  const subject = skipped.length > 1 ? "those platforms" : "that platform";
  return `[omnipost] Local-only run: skipping ${names} configuration. Without PUBLIC_BASE_URL ${subject} cannot be connected — use npm run dev for a run that can.`;
}

export function reportBootFailure(error: unknown): never {
  // Next.js logs a thrown instrumentation error but does not itself exit the
  // process — left alone, the server keeps accepting requests in a half-booted
  // state. Force the exit so an orchestrator sees the failure.
  console.error(bootFailureReport(error));
  process.exit(1);
}
