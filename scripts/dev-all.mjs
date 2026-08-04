import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

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
  invalid(
    "PUBLIC_BASE_URL is required by npm run dev, which always starts a tunnel. " +
      "Use npm run dev:app to run locally instead: it starts OmniPost alone and " +
      "skips the platform configuration that needs the tunnel.",
  );
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

const services = [
  {
    name: "OmniPost",
    command: "next",
    args: ["dev"],
    message: "http://localhost:3000",
  },
];

services.push({
  name: "Shared public tunnel",
  command: "ngrok",
  args: ["http", `--url=${publicOrigin.hostname}`, "3000"],
  message: `${publicOrigin.origin} (public)`,
});

console.log("Starting OmniPost development services:");
for (const service of services) {
  console.log(`- ${service.name}: ${service.message}`);
}
console.log("Keep this terminal and computer running until all platform jobs have settled.");
console.log("Press Ctrl+C to stop every service.");

const children = services.map((service) => {
  const child = spawn(service.command, service.args, { stdio: "inherit" });
  return { ...service, child };
});

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
    stop();
    process.exitCode = 1;
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
