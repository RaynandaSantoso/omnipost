// The Launcher's lifecycle: start, status, and open, over one owned production
// session (ADR-0004).
//
// This is the seam. Its callers ask for start, status, or open and nothing
// else: no caller supervises a process, probes health, or reads the ownership
// record itself, so two callers cannot come to disagree about what Running is.
//
// Two rules shape everything below. Ordering: preflight runs while nothing is
// running, the app is health-checked before the public tunnel exists, and the
// browser opens last — so a public entry point never fronts an app that is not
// there. Ownership: Running is never inferred from a state file or from a port
// that answers, but from the recorded supervisor still being the process that
// wrote the record *and* the app still answering. An unrelated process that
// takes over the port, or one that inherits a recycled process id, is not this
// session and is never treated as one.
import { spawn } from "node:child_process";

import { LauncherError } from "./errors.mjs";
import { launchOrigin, preflight } from "./preflight.mjs";
import {
  claimOwnership,
  ownerAlive,
  readOwnership,
  releaseOwnership,
  removeOwnership,
  updateOwnership,
} from "./session-state.mjs";

const DEFAULT_APP_URL = "http://localhost:3000";
const DEFAULT_READY_TIMEOUT_MS = 120_000;
const HEALTH_POLL_INTERVAL_MS = 250;
const HEALTH_REQUEST_TIMEOUT_MS = 750;
// How long a companion process must survive before it counts as started. ngrok
// fails by exiting immediately (an unauthenticated agent, a domain already
// claimed), and that must be caught before the browser opens. A process that
// dies after this window still ends the session — it just does so after the
// tab is open, because liveness is all this session can ask of a tunnel.
const COMPANION_SETTLE_MS = 500;
// A losing claim means another launch got there first, and re-reading tells us
// which one; a handful of attempts is enough for that to settle.
const OWNERSHIP_ATTEMPTS = 3;

async function appAnswers(appUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_REQUEST_TIMEOUT_MS);
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

// One supervisor process owns one session, so its managed children and its
// ownership record are process-wide facts rather than per-call ones.
const managed = [];
let session = null;
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

/**
 * Change what this session records about itself. Nothing is written once the
 * session is stopping: ownership has been given up by then, and writing again
 * would put a record back that nobody owns.
 */
function updateSession(changes) {
  if (!session || stopping) return;
  session.record = updateOwnership(session.env, session.record, changes);
}

/**
 * Record where this session got to, so `status` can report a phase while it is
 * Starting, and say the same thing the operator is watching in the terminal.
 */
function phase(text) {
  console.log(text);
  updateSession({ phase: text });
}

/**
 * Keep the reason this session ended. A Failed record is deliberately left
 * behind when the supervisor exits — it is all the next `status` has to explain
 * a session that died with nobody watching.
 */
function recordFailure(message) {
  if (session?.record.state === "failed") return;
  updateSession({ state: "failed", phase: null, failure: message });
}

/**
 * Stop owning the session — unless it failed, because a Failed record is left
 * behind on purpose for the next `status` to explain.
 */
function releaseSession() {
  if (session && session.record.state !== "failed") releaseOwnership(session.env, session.record);
}

function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const { child } of managed) signalTree(child, signal);
  releaseSession();
}

function fail(message) {
  if (!stopping) {
    console.error(message);
    recordFailure(message);
  }
  process.exitCode = 1;
  stop();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => stop(signal));
}
// However this supervisor leaves, it stops owning the session — otherwise the
// next launch would have to wait for a dead owner to be noticed.
process.on("exit", releaseSession);

/**
 * Start a process this session owns. A required process that exits on its own
 * ends the whole session: OmniPost does not run in a partly working shape.
 */
function startManaged(name, command, args) {
  const child = spawnCommand(command, args);
  const managedProcess = { name, child, exited: false };
  managed.push(managedProcess);
  child.on("error", (error) => {
    managedProcess.exited = true;
    fail(`Could not start ${name}: ${error.message}`);
  });
  child.on("exit", () => {
    managedProcess.exited = true;
    const index = managed.indexOf(managedProcess);
    if (index >= 0) managed.splice(index, 1);
    if (stopping) return;
    fail(
      ready
        ? `${name} exited, so OmniPost is stopping the rest of this session.`
        : `${name} exited before OmniPost was ready.`,
    );
  });
  return managedProcess;
}

/** Run a one-shot command to completion, rejecting on a non-zero exit. */
async function commandResult(command, args) {
  const child = spawnCommand(command, args);
  const managedProcess = { name: `${command} ${args.join(" ")}`, child, exited: false };
  managed.push(managedProcess);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      managedProcess.exited = true;
      const index = managed.indexOf(managedProcess);
      if (index >= 0) managed.splice(index, 1);
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code ?? signal}`));
    });
  });
}

async function openBrowser(appUrl) {
  await commandResult("open", [appUrl]);
}

async function waitForHealth(env, appUrl) {
  const configuredTimeout = Number(env("OMNIPOST_LAUNCH_TIMEOUT_MS"));
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
async function stayedAlive(managedProcess) {
  const deadline = Date.now() + COMPANION_SETTLE_MS;
  while (Date.now() < deadline) {
    if (stopping || managedProcess.exited) return false;
    await delay(25);
  }
  return !stopping && !managedProcess.exited;
}

function sessionSummary(record, changes) {
  return {
    sessionId: record.sessionId,
    startedAt: record.startedAt,
    appUrl: record.appUrl,
    ...changes,
  };
}

/**
 * What the one production session is doing: Starting, Running, Stopped, or
 * Failed, with whatever the caller needs to explain it. Running is a claim
 * about two verified facts — the recorded supervisor is still that process, and
 * OmniPost still answers — so neither a leftover record nor an unrelated
 * process on the port can produce it. The tunnel is covered by the first of
 * those: a session whose tunnel exits stops the rest of itself and records the
 * failure, so a live supervisor is one whose companions are still up.
 */
export async function status({ env }) {
  const record = readOwnership(env);
  if (!record || record.unreadable) return { state: "stopped" };

  if (!ownerAlive(record)) {
    return sessionSummary(record, {
      state: "failed",
      failure:
        record.failure ??
        "The Launcher session ended without stopping cleanly. Launch OmniPost again.",
    });
  }
  if (record.state === "failed") {
    return sessionSummary(record, { state: "failed", failure: record.failure });
  }
  if (record.state === "starting") {
    return sessionSummary(record, { state: "starting", phase: record.phase });
  }
  if (await appAnswers(new URL(record.appUrl))) return sessionSummary(record, { state: "running" });
  return sessionSummary(record, {
    state: "failed",
    failure: `OmniPost has stopped answering at ${record.appUrl}.`,
  });
}

/**
 * Bring OmniPost's browser tab forward. Only a verified Running session has a
 * page worth opening; anything else is answered with the state that stopped it,
 * so the caller can say what to do instead.
 */
export async function open({ env }) {
  const current = await status({ env });
  if (current.state !== "running") return { ...current, opened: false };
  await openBrowser(current.appUrl);
  return { ...current, opened: true };
}

/**
 * Take the session for this process. Ownership left by an owner that is gone —
 * or a record too damaged to identify one — is cleared and re-taken, so a crash
 * never blocks the next launch; ownership held by a live owner is left alone.
 */
async function takeOwnership(env, appUrl) {
  for (let attempt = 0; attempt < OWNERSHIP_ATTEMPTS; attempt += 1) {
    const existing = readOwnership(env);
    if (existing && ownerAlive(existing)) {
      throw new LauncherError(
        "Another OmniPost Launcher session already owns this Mac. Run " +
          "`npm run launch:status` to see what it is doing.",
      );
    }
    if (existing) {
      // Both halves of the claim are tested before it is thrown away: the
      // owner is gone, and nothing it left behind is still serving. An
      // unreadable record names no address to ask about, so there is nothing
      // to test and nothing that could be recovered by keeping it.
      if (!existing.unreadable && (await appAnswers(new URL(existing.appUrl)))) {
        throw new LauncherError(
          `The Launcher no longer owns the session at ${existing.appUrl}, but something ` +
            "is still answering there. Stop it, then launch OmniPost again.",
        );
      }
      removeOwnership(env);
    }
    const record = claimOwnership(env, { appUrl: appUrl.href });
    if (record) return record;
  }
  throw new LauncherError(
    "OmniPost could not take ownership of this Mac: another launch keeps claiming " +
      "it. Wait for it to finish, then launch again.",
  );
}

/**
 * Start the complete production runtime, or join the one already running. The
 * caller gets the session's resulting state; a prerequisite it cannot get past
 * is thrown as a LauncherError, having started nothing.
 */
export async function start({ env, cwd, rebuild }) {
  const appUrl = launchOrigin(env("OMNIPOST_LAUNCH_URL") || DEFAULT_APP_URL);

  // A second launch against a session that is already answering is just a
  // request to come back to the dashboard.
  const current = await status({ env });
  if (current.state === "running") {
    await openBrowser(current.appUrl);
    return { ...current, started: false, opened: true };
  }
  if (current.state === "starting") return { ...current, started: false };

  session = { env, record: await takeOwnership(env, appUrl) };
  try {
    return await startSession({ env, cwd, rebuild, appUrl });
  } catch (error) {
    recordFailure(error instanceof Error ? error.message : String(error));
    stop();
    throw error;
  }
}

async function startSession({ env, cwd, rebuild, appUrl }) {
  const { port, publicOrigin, buildReady } = await preflight({ env, cwd, appUrl });

  console.log("Starting OmniPost:");
  console.log(`- OmniPost: ${appUrl.href}`);
  console.log(`- Reserved public tunnel: ${publicOrigin.origin}`);
  console.log("This Mac will stay awake while OmniPost is running.");
  console.log("Press Ctrl+C to stop every service.");

  // Held first, so neither a long build nor a health wait is interrupted by
  // idle sleep. It is released on every way out of this session.
  startManaged("Idle-sleep inhibitor", "caffeinate", ["-i"]);

  if (rebuild || !buildReady) {
    phase(rebuild ? "Rebuilding OmniPost for production" : "Building OmniPost for production");
    await commandResult("next", ["build"]);
  } else {
    console.log("Using the existing production build. Pass --rebuild after changing code.");
  }
  if (stopping) return await status({ env });

  phase("Waiting for OmniPost to answer its health endpoint");
  startManaged("OmniPost", "next", ["start", "-p", port]);
  if (!(await waitForHealth(env, appUrl))) return await status({ env });

  phase(`Opening the reserved public tunnel at ${publicOrigin.origin}`);
  const tunnel = startManaged("Reserved public tunnel", "ngrok", [
    "http",
    `--url=${publicOrigin.hostname}`,
    port,
  ]);
  if (!(await stayedAlive(tunnel))) return await status({ env });

  ready = true;
  updateSession({ state: "running", phase: null });
  console.log("OmniPost is ready.");
  await openBrowser(appUrl.href);
  return { ...sessionSummary(session.record, { state: "running" }), started: true, opened: true };
}
