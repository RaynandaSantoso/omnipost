import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type LauncherEvent = {
  command: string;
  event: string;
  args: string[];
};

const temporaryDirectories: string[] = [];
const servers: Server[] = [];

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for launcher activity");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function readEvents(logPath: string): LauncherEvent[] {
  try {
    return readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function startHealthyServer(port: number): Promise<void> {
  const server = createServer((_request, response) => {
    response.writeHead(200).end("ok");
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

function stubCommands(): { directory: string; logPath: string } {
  const directory = mkdtempSync(path.join(tmpdir(), "omnipost-production-launcher-"));
  temporaryDirectories.push(directory);
  const logPath = path.join(directory, "children.log");
  const command = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const name = require("node:path").basename(process.argv[1]);
const record = (event) => appendFileSync(process.env.LAUNCHER_LOG, JSON.stringify({ command: name, event, args: process.argv.slice(2) }) + "\\n");
record("start");
if (name === "open" || (name === "next" && process.argv[2] === "build")) process.exit(0);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { record(signal); process.exit(0); });
setInterval(() => {}, 1000);
`;
  for (const name of ["next", "ngrok", "caffeinate", "open"]) {
    const commandPath = path.join(directory, name);
    writeFileSync(commandPath, command);
    chmodSync(commandPath, 0o755);
  }
  return { directory, logPath };
}

function launcherEnvironment(directory: string, logPath: string, appUrl: string) {
  return {
    ...process.env,
    PATH: `${directory}:${process.env.PATH}`,
    LAUNCHER_LOG: logPath,
    OMNIPOST_LAUNCH_URL: appUrl,
    PUBLIC_BASE_URL: "https://omnipost.ngrok-free.app",
    ACCESS_PASSWORD: "correct horse battery staple",
    TIKTOK_REDIRECT_URI: "",
    INSTAGRAM_REDIRECT_URI: "",
  };
}

describe("production launcher", () => {
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("ships as a dock-pinnable macOS app that hands the session to Terminal", () => {
    const bundle = path.join(process.cwd(), "launcher", "OmniPost.app", "Contents");
    const plist = readFileSync(path.join(bundle, "Info.plist"), "utf8");
    const executable = path.join(bundle, "MacOS", "OmniPost");

    expect(plist).toContain("CFBundleExecutable");
    expect(plist).toContain("OmniPost.icns");
    expect(statSync(executable).mode & 0o111).not.toBe(0);
    expect(readFileSync(executable, "utf8")).toContain("osascript");
  });

  it("refuses to start a public session without an access password", async () => {
    const port = await unusedPort();
    const { directory, logPath } = stubCommands();
    const result = spawnSync(process.execPath, ["scripts/launch.mjs"], {
      cwd: process.cwd(),
      env: {
        ...launcherEnvironment(directory, logPath, `http://127.0.0.1:${port}`),
        ACCESS_PASSWORD: "",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ACCESS_PASSWORD");
    expect(readEvents(logPath)).toEqual([]);
  });

  it.each([
    {
      name: "non-HTTPS public origin",
      environment: { PUBLIC_BASE_URL: "http://omnipost.ngrok-free.app" },
      expectedError: "PUBLIC_BASE_URL",
    },
    {
      name: "callback on another origin",
      environment: {
        TIKTOK_REDIRECT_URI: "https://other.ngrok-free.app/api/platforms/tiktok/callback",
      },
      expectedError: "TIKTOK_REDIRECT_URI",
    },
  ])("refuses $name before starting any process", async ({ environment, expectedError }) => {
    const port = await unusedPort();
    const { directory, logPath } = stubCommands();
    const result = spawnSync(process.execPath, ["scripts/launch.mjs"], {
      cwd: process.cwd(),
      env: {
        ...launcherEnvironment(directory, logPath, `http://127.0.0.1:${port}`),
        ...environment,
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(expectedError);
    expect(readEvents(logPath)).toEqual([]);
  });

  it("builds, starts the production app and tunnel, opens when ready, and stops both", async () => {
    const port = await unusedPort();
    const { directory, logPath } = stubCommands();
    const launcher = spawn(process.execPath, ["scripts/launch.mjs"], {
      cwd: process.cwd(),
      env: launcherEnvironment(directory, logPath, `http://127.0.0.1:${port}`),
      stdio: ["ignore", "pipe", "pipe"],
    });

    await waitFor(() => {
      const starts = readEvents(logPath).filter(({ event }) => event === "start");
      return starts.some(({ command }) => command === "caffeinate") &&
        starts.some(({ command }) => command === "ngrok");
    });
    expect(readEvents(logPath).some(({ command }) => command === "open")).toBe(false);

    await startHealthyServer(port);
    await waitFor(() => readEvents(logPath).some(({ command }) => command === "open"));
    launcher.kill("SIGTERM");
    await new Promise<void>((resolve, reject) => {
      launcher.once("exit", () => resolve());
      launcher.once("error", reject);
    });

    const events = readEvents(logPath);
    expect(
      events
        .filter(({ command, event }) => command === "next" && event === "start")
        .map(({ args }) => args),
    ).toEqual([["build"], ["start", "-p", String(port)]]);
    expect(events.find(({ command }) => command === "caffeinate")?.args).toEqual(["-i"]);
    expect(events.find(({ command }) => command === "ngrok")?.args).toEqual([
      "http",
      "--url=omnipost.ngrok-free.app",
      String(port),
    ]);
    expect(events.find(({ command }) => command === "open")?.args).toEqual([
      `http://127.0.0.1:${port}/`,
    ]);
    expect(
      events
        .filter(({ event }) => event === "SIGTERM")
        .map(({ command }) => command)
        .sort(),
    ).toEqual(["caffeinate", "next", "ngrok"]);
  });

  it("only brings the browser forward when the app is already answering", async () => {
    const port = await unusedPort();
    await startHealthyServer(port);
    const { directory, logPath } = stubCommands();
    const appUrl = `http://127.0.0.1:${port}`;
    const launcher = spawn(process.execPath, ["scripts/launch.mjs"], {
      cwd: process.cwd(),
      env: {
        ...launcherEnvironment(directory, logPath, appUrl),
        PUBLIC_BASE_URL: "",
        ACCESS_PASSWORD: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const status = await new Promise<number | null>((resolve, reject) => {
      launcher.once("exit", (code) => resolve(code));
      launcher.once("error", reject);
    });

    expect(status).toBe(0);
    expect(readEvents(logPath)).toEqual([
      { command: "open", event: "start", args: [`${appUrl}/`] },
    ]);
  });
});
