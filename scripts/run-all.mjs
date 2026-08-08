import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";

const appUrl = "http://localhost:3000";

function readEnvFile(filePath) {
  try {
    return Object.fromEntries(
      readFileSync(filePath, "utf8")
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

function appIsRunning() {
  return new Promise((resolve) => {
    const request = http.get({ hostname: "127.0.0.1", port: 3000, path: "/" }, (response) => {
      response.resume();
      resolve(true);
    });
    request.setTimeout(500, () => request.destroy());
    request.on("error", () => resolve(false));
  });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal}`));
    });
  });
}

async function openApp() {
  try {
    await run("open", [appUrl], { stdio: "ignore" });
  } catch (error) {
    console.error(`Could not open ${appUrl}: ${error.message}`);
    process.exitCode = 1;
  }
}

// Probe before validating or building. A second launcher click belongs to the
// already-running session and must not disturb it because this checkout's
// environment happens to have changed.
if (await appIsRunning()) {
  console.log("OmniPost is already running; opening another browser tab.");
  await openApp();
} else {
  const fileEnv = {
    ...readEnvFile(".env"),
    ...readEnvFile(".env.local"),
  };
  const envValue = (name) => process.env[name] ?? fileEnv[name];
  const publicBaseUrl = envValue("PUBLIC_BASE_URL");
  const redirects = [
    ["TIKTOK_REDIRECT_URI", envValue("TIKTOK_REDIRECT_URI"), "/api/platforms/tiktok/callback"],
    [
      "INSTAGRAM_REDIRECT_URI",
      envValue("INSTAGRAM_REDIRECT_URI"),
      "/api/platforms/instagram/callback",
    ],
  ];

  function invalid(message) {
    console.error(message);
    process.exit(1);
  }

  let publicOrigin;
  if (!publicBaseUrl) {
    invalid("PUBLIC_BASE_URL is required by the OmniPost launcher.");
  } else {
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
  }

  for (const [name, redirectUri, callbackPath] of redirects) {
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

  const rebuildRequested = process.argv.includes("--rebuild");
  if (rebuildRequested || !existsSync(path.join(".next", "BUILD_ID"))) {
    console.log(rebuildRequested ? "Rebuilding OmniPost…" : "No production build found; building OmniPost…");
    try {
      await run("npm", ["run", "build"], { stdio: "inherit" });
    } catch (error) {
      invalid(`Could not build OmniPost: ${error.message}`);
    }
  }

  const childEnv = {
    ...process.env,
    PATH: `${process.env.PATH ?? ""}:${path.resolve("node_modules", ".bin")}`,
  };
  const services = [
    { name: "OmniPost", command: "next", args: ["start", "--port", "3000"] },
    {
      name: "Shared public tunnel",
      command: "ngrok",
      args: ["http", `--url=${publicOrigin.hostname}`, "3000"],
    },
    {
      name: "Idle-sleep prevention",
      command: "caffeinate",
      args: ["-i", "-w", String(process.pid)],
    },
  ];

  console.log("Starting OmniPost:");
  console.log(`- App: ${appUrl}`);
  console.log(`- Shared public tunnel: ${publicOrigin.origin}`);
  console.log("Keep this terminal open. Press Ctrl+C to stop every service.");

  const children = services.map((service) => ({
    ...service,
    child: spawn(service.command, service.args, { stdio: "inherit", env: childEnv }),
  }));
  let stopping = false;

  function stop(signal = "SIGTERM") {
    if (stopping) return;
    stopping = true;
    for (const { child } of children) {
      if (!child.killed) child.kill(signal);
    }
  }

  for (const { name, child } of children) {
    child.on("error", (error) => {
      console.error(`Could not start ${name}: ${error.message}`);
      process.exitCode = 1;
      stop();
    });
    child.on("exit", (code, signal) => {
      if (!stopping) {
        process.exitCode = code ?? (signal ? 1 : 0);
        stop();
      }
    });
  }

  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  const readinessDeadline = Date.now() + 60_000;
  while (!stopping && !(await appIsRunning())) {
    if (Date.now() >= readinessDeadline) {
      console.error(`OmniPost did not answer at ${appUrl} within 60 seconds.`);
      process.exitCode = 1;
      stop();
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!stopping) await openApp();
}
