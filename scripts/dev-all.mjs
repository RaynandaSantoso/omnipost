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
const redirectUri = process.env.TIKTOK_REDIRECT_URI ?? fileEnv.TIKTOK_REDIRECT_URI;

const services = [
  {
    name: "OmniPost",
    command: "npm",
    args: ["run", "dev:app"],
    message: "http://localhost:3000",
  },
];

if (redirectUri) {
  let callback;
  try {
    callback = new URL(redirectUri);
  } catch {
    console.error("TIKTOK_REDIRECT_URI must be a valid URL.");
    process.exit(1);
  }

  if (
    callback.protocol !== "https:" ||
    callback.pathname !== "/api/platforms/tiktok/callback" ||
    callback.search ||
    callback.hash
  ) {
    console.error(
      "TIKTOK_REDIRECT_URI must be an HTTPS URL ending exactly in /api/platforms/tiktok/callback.",
    );
    process.exit(1);
  }

  services.push({
    name: "TikTok OAuth tunnel",
    command: "ngrok",
    args: ["http", `--url=${callback.hostname}`, "3000"],
    message: `${callback.origin} (public)`,
  });
}

console.log("Starting OmniPost development services:");
for (const service of services) {
  console.log(`- ${service.name}: ${service.message}`);
}
if (redirectUri) {
  console.log("The app is publicly reachable while the TikTok OAuth tunnel is running.");
}
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
