// The terminal adapter for the Launcher lifecycle: `start`, `status`, and
// `open` (ADR-0004). It reads the operator's environment, prints what happened,
// and turns the lifecycle state into an exit status — every decision about what
// a session is and whether it may start belongs to scripts/launcher/.
import { environmentFrom } from "./launcher/environment.mjs";
import { logs, open, restart, start, status, stopSession } from "./launcher/lifecycle.mjs";
import { createRedactor } from "./launcher/session-log.mjs";

const envValue = environmentFrom(process.cwd());
const redact = createRedactor(envValue);

// Everything this adapter says about a lifecycle state, in one place: what to
// call it, what `status` exits with so a script can branch on the state without
// reading English, and what to tell someone who wanted a page to open. (`start`
// and `open` are ordinary commands: they succeeded or they did not.)
const STATES = {
  running: { label: "Running", exit: 0 },
  starting: {
    label: "Starting",
    exit: 3,
    advice: "Wait for it to finish starting, then try again.",
  },
  stopping: {
    label: "Stopping",
    exit: 3,
    advice: "OmniPost may still be finishing an active Job.",
  },
  stopped: { label: "Stopped", exit: 4, advice: "Start OmniPost with `npm run launch`." },
  failed: { label: "Failed", exit: 5, advice: "Start OmniPost with `npm run launch`." },
};

function describe(result) {
  const lines = [`OmniPost is ${STATES[result.state].label}.`];
  if (result.phase) lines.push(`Phase: ${result.phase}`);
  if (result.sessionId) lines.push(`Session: ${result.sessionId}`);
  if (result.startedAt) lines.push(`Started: ${result.startedAt}`);
  if (result.appUrl) lines.push(`Address: ${result.appUrl}`);
  if (result.failure) lines.push(`Failure: ${result.failure}`);
  if (result.logPath) lines.push(`Log: ${result.logPath}`);
  return lines.join("\n");
}

const commands = {
  async start() {
    const result = await start({
      env: envValue,
      cwd: process.cwd(),
      rebuild: process.argv.includes("--rebuild"),
    });
    if (result.state !== "running") {
      console.error(redact(describe(result)));
      return 1;
    }
    if (!result.started) console.log("OmniPost is already running; bringing its tab forward.");
    return 0;
  },

  async status() {
    const result = await status({ env: envValue });
    console.log(redact(describe(result)));
    return STATES[result.state].exit;
  },

  async open() {
    const result = await open({ env: envValue });
    if (result.opened) return 0;
    console.error(redact(`${describe(result)}\n${STATES[result.state].advice}`));
    return 1;
  },

  async logs() {
    const result = logs({ env: envValue });
    if (!result.available) {
      console.error(redact(result.reason));
      return 1;
    }
    process.stdout.write(redact(result.content));
    return 0;
  },

  async stop() {
    const result = await stopSession({
      env: envValue,
      keepWaiting: process.argv.includes("--wait"),
      force: process.argv.includes("--force"),
    });
    if (result.state === "stopped") {
      if (process.argv.includes("--force") && !result.alreadyStopped) {
        console.log(
          "OmniPost was force stopped. Interrupted Jobs recover through existing Lease and Transfer state.",
        );
      } else {
        console.log(
          result.alreadyStopped ? "OmniPost is already stopped." : "OmniPost stopped cleanly.",
        );
      }
      return 0;
    }
    const choices = result.forceRefused
      ? result.failure
      : result.timedOut
      ? "Keep waiting with `npm run launch:stop -- --wait`, or explicitly force stop with " +
        "`npm run launch:stop -- --force`."
      : STATES[result.state].advice;
    console.error(redact(`${describe(result)}\n${choices}`));
    return 1;
  },

  async restart() {
    const result = await restart({
      env: envValue,
      cwd: process.cwd(),
      rebuild: process.argv.includes("--rebuild"),
    });
    if (result.state === "running") return 0;
    console.error(redact(`${describe(result)}\n${STATES[result.state].advice}`));
    return 1;
  },
};

async function main() {
  const [name = "start"] = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
  const command = commands[name];
  if (!command) {
    console.error(`Unknown Launcher command: ${name}. Use ${Object.keys(commands).join(", ")}.`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = await command();
}

main().catch((error) => {
  console.error(redact(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
