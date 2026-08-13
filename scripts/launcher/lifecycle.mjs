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
import { randomUUID } from "node:crypto";

import { LauncherError } from "./errors.mjs";
import { launchOrigin, preflight } from "./preflight.mjs";
import { createRedactor, createSessionLog, readSessionLog } from "./session-log.mjs";
import {
  claimOwnership,
  ownerAlive,
  processIdentity,
  processIdentityAlive,
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
const DEFAULT_STOP_TIMEOUT_MS = 30_000;
const FORCE_STOP_SIGNAL = "SIGUSR2";
// A losing claim means another launch got there first, and re-reading tells us
// which one; a handful of attempts is enough for that to settle.
const OWNERSHIP_ATTEMPTS = 3;
const SUPERVISOR_PROCESS_TOKEN = process.env.OMNIPOST_LAUNCHER_PROCESS_ID ?? randomUUID();
process.env.OMNIPOST_LAUNCHER_PROCESS_ID = SUPERVISOR_PROCESS_TOKEN;
process.title = `OmniPost-Launcher-${SUPERVISOR_PROCESS_TOKEN}`;

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
let shutdownPromise = null;
let shutdownProcesses = [];

function spawnCommand(command, args) {
  const processToken = randomUUID();
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    env: { ...process.env, OMNIPOST_LAUNCHER_PROCESS_ID: processToken },
  });
  child.launcherProcessToken = processToken;
  return child;
}

function spawnLogged(name, command, args) {
  const child = spawnCommand(command, args);
  session?.logger?.write(name, "stdout", `Starting ${command} ${args.join(" ")}`);
  if (child.stdout) session?.logger?.capture(name, "stdout", child.stdout, process.stdout);
  if (child.stderr) session?.logger?.capture(name, "stderr", child.stderr, process.stderr);
  return child;
}

function recordManagedProcesses() {
  if (!session || stopping) return;
  session.record = updateOwnership(session.env, session.record, {
    managedProcesses: managed
      .map(({ name, child }) => {
        const identity = processIdentity(child.pid, child.launcherProcessToken);
        return identity ? { name, ...identity } : null;
      })
      .filter(Boolean),
  });
}

function supervisor(stream, text) {
  session?.logger?.write("Supervisor", stream, text);
  (stream === "stderr" ? console.error : console.log)(session?.logger?.redact(text) ?? text);
}

function signalProcessGroup(pid, signal) {
  if (!pid) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function signalTree(child, signal) {
  signalProcessGroup(child.pid, signal);
}

function recordedGroupAlive(managedProcess) {
  try {
    process.kill(process.platform === "win32" ? managedProcess.pid : -managedProcess.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function registerManaged(managedProcess) {
  managed.push(managedProcess);
  recordManagedProcesses();
}

function unregisterManaged(managedProcess) {
  const index = managed.indexOf(managedProcess);
  if (index >= 0) managed.splice(index, 1);
  recordManagedProcesses();
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
  supervisor("stdout", text);
  updateSession({ phase: text });
}

/**
 * Keep the reason this session ended. A Failed record is deliberately left
 * behind when the supervisor exits — it is all the next `status` has to explain
 * a session that died with nobody watching.
 */
function recordFailure(message) {
  if (session?.record.state === "failed") return;
  const safeMessage = session?.logger?.redact(message) ?? createRedactor(session.env)(message);
  updateSession({ state: "failed", phase: null, failure: safeMessage });
}

/**
 * Stop owning the session — unless it failed, because a Failed record is left
 * behind on purpose for the next `status` to explain.
 */
function releaseSession() {
  if (session && session.record.state !== "failed") releaseOwnership(session.env, session.record);
}

function processGroupAlive(child) {
  if (!child.pid) return false;
  if (process.platform === "win32") return !child.killed;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForExit(managedProcess) {
  if (!managedProcess.exited) {
    await new Promise((resolve) => managedProcess.child.once("exit", resolve));
  }
  while (processGroupAlive(managedProcess.child)) await delay(25);
}

function stop(signal = "SIGTERM") {
  if (shutdownPromise) return shutdownPromise;
  const failed = session?.record.state === "failed";
  if (session && !failed) {
    session.record = updateOwnership(session.env, session.record, {
      state: "stopping",
      phase: "Waiting for managed processes to exit",
    });
  }
  stopping = true;
  shutdownProcesses = [...managed];
  const gracefulTimeout = setTimeout(() => {
    if (!session) return;
    const failure = session.record.state === "failed";
    session.record = updateOwnership(session.env, session.record, {
      state: failure ? "failed" : "stopping",
      phase: "OmniPost may still be finishing an active Job",
      forceAllowed: true,
    });
  }, configuredStopTimeout(session?.env ?? (() => undefined), false));
  shutdownPromise = (async () => {
    for (const { child } of shutdownProcesses) signalTree(child, signal);
    await Promise.all(shutdownProcesses.map(waitForExit));
    clearTimeout(gracefulTimeout);
    if (!failed) releaseSession();
  })();
  return shutdownPromise;
}

function forceStop() {
  if (!stopping || !shutdownPromise) return;
  if (session) {
    supervisor(
      "stderr",
      "Force stopping owned processes. Interrupted Jobs recover through existing Lease and Transfer state.",
    );
    session.record = updateOwnership(session.env, session.record, {
      state: "stopping",
      phase: "Force stopping owned processes",
    });
  }
  for (const { child } of shutdownProcesses) signalTree(child, "SIGKILL");
}

function fail(message) {
  if (!stopping) {
    supervisor("stderr", message);
    recordFailure(message);
  }
  process.exitCode = 1;
  stop();
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => stop("SIGTERM"));
}
process.on(FORCE_STOP_SIGNAL, forceStop);
// However this supervisor leaves, it stops owning the session — otherwise the
// next launch would have to wait for a dead owner to be noticed.
process.on("exit", releaseSession);

/**
 * Start a process this session owns. A required process that exits on its own
 * ends the whole session: OmniPost does not run in a partly working shape.
 */
function startManaged(name, command, args) {
  const child = spawnLogged(name, command, args);
  const managedProcess = { name, child, exited: false };
  registerManaged(managedProcess);
  child.on("error", (error) => {
    managedProcess.exited = true;
    fail(`Could not start ${name}: ${error.message}`);
  });
  child.on("exit", () => {
    managedProcess.exited = true;
    unregisterManaged(managedProcess);
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
async function commandResult(command, args, name = `${command} ${args.join(" ")}`) {
  const child = spawnLogged(name, command, args);
  const managedProcess = { name, child, exited: false };
  registerManaged(managedProcess);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      managedProcess.exited = true;
      unregisterManaged(managedProcess);
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code ?? signal}`));
    });
  });
}

async function openBrowser(appUrl) {
  await commandResult("open", [appUrl], "Browser");
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
    logPath: record.logPath,
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
  if (record.state === "stopping") {
    return sessionSummary(record, { state: "stopping", phase: record.phase });
  }
  if (await appAnswers(new URL(record.appUrl))) return sessionSummary(record, { state: "running" });
  const failure = `OmniPost has stopped answering at ${record.appUrl}.`;
  let failedRecord = record;
  try {
    const logger = createSessionLog(env, record.sessionId);
    logger.write("Supervisor", "stderr", failure);
    failedRecord = updateOwnership(env, record, { state: "failed", phase: null, failure });
  } catch {
    // Status is still useful when diagnostics cannot be persisted. The next
    // call will recompute the same safe failure rather than breaking status.
  }
  return sessionSummary(failedRecord, {
    state: "failed",
    failure,
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

/** Read the current or most recent session log without making its location a chore. */
export function logs({ env }) {
  return readSessionLog(env, readOwnership(env));
}

function configuredStopTimeout(env, keepWaiting) {
  const value = Number(
    env(keepWaiting ? "OMNIPOST_STOP_WAIT_TIMEOUT_MS" : "OMNIPOST_STOP_TIMEOUT_MS"),
  );
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_STOP_TIMEOUT_MS;
}

async function waitForSession(env, record, timeoutMs, pollMs, condition = () => false) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = readOwnership(env);
    if (!current || current.sessionId !== record.sessionId) return "released";
    if (condition(current)) return "matched";
    await delay(pollMs);
  }
  return "timeout";
}

/** Ask the verified owner to stop, then observe ownership until cleanup finishes. */
export async function stopSession({ env, keepWaiting = false, force = false }) {
  const record = readOwnership(env);
  if (!record || record.unreadable) return { state: "stopped", alreadyStopped: true };
  if (!ownerAlive(record)) {
    return sessionSummary(record, {
      state: "failed",
      failure: "The Launcher owner is gone, so its managed processes could not be stopped safely.",
    });
  }

  if (
    force &&
    ((record.state !== "stopping" && record.state !== "failed") ||
      record.forceAllowed !== true)
  ) {
    return sessionSummary(record, {
      state: record.state,
      forceRefused: true,
      failure: "Force Stop is available only after graceful shutdown times out.",
    });
  }

  if (force) process.kill(record.pid, FORCE_STOP_SIGNAL);
  else if (record.state !== "stopping") {
    process.kill(record.pid, "SIGTERM");
  }
  const timeoutMs = configuredStopTimeout(env, keepWaiting || force);
  const stopped = await waitForSession(
    env,
    record,
    timeoutMs,
    25,
    (current) => record.state === "failed" && !ownerAlive(current),
  );
  if (stopped === "released" || stopped === "matched") {
    return sessionSummary(record, { state: "stopped", alreadyStopped: false });
  }
  const forcePermission = await waitForSession(
    env,
    record,
    500,
    10,
    (current) => current.forceAllowed === true,
  );
  if (forcePermission === "released") {
    return sessionSummary(record, { state: "stopped", alreadyStopped: false });
  }
  if (force) {
    const failure =
      "Force Stop could not verify that every owned process exited. " +
      "Open Launcher logs, then try stopping again.";
    const failedRecord = updateOwnership(env, readOwnership(env), {
      state: "failed",
      phase: null,
      failure,
    });
    return sessionSummary(failedRecord, { state: "failed", failure });
  }
  return sessionSummary(record, {
    state: "stopping",
    timedOut: true,
    phase: "OmniPost may still be finishing an active Job",
  });
}

/** Restart deliberately has no second lifecycle: it is stop followed by start. */
export async function restart({ env, cwd, rebuild }) {
  const stopped = await stopSession({ env });
  if (stopped.state !== "stopped") return stopped;
  return start({ env, cwd, rebuild });
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
      if (!existing.unreadable && Array.isArray(existing.managedProcesses)) {
        const ownedGroups = existing.managedProcesses.filter(processIdentityAlive);
        for (const managedProcess of ownedGroups) {
          signalProcessGroup(managedProcess.pid, "SIGTERM");
        }
        if (ownedGroups.length > 0) {
          const deadline = Date.now() + configuredStopTimeout(env, false);
          while (ownedGroups.some(recordedGroupAlive) && Date.now() < deadline) await delay(25);
          const survivors = ownedGroups.filter(recordedGroupAlive);
          if (survivors.length > 0) {
            const names = survivors.map(({ name }) => name).join(", ");
            const failure =
              `Recovery could not stop these verified processes: ${names}. ` +
              "Open Launcher logs, then stop them before launching again.";
            updateOwnership(env, existing, { state: "failed", phase: null, failure });
            throw new LauncherError(failure);
          }
        }
      }
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
    const record = claimOwnership(env, {
      appUrl: appUrl.href,
      token: SUPERVISOR_PROCESS_TOKEN,
    });
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
    session.logger = createSessionLog(env, session.record.sessionId);
    session.record = updateOwnership(env, session.record, { logPath: session.logger.logPath });
    return await startSession({ env, cwd, rebuild, appUrl });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message = session.logger
      ? detail
      : `OmniPost could not create its session log in the configured log location (${detail}).`;
    session.logger?.write("Supervisor", "stderr", message);
    recordFailure(message);
    stop();
    throw error;
  }
}

async function startSession({ env, cwd, rebuild, appUrl }) {
  const { port, publicOrigin, buildReady } = await preflight({ env, cwd, appUrl });

  supervisor("stdout", "Starting OmniPost:");
  supervisor("stdout", `- OmniPost: ${appUrl.href}`);
  supervisor("stdout", `- Reserved public tunnel: ${publicOrigin.origin}`);
  supervisor("stdout", "This Mac will stay awake while OmniPost is running.");
  supervisor("stdout", "Press Ctrl+C to stop every service.");

  // Held first, so neither a long build nor a health wait is interrupted by
  // idle sleep. It is released on every way out of this session.
  startManaged("Idle-sleep inhibitor", "caffeinate", ["-i"]);

  if (rebuild || !buildReady) {
    phase(rebuild ? "Rebuilding OmniPost for production" : "Building OmniPost for production");
    await commandResult("next", ["build"], "Build");
  } else {
    supervisor("stdout", "Using the existing production build. Pass --rebuild after changing code.");
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
  supervisor("stdout", "OmniPost is ready.");
  await openBrowser(appUrl.href);
  return { ...sessionSummary(session.record, { state: "running" }), started: true, opened: true };
}
