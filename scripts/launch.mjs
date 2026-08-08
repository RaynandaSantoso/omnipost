import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const DEFAULT_APP_URL = "http://localhost:3000";
const DEFAULT_READY_TIMEOUT_MS = 120_000;

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

function invalid(message) {
  throw new Error(message);
}

function launchSettings() {
  const appUrlValue = envValue("OMNIPOST_LAUNCH_URL") || DEFAULT_APP_URL;
  let appUrl;
  try {
    appUrl = new URL(appUrlValue);
  } catch {
    invalid("OMNIPOST_LAUNCH_URL must be a valid HTTP URL.");
  }
  if (!['http:', 'https:'].includes(appUrl.protocol) || appUrl.pathname !== "/") {
    invalid("OMNIPOST_LAUNCH_URL must be an HTTP origin without a path.");
  }

  const publicBaseUrl = envValue("PUBLIC_BASE_URL");
  if (!publicBaseUrl) {
    invalid("PUBLIC_BASE_URL is required by the OmniPost Launcher.");
  }
  if (!envValue("ACCESS_PASSWORD")) {
    invalid("ACCESS_PASSWORD is required when PUBLIC_BASE_URL is configured.");
  }

  let publicOrigin;
  try {
    publicOrigin = new URL(publicBaseUrl);
  } catch {
    invalid("PUBLIC_BASE_URL must be a valid URL.");
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
    invalid(
      "PUBLIC_BASE_URL must be an HTTPS origin without a path, query, fragment, or credentials.",
    );
  }

  const redirects = [
    ["TIKTOK_REDIRECT_URI", "/api/platforms/tiktok/callback"],
    ["INSTAGRAM_REDIRECT_URI", "/api/platforms/instagram/callback"],
  ];
  for (const [name, callbackPath] of redirects) {
    const redirectUri = envValue(name);
    if (!redirectUri) continue;
    let redirect;
    try {
      redirect = new URL(redirectUri);
    } catch {
      invalid(`${name} must be a valid URL.`);
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
      invalid(`${name} must use PUBLIC_BASE_URL and end exactly in ${callbackPath}.`);
    }
  }

  const port = appUrl.port || (appUrl.protocol === "https:" ? "443" : "80");
  return { appUrl, port, publicOrigin };
}

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

function spawnCommand(command, args, options = {}) {
  return spawn(command, args, {
    stdio: "inherit",
    detached: process.platform !== "win32",
    ...options,
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

async function commandResult(command, args) {
  const child = spawnCommand(command, args);
  activeChildren.push(child);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      activeChildren.splice(activeChildren.indexOf(child), 1);
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code ?? signal}`));
    });
  });
}

async function openBrowser(appUrl) {
  await commandResult("open", [appUrl.href]);
}

const activeChildren = [];
let stopping = false;

function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of activeChildren) signalTree(child, signal);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => stop(signal));
}

async function openWhenReady(appUrl) {
  const configuredTimeout = Number(envValue("OMNIPOST_LAUNCH_TIMEOUT_MS"));
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : DEFAULT_READY_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  while (!stopping && Date.now() < deadline) {
    if (await appAnswers(appUrl)) {
      await openBrowser(appUrl);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!stopping) {
    console.error(`OmniPost did not answer at ${appUrl.href} within ${timeoutMs}ms.`);
    process.exitCode = 1;
    stop();
  }
}

async function main() {
  const appUrlValue = envValue("OMNIPOST_LAUNCH_URL") || DEFAULT_APP_URL;
  let probeUrl;
  try {
    probeUrl = new URL(appUrlValue);
  } catch {
    invalid("OMNIPOST_LAUNCH_URL must be a valid HTTP URL.");
  }

  if (await appAnswers(probeUrl)) {
    await openBrowser(probeUrl);
    return;
  }

  const { appUrl, port, publicOrigin } = launchSettings();
  console.log("Building OmniPost for production...");
  await commandResult("next", ["build"]);
  if (stopping) return;

  const services = [
    {
      name: "OmniPost",
      command: "caffeinate",
      args: ["-i", "next", "start", "-p", port],
      message: appUrl.href,
    },
    {
      name: "Shared public tunnel",
      command: "ngrok",
      args: ["http", `--url=${publicOrigin.hostname}`, port],
      message: publicOrigin.origin,
    },
  ];

  console.log("Starting OmniPost production services:");
  for (const service of services) console.log(`- ${service.name}: ${service.message}`);
  console.log("This Mac will stay awake while OmniPost is running.");
  console.log("Press Ctrl+C to stop every service.");

  for (const service of services) {
    const child = spawnCommand(service.command, service.args);
    activeChildren.push(child);
    child.on("error", (error) => {
      console.error(`Could not start ${service.name}: ${error.message}`);
      process.exitCode = 1;
      stop();
    });
    child.on("exit", (code, signal) => {
      const index = activeChildren.indexOf(child);
      if (index >= 0) activeChildren.splice(index, 1);
      if (!stopping) {
        process.exitCode = code ?? (signal ? 1 : 0);
        stop();
      }
    });
  }

  await openWhenReady(appUrl);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
  stop();
});
