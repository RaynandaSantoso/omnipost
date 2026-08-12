// The daily-use production Launcher: one command that owns the whole OmniPost
// runtime — the production app, the reserved ngrok tunnel, and idle-sleep
// prevention — as a single session (ADR-0004).
//
// The order below is the point. Preflight validates every prerequisite while
// nothing is running (scripts/launcher/preflight.mjs), the app is started and
// health-checked before the public tunnel exists, and the browser opens only
// once the app answers and every required process is still alive. If any step
// fails, everything already started is stopped, so the operator never sees a
// public entry point in front of an app that is not there.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

import { launchOrigin, preflight } from "./launcher/preflight.mjs";

const DEFAULT_APP_URL = "http://localhost:3000";
const DEFAULT_READY_TIMEOUT_MS = 120_000;
const HEALTH_POLL_INTERVAL_MS = 250;
// How long a companion process must survive before it counts as started. ngrok
// fails by exiting immediately (an unauthenticated agent, a domain already
// claimed), and that must be caught before the browser opens. A process that
// dies after this window still ends the session — it just does so after the
// tab is open, because liveness is all this session can ask of a tunnel.
const COMPANION_SETTLE_MS = 500;

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

async function appAnswers(appUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 750);
  try {
    await fetch(new URL("/api/health", appUrl), {
      cache: "no-store",
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const managed = [];
let stopping = false;
let ready = false;

function spawnCommand(command, args) {
  return spawn(command, args, {
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
}

function signalTree(child, signal) {
  if (!child.pid || child.killed) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const { child } of managed) signalTree(child, signal);
}

function fail(message) {
  if (!stopping) console.error(message);
  process.exitCode = 1;
  stop();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => stop(signal));
}

/**
 * Start a process this session owns. A required process that exits on its own
 * ends the whole session: OmniPost does not run in a partly working shape.
 */
function startManaged(name, command, args) {
  const child = spawnCommand(command, args);
  const record = { name, child, exited: false };
  managed.push(record);
  child.on("error", (error) => {
    record.exited = true;
    fail(`Could not start ${name}: ${error.message}`);
  });
  child.on("exit", () => {
    record.exited = true;
    const index = managed.indexOf(record);
    if (index >= 0) managed.splice(index, 1);
    if (stopping) return;
    fail(
      ready
        ? `${name} exited, so OmniPost is stopping the rest of this session.`
        : `${name} exited before OmniPost was ready.`,
    );
  });
  return record;
}

/** Run a one-shot command to completion, rejecting on a non-zero exit. */
async function commandResult(command, args) {
  const child = spawnCommand(command, args);
  const record = { name: `${command} ${args.join(" ")}`, child, exited: false };
  managed.push(record);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      record.exited = true;
      const index = managed.indexOf(record);
      if (index >= 0) managed.splice(index, 1);
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code ?? signal}`));
    });
  });
}

async function openBrowser(appUrl) {
  await commandResult("open", [appUrl.href]);
}

async function waitForHealth(appUrl) {
  const configuredTimeout = Number(envValue("OMNIPOST_LAUNCH_TIMEOUT_MS"));
  const timeoutMs =
    Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? configuredTimeout
      : DEFAULT_READY_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  while (!stopping && Date.now() < deadline) {
    if (await appAnswers(appUrl)) return true;
    await delay(HEALTH_POLL_INTERVAL_MS);
  }
  if (!stopping) {
    fail(`OmniPost did not answer at ${appUrl.href} within ${timeoutMs}ms.`);
  }
  return false;
}

/** Wait out the settle window, so a companion that dies at once is caught. */
async function stayedAlive(record) {
  const deadline = Date.now() + COMPANION_SETTLE_MS;
  while (Date.now() < deadline) {
    if (stopping || record.exited) return false;
    await delay(25);
  }
  return !stopping && !record.exited;
}

async function main() {
  const appUrl = launchOrigin(envValue("OMNIPOST_LAUNCH_URL") || DEFAULT_APP_URL);

  // A second launch against a session that is already answering is just a
  // request to come back to the dashboard.
  if (await appAnswers(appUrl)) {
    await openBrowser(appUrl);
    return;
  }

  const { port, publicOrigin, buildReady } = await preflight({
    env: envValue,
    cwd: process.cwd(),
    appUrl,
  });

  console.log("Starting OmniPost:");
  console.log(`- OmniPost: ${appUrl.href}`);
  console.log(`- Reserved public tunnel: ${publicOrigin.origin}`);
  console.log("This Mac will stay awake while OmniPost is running.");
  console.log("Press Ctrl+C to stop every service.");

  // Held first, so neither a long build nor a health wait is interrupted by
  // idle sleep. It is released on every way out of this session.
  startManaged("Idle-sleep inhibitor", "caffeinate", ["-i"]);

  const rebuildRequested = process.argv.includes("--rebuild");
  if (rebuildRequested || !buildReady) {
    console.log(
      rebuildRequested
        ? "Rebuilding OmniPost for production..."
        : "Building OmniPost for production...",
    );
    await commandResult("next", ["build"]);
  } else {
    console.log("Using the existing production build. Pass --rebuild after changing code.");
  }
  if (stopping) return;

  console.log("Waiting for OmniPost to answer its health endpoint...");
  startManaged("OmniPost", "next", ["start", "-p", port]);
  if (!(await waitForHealth(appUrl))) return;

  console.log(`Opening the reserved public tunnel at ${publicOrigin.origin}...`);
  const tunnel = startManaged("Reserved public tunnel", "ngrok", [
    "http",
    `--url=${publicOrigin.hostname}`,
    port,
  ]);
  if (!(await stayedAlive(tunnel))) return;

  ready = true;
  console.log("OmniPost is ready.");
  await openBrowser(appUrl);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
