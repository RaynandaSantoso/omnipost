// Durable, per-session Launcher diagnostics. Logs live with the operator's
// other macOS logs, never in the project, and every write is redacted before it
// reaches disk.
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const SECRET_NAMES = [
  "ACCESS_PASSWORD",
  "YOUTUBE_CLIENT_SECRET",
  "TIKTOK_CLIENT_SECRET",
  "INSTAGRAM_APP_SECRET",
  "TOKEN_ENCRYPTION_KEY",
  "NGROK_AUTHTOKEN",
  "DATABASE_URL",
];

const STRUCTURED_SECRET =
  /(["']?(?:access_token|refresh_token|id_token|authorization|cookie|set-cookie|password|client_secret|encryption_key|api_key|auth_token|token)["']?\s*[:=]\s*["']?)([^"',\s}]+)/gi;
const BEARER_SECRET = /(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi;

export function createRedactor(env) {
  const secretValues = SECRET_NAMES.map(env)
    .filter((value) => typeof value === "string" && value.length > 0)
    .sort((left, right) => right.length - left.length);

  return (value) => {
    let safe = String(value);
    for (const secret of secretValues) safe = safe.replaceAll(secret, "[REDACTED]");
    return safe
      .replace(BEARER_SECRET, "$1[REDACTED]")
      .replace(STRUCTURED_SECRET, "$1[REDACTED]");
  };
}

export function logDirectory(env) {
  return env("OMNIPOST_LOG_DIR") || path.join(homedir(), "Library", "Logs", "OmniPost");
}

export function createSessionLog(env, sessionId) {
  const directory = logDirectory(env);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const logPath = path.join(directory, `${sessionId}.log`);
  const descriptor = openSync(logPath, "a", 0o600);
  chmodSync(logPath, 0o600);
  const redact = createRedactor(env);

  function write(source, stream, value) {
    for (const line of redact(value).split(/\r?\n/)) {
      if (!line) continue;
      appendFileSync(
        descriptor,
        `[${new Date().toISOString()}] [${source}] [${stream}] ${line}\n`,
        "utf8",
      );
    }
  }

  function capture(source, stream, output, terminal) {
    let pending = "";
    output.setEncoding("utf8");
    output.on("data", (chunk) => {
      const lines = (pending + chunk).split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        terminal.write(`${redact(line)}\n`);
        write(source, stream, line);
      }
    });
    output.on("end", () => {
      if (pending) {
        terminal.write(redact(pending));
        write(source, stream, pending);
      }
    });
  }

  return { logPath, redact, write, capture };
}

export function resolveSessionLog(env, record) {
  const directory = logDirectory(env);
  if (
    typeof record?.logPath === "string" &&
    path.dirname(path.resolve(record.logPath)) === path.resolve(directory)
  ) {
    return record.logPath;
  }
  try {
    return readdirSync(directory)
      .filter((name) => name.endsWith(".log"))
      .map((name) => path.join(directory, name))
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

export function readSessionLog(env, record) {
  let logPath;
  try {
    logPath = resolveSessionLog(env, record);
  } catch (error) {
    return {
      available: false,
      reason: `The Launcher log location is unavailable (${error?.code ?? error?.message}).`,
    };
  }
  if (!logPath) return { available: false, reason: "No Launcher session log is available yet." };
  try {
    return { available: true, logPath, content: readFileSync(logPath, "utf8") };
  } catch (error) {
    return {
      available: false,
      logPath,
      reason: `The Launcher log at ${logPath} is unavailable (${error?.code ?? error?.message}).`,
    };
  }
}
