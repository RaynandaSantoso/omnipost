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

if (!redirectUri) {
  console.error(
    "TIKTOK_REDIRECT_URI is missing. Add the full ngrok callback URL to .env first.",
  );
  process.exit(1);
}

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

console.log(`Starting OmniPost at http://localhost:3000`);
console.log(`Opening ${callback.origin} publicly for TikTok OAuth`);
console.log("Press Ctrl+C when TikTok is connected to stop both processes.");

const children = [
  spawn("npm", ["run", "dev"], { stdio: "inherit" }),
  spawn("ngrok", ["http", `--url=${callback.hostname}`, "3000"], {
    stdio: "inherit",
  }),
];

let stopping = false;

function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
}

for (const child of children) {
  child.on("error", (error) => {
    console.error(`Could not start ${child.spawnargs[0]}: ${error.message}`);
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
