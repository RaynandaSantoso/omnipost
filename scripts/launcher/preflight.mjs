// Everything the Launcher checks *before* it starts a long-running process.
//
// A production session is several processes acting as one system: the app, the
// reserved tunnel, and idle-sleep prevention. If any prerequisite is wrong, the
// operator must learn it here — while nothing is running — rather than see a
// healthy public tunnel in front of an app that refused to boot. So nothing in
// this module starts, writes, or changes anything: it only reads configuration,
// the filesystem, and the local port.
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { connect } from "node:net";
import path from "node:path";

import { LauncherError } from "./errors.mjs";

// Kept in step with MIN_ACCESS_PASSWORD_LENGTH in src/lib/config.ts, which the
// launcher cannot import across the .mjs/TypeScript boundary; a test asserts the
// two agree. The app refuses to boot below it, and preflight exists so the
// operator hears that from the Launcher instead of from a dead tunnel.
export const MIN_ACCESS_PASSWORD_LENGTH = 16;

// Resolved on PATH before anything starts. `next` runs the build and the app,
// `ngrok` is the mandatory reserved tunnel (ADR-0004), `caffeinate` holds off
// idle sleep, and `open` puts the dashboard in front of the operator.
const REQUIRED_COMMANDS = ["next", "ngrok", "caffeinate", "open"];

const CALLBACK_PATHS = [
  ["TIKTOK_REDIRECT_URI", "/api/platforms/tiktok/callback"],
  ["INSTAGRAM_REDIRECT_URI", "/api/platforms/instagram/callback"],
];

/**
 * The local origin the production app is served on. Exported because a launch
 * needs it before preflight runs — session ownership records the origin it is
 * claiming — and both paths must read the same setting the same way.
 */
export function launchOrigin(value) {
  let appUrl;
  try {
    appUrl = new URL(value);
  } catch {
    throw new LauncherError("OMNIPOST_LAUNCH_URL must be a valid HTTP URL.");
  }
  if (!["http:", "https:"].includes(appUrl.protocol) || appUrl.pathname !== "/") {
    throw new LauncherError("OMNIPOST_LAUNCH_URL must be an HTTP origin without a path.");
  }
  return appUrl;
}

function requiredAccessPassword(env) {
  const password = env("ACCESS_PASSWORD");
  if (!password) {
    throw new LauncherError(
      "ACCESS_PASSWORD is required when PUBLIC_BASE_URL is configured: the public " +
        "origin is reachable from the internet, so the password gate is what keeps " +
        "publishing rights yours. Add it to .env.",
    );
  }
  if (password.length < MIN_ACCESS_PASSWORD_LENGTH) {
    throw new LauncherError(
      `ACCESS_PASSWORD must be at least ${MIN_ACCESS_PASSWORD_LENGTH} characters, ` +
        "because it is the only thing defending a public origin. OmniPost would " +
        "refuse to boot with the one in .env.",
    );
  }
}

function requiredPublicOrigin(env) {
  const publicBaseUrl = env("PUBLIC_BASE_URL");
  if (!publicBaseUrl) {
    throw new LauncherError("PUBLIC_BASE_URL is required by the OmniPost Launcher.");
  }

  let publicOrigin;
  try {
    publicOrigin = new URL(publicBaseUrl);
  } catch {
    throw new LauncherError("PUBLIC_BASE_URL must be a valid URL.");
  }
  if (
    publicOrigin.protocol !== "https:" ||
    publicOrigin.pathname !== "/" ||
    publicOrigin.search ||
    publicOrigin.hash ||
    publicBaseUrl.includes("?") ||
    publicBaseUrl.includes("#") ||
    publicOrigin.username ||
    publicOrigin.password
  ) {
    throw new LauncherError(
      "PUBLIC_BASE_URL must be an HTTPS origin without a path, query, fragment, or credentials.",
    );
  }
  return publicOrigin;
}

function callbackOrigins(env, publicOrigin) {
  for (const [name, callbackPath] of CALLBACK_PATHS) {
    const redirectUri = env(name);
    if (!redirectUri) continue;
    let redirect;
    try {
      redirect = new URL(redirectUri);
    } catch {
      throw new LauncherError(`${name} must be a valid URL.`);
    }
    if (
      redirect.origin !== publicOrigin.origin ||
      redirect.pathname !== callbackPath ||
      redirect.search ||
      redirect.hash ||
      redirectUri.includes("?") ||
      redirectUri.includes("#") ||
      redirect.username ||
      redirect.password
    ) {
      throw new LauncherError(
        `${name} must use PUBLIC_BASE_URL and end exactly in ${callbackPath}.`,
      );
    }
  }
}

function executableOnPath(name, env) {
  for (const entry of (env("PATH") ?? "").split(path.delimiter)) {
    if (!entry) continue;
    const candidate = path.join(entry, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function requiredCommands(env) {
  for (const name of REQUIRED_COMMANDS) {
    if (executableOnPath(name, env)) continue;
    throw new LauncherError(
      `${name} is required by the OmniPost Launcher but was not found on PATH. ` +
        "Install it, then launch again.",
    );
  }
}

const PORT_PROBE_TIMEOUT_MS = 500;

/**
 * True when a listener already accepts connections on the port. The caller has
 * already ruled out OmniPost itself answering there, so anything still holding
 * the port is an unrelated occupant and must not be launched over. The probe
 * dials the configured hostname rather than one loopback address, so a `localhost`
 * occupant is found whichever address family it listens on.
 */
function portInUse(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    const settle = (inUse) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

/**
 * True when the working directory holds a production build the Launcher can
 * start. A missing or blank build id means a build phase, not a failure.
 */
function productionBuildReady(cwd) {
  try {
    return readFileSync(path.join(cwd, ".next", "BUILD_ID"), "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Validate every prerequisite of a production session and describe the session
 * that may then be started. Throws LauncherError naming the first prerequisite
 * that fails; starts nothing either way.
 */
export async function preflight({ env, cwd, appUrl }) {
  const publicOrigin = requiredPublicOrigin(env);
  requiredAccessPassword(env);
  callbackOrigins(env, publicOrigin);
  requiredCommands(env);

  const port = appUrl.port || (appUrl.protocol === "https:" ? "443" : "80");
  if (await portInUse(appUrl.hostname, Number(port))) {
    throw new LauncherError(
      `Port ${port} is already in use by another process, and OmniPost is not ` +
        "answering there. Stop that process, or point OMNIPOST_LAUNCH_URL at a free port.",
    );
  }

  return {
    port,
    publicOrigin,
    buildReady: productionBuildReady(cwd),
  };
}
