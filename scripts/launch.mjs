// The terminal adapter for the Launcher lifecycle: `start`, `status`, and
// `open` (ADR-0004). It reads the operator's environment, prints what happened,
// and turns the lifecycle state into an exit status — every decision about what
// a session is and whether it may start belongs to scripts/launcher/.
import { readFileSync } from "node:fs";

import { open, start, status } from "./launcher/lifecycle.mjs";

function readEnvFile(path) {
  try {
    return Object.fromEntries(
      readFileSync(path, "utf8")
        .split(/\r?\n/)
        .map((line) => line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/))
        .filter(Boolean)
        .map((match) => {
          const value = match[2];
          const quoted =
            value.length >= 2 &&
            ((value.startsWith('"') && value.endsWith('"')) ||
              (value.startsWith("'") && value.endsWith("'")));
          return [match[1], quoted ? value.slice(1, -1) : value];
        }),
    );
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

const fileEnv = {
  ...readEnvFile(".env"),
  ...readEnvFile(".env.local"),
};
const envValue = (name) => process.env[name] ?? fileEnv[name];

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
      console.error(describe(result));
      return 1;
    }
    if (!result.started) console.log("OmniPost is already running; bringing its tab forward.");
    return 0;
  },

  async status() {
    const result = await status({ env: envValue });
    console.log(describe(result));
    return STATES[result.state].exit;
  },

  async open() {
    const result = await open({ env: envValue });
    if (result.opened) return 0;
    console.error(`${describe(result)}\n${STATES[result.state].advice}`);
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
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
