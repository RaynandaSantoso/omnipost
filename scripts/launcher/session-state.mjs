// Who owns the one production Launcher session on this Mac.
//
// Exactly one supervisor may own a session, so ownership is a file the
// supervisor creates exclusively: whoever creates it first has the session, and
// everybody else must either join it (open the browser) or stand down. The
// record is also the only durable trace a crashed supervisor leaves behind, so
// it carries enough to answer "is that session still real?" without trusting
// itself: the owning process id *and* the operating system's own start time for
// that id, which is what stops a recycled process id from impersonating a
// session that died.
//
// Nothing here decides lifecycle state — see lifecycle.mjs. This module only
// stores, verifies, and clears the record.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { LauncherError } from "./errors.mjs";

const STATE_FILE = "session.json";
const RECORDED_STATES = ["starting", "running", "stopping", "failed"];
// Absolute, because a launch may be validating a PATH that has already been
// found wanting — verifying an owner must not depend on the operator's PATH.
const PS = "/bin/ps";

/**
 * Where the Launcher keeps state that belongs to this operator and not to the
 * repository. Overridable so tests never touch the real one.
 */
export function runtimeDirectory(env) {
  return (
    env("OMNIPOST_RUNTIME_DIR") ||
    path.join(homedir(), "Library", "Application Support", "OmniPost")
  );
}

function statePath(env) {
  return path.join(runtimeDirectory(env), STATE_FILE);
}

/**
 * The operating system's start time for a process id, or null when no such
 * process exists. Recorded with the id it belongs to, so a later launch can
 * tell the owner it remembers from an unrelated process that has since been
 * given the same id.
 */
function processStartTime(pid) {
  const result = spawnSync(PS, ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

/** True only when the process that wrote this record is still the one running. */
export function ownerAlive(record) {
  if (!record?.processStartTime) return false;
  return processStartTime(record.pid) === record.processStartTime;
}

function isCompleteRecord(record) {
  return (
    record !== null &&
    typeof record === "object" &&
    Number.isInteger(record.pid) &&
    record.pid > 0 &&
    typeof record.processStartTime === "string" &&
    typeof record.sessionId === "string" &&
    typeof record.startedAt === "string" &&
    RECORDED_STATES.includes(record.state) &&
    URL.canParse(record.appUrl)
  );
}

/**
 * The current ownership record: null when nobody has claimed the session, and
 * `{ unreadable: true }` when a record exists but cannot be trusted — a partial
 * write, a hand-edited file, or one written by something that is not this
 * Launcher. An unreadable record is never a reason to refuse a launch.
 */
export function readOwnership(env) {
  let raw;
  try {
    raw = readFileSync(statePath(env), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    const record = JSON.parse(raw);
    return isCompleteRecord(record) ? record : { unreadable: true };
  } catch {
    return { unreadable: true };
  }
}

/**
 * Take the session for this process, or return null when somebody else already
 * holds it. Claiming the one name is what makes two simultaneous launches
 * resolve to a single owner, and writing the record is also the proof that the
 * runtime location is usable at all.
 */
export function claimOwnership(env, { appUrl }) {
  const directory = runtimeDirectory(env);
  const startTime = processStartTime(process.pid);
  if (!startTime) {
    // Without it, the record could not be told apart from one left by a process
    // that has died, and two launches could each believe they were alone.
    throw new LauncherError(
      `OmniPost could not read its own process start time through ${PS}, so it ` +
        "cannot claim this Mac safely.",
    );
  }
  const record = {
    sessionId: randomUUID(),
    pid: process.pid,
    processStartTime: startTime,
    startedAt: new Date().toISOString(),
    state: "starting",
    phase: "Checking prerequisites",
    appUrl,
  };
  // Written in full beside the real name and then linked into place, because
  // creating the file and filling it are two steps: a launch that read the
  // record in between would find an empty one, call it junk, and clear the
  // ownership somebody else had just taken. Linking fails if the name is taken,
  // so the record still appears exactly once, and appears complete.
  const claim = `${statePath(env)}.${process.pid}.claim`;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(claim, JSON.stringify(record), { mode: 0o600 });
    linkSync(claim, statePath(env));
  } catch (error) {
    if (error?.code === "EEXIST") return null;
    throw new LauncherError(
      `OmniPost cannot write its runtime state to ${directory} ` +
        `(${error?.code ?? error?.message}). Grant write access to that location, then launch again.`,
    );
  } finally {
    rmSync(claim, { force: true });
  }
  return record;
}

/**
 * Replace the record the owner holds. Written beside the real file and renamed
 * over it, so a reader never sees half a record however badly the write goes.
 */
export function updateOwnership(env, record, changes) {
  const next = { ...record, ...changes };
  const file = statePath(env);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
  renameSync(temporary, file);
  return next;
}

/** Discard a record whose owner has already been shown to be gone. */
export function removeOwnership(env) {
  rmSync(statePath(env), { force: true });
}

/** Give up a session this process still owns, leaving a newer owner's alone. */
export function releaseOwnership(env, record) {
  if (readOwnership(env)?.sessionId !== record.sessionId) return;
  removeOwnership(env);
}
