import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createSocketServer, type Server as SocketServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIN_ACCESS_PASSWORD_LENGTH } from "@/lib/config";

type LauncherEvent = {
  command: string;
  event: string;
  args: string[];
};

const temporaryDirectories: string[] = [];
const servers: (Server | SocketServer)[] = [];
const restrictedDirectories: string[] = [];

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

async function occupyPort(port: number, host = "127.0.0.1"): Promise<void> {
  const server = createSocketServer((socket) => socket.resume());
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
}

// Every managed command is the same recording stub: it appends what it was
// asked to do, then behaves like the real thing (one-shot or long-running).
// `LAUNCHER_FAILING_COMMANDS` makes a named command exit non-zero on start,
// which is how a companion-process failure is provoked deterministically.
function stubCommands(only?: string[]): { directory: string; logPath: string } {
  const directory = mkdtempSync(path.join(tmpdir(), "omnipost-production-launcher-"));
  temporaryDirectories.push(directory);
  const logPath = path.join(directory, "children.log");
  const command = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const name = require("node:path").basename(process.argv[1]);
const record = (event) => appendFileSync(process.env.LAUNCHER_LOG, JSON.stringify({ command: name, event, args: process.argv.slice(2) }) + "\\n");
const failing = (process.env.LAUNCHER_FAILING_COMMANDS ?? "").split(",").filter(Boolean);
record("start");
if (failing.includes(name) || failing.includes(name + " " + process.argv[2])) process.exit(1);
if (name === "open" || (name === "next" && process.argv[2] === "build")) process.exit(0);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { record(signal); process.exit(0); });
setInterval(() => {}, 1000);
`;
  for (const name of only ?? ["next", "ngrok", "caffeinate", "open"]) {
    const commandPath = path.join(directory, name);
    writeFileSync(commandPath, command);
    chmodSync(commandPath, 0o755);
  }
  return { directory, logPath };
}

// A throwaway project root, so a launch never rebuilds or reuses the
// repository's own .next directory.
function projectDirectory(buildId?: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), "omnipost-launch-project-"));
  temporaryDirectories.push(directory);
  if (buildId !== undefined) {
    mkdirSync(path.join(directory, ".next"), { recursive: true });
    writeFileSync(path.join(directory, ".next", "BUILD_ID"), buildId);
  }
  return directory;
}

function launcherEnvironment(directory: string, logPath: string, appUrl: string) {
  const runtimeDirectory = mkdtempSync(path.join(tmpdir(), "omnipost-launcher-runtime-"));
  temporaryDirectories.push(runtimeDirectory);
  return {
    ...process.env,
    PATH: `${directory}:${process.env.PATH}`,
    LAUNCHER_LOG: logPath,
    OMNIPOST_LAUNCH_URL: appUrl,
    OMNIPOST_RUNTIME_DIR: runtimeDirectory,
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
    for (const directory of restrictedDirectories.splice(0)) {
      chmodSync(directory, 0o700);
    }
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("ships as a dock-pinnable macOS app that hands the session to Terminal", () => {
    const bundle = path.join(process.cwd(), "OmniPost.app", "Contents");
    const plist = readFileSync(path.join(bundle, "Info.plist"), "utf8");
    const executable = path.join(bundle, "MacOS", "OmniPost");

    expect(plist).toContain("CFBundleExecutable");
    expect(plist).toContain("OmniPost.icns");
    expect(statSync(executable).mode & 0o111).not.toBe(0);
    expect(readFileSync(executable, "utf8")).toContain("osascript");
    expect(readFileSync(executable, "utf8")).toContain("npm run launch");
  });

  it("refuses to start a public session without an access password", async () => {
    const port = await unusedPort();
    const { directory, logPath } = stubCommands();
    const result = spawnSync(process.execPath, [path.join(process.cwd(), "scripts/launch.mjs")], {
      cwd: projectDirectory("cached-build"),
      env: {
        ...launcherEnvironment(directory, logPath, `http://127.0.0.1:${port}`),
        ACCESS_PASSWORD: "",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ACCESS_PASSWORD");
    expect(result.stderr).toContain("PUBLIC_BASE_URL");
    expect(readEvents(logPath)).toEqual([]);
  });

  it.each([
    {
      name: "non-HTTPS public origin",
      environment: { PUBLIC_BASE_URL: "http://omnipost.ngrok-free.app" },
      expectedError: "PUBLIC_BASE_URL",
    },
    {
      name: "missing public origin",
      environment: { PUBLIC_BASE_URL: "" },
      expectedError: "PUBLIC_BASE_URL",
    },
    {
      name: "an access password the app would refuse",
      environment: { ACCESS_PASSWORD: "short" },
      expectedError: "at least 16 characters",
    },
    {
      name: "a public origin carrying a path",
      environment: { PUBLIC_BASE_URL: "https://omnipost.ngrok-free.app/omnipost" },
      expectedError: "PUBLIC_BASE_URL",
    },
    {
      name: "a public origin carrying credentials",
      environment: { PUBLIC_BASE_URL: "https://user:secret@omnipost.ngrok-free.app" },
      expectedError: "PUBLIC_BASE_URL",
    },
    {
      name: "callback on another origin",
      environment: {
        TIKTOK_REDIRECT_URI: "https://other.ngrok-free.app/api/platforms/tiktok/callback",
      },
      expectedError: "TIKTOK_REDIRECT_URI",
    },
    {
      name: "callback on the wrong path",
      environment: {
        INSTAGRAM_REDIRECT_URI: "https://omnipost.ngrok-free.app/callback",
      },
      expectedError: "INSTAGRAM_REDIRECT_URI",
    },
    {
      name: "a local origin that is not a URL",
      environment: { OMNIPOST_LAUNCH_URL: "not-a-url" },
      expectedError: "OMNIPOST_LAUNCH_URL",
    },
    {
      name: "a local origin carrying a path",
      environment: { OMNIPOST_LAUNCH_URL: "http://127.0.0.1:3000/dashboard" },
      expectedError: "OMNIPOST_LAUNCH_URL",
    },
  ])("refuses $name before starting any process", async ({ environment, expectedError }) => {
    const port = await unusedPort();
    const { directory, logPath } = stubCommands();
    const result = spawnSync(process.execPath, [path.join(process.cwd(), "scripts/launch.mjs")], {
      cwd: projectDirectory("cached-build"),
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

  it.each([
    { missing: "ngrok", present: ["next", "caffeinate", "open"] },
    { missing: "caffeinate", present: ["next", "ngrok", "open"] },
    { missing: "next", present: ["ngrok", "caffeinate", "open"] },
    { missing: "open", present: ["next", "ngrok", "caffeinate"] },
  ])("names $missing as a missing prerequisite and starts nothing", async ({ missing, present }) => {
    const port = await unusedPort();
    const { directory, logPath } = stubCommands(present);
    const result = spawnSync(process.execPath, [path.join(process.cwd(), "scripts/launch.mjs")], {
      cwd: projectDirectory("cached-build"),
      env: {
        ...launcherEnvironment(directory, logPath, `http://127.0.0.1:${port}`),
        // Only the stubs are reachable, so a real ngrok on this Mac cannot
        // stand in for the one the test removed.
        PATH: directory,
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(missing);
    expect(readEvents(logPath)).toEqual([]);
  });

  it("refuses to start when it cannot write its runtime state", async () => {
    const port = await unusedPort();
    const { directory, logPath } = stubCommands();
    const parent = mkdtempSync(path.join(tmpdir(), "omnipost-readonly-"));
    temporaryDirectories.push(parent);
    chmodSync(parent, 0o500);
    restrictedDirectories.push(parent);

    const result = spawnSync(process.execPath, [path.join(process.cwd(), "scripts/launch.mjs")], {
      cwd: projectDirectory("cached-build"),
      env: {
        ...launcherEnvironment(directory, logPath, `http://127.0.0.1:${port}`),
        OMNIPOST_RUNTIME_DIR: path.join(parent, "OmniPost"),
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(path.join(parent, "OmniPost"));
    expect(readEvents(logPath)).toEqual([]);
  });

  it.each([
    { name: "on the same address", host: "127.0.0.1", launchHost: "127.0.0.1" },
    // localhost resolves to both loopback families, so an occupant reachable
    // through only one of them still owns the port.
    { name: "on the other loopback family", host: "::1", launchHost: "localhost" },
  ])(
    "refuses to start when another process already holds the local port $name",
    async ({ host, launchHost }) => {
      const port = await unusedPort();
      await occupyPort(port, host);
      const { directory, logPath } = stubCommands();
      const result = spawnSync(process.execPath, [path.join(process.cwd(), "scripts/launch.mjs")], {
        cwd: projectDirectory("cached-build"),
        env: launcherEnvironment(directory, logPath, `http://${launchHost}:${port}`),
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(String(port));
      expect(readEvents(logPath)).toEqual([]);
    },
  );

  it("requires the same access password length the app refuses to boot without", async () => {
    const launcher = await import("../scripts/launcher/preflight.mjs");

    expect(launcher.MIN_ACCESS_PASSWORD_LENGTH).toBe(MIN_ACCESS_PASSWORD_LENGTH);
  });

  it.each([
    { mode: "an existing production build", buildId: "cached-build", launcherArgs: [], expectsBuild: false },
    { mode: "a requested rebuild", buildId: "cached-build", launcherArgs: ["--rebuild"], expectsBuild: true },
    { mode: "a missing production build", buildId: undefined, launcherArgs: [], expectsBuild: true },
    { mode: "an unusable build record", buildId: "  ", launcherArgs: [], expectsBuild: true },
  ])("uses $mode, starts every service, opens when ready, and stops cleanly", async ({
    buildId,
    launcherArgs,
    expectsBuild,
  }) => {
    const port = await unusedPort();
    const { directory, logPath } = stubCommands();
    const launcher = spawn(
      process.execPath,
      [path.join(process.cwd(), "scripts/launch.mjs"), ...launcherArgs],
      {
        cwd: projectDirectory(buildId),
        env: launcherEnvironment(directory, logPath, `http://127.0.0.1:${port}`),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    // The tunnel must not be presented before the app answers, so nothing
    // public exists while OmniPost is still unhealthy.
    await waitFor(() =>
      readEvents(logPath).some(
        ({ command, args }) => command === "next" && args[0] === "start",
      ),
    );
    expect(readEvents(logPath).map(({ command }) => command)).not.toContain("ngrok");
    expect(readEvents(logPath).map(({ command }) => command)).not.toContain("open");

    await startHealthyServer(port);
    await waitFor(() => readEvents(logPath).some(({ command }) => command === "open"));
    launcher.kill("SIGTERM");
    await new Promise<void>((resolve, reject) => {
      launcher.once("exit", () => resolve());
      launcher.once("error", reject);
    });

    const events = readEvents(logPath);
    const starts = events.filter(({ event }) => event === "start");
    const nextStarts = events
      .filter(({ command, event }) => command === "next" && event === "start")
      .map(({ args }) => args);
    expect(nextStarts).toContainEqual(["start", "-p", String(port)]);
    expect(nextStarts.some(([command]) => command === "build")).toBe(expectsBuild);
    expect(events.find(({ command }) => command === "caffeinate")?.args).toEqual(["-i"]);
    expect(events.find(({ command }) => command === "ngrok")?.args).toEqual([
      "http",
      "--url=omnipost.ngrok-free.app",
      String(port),
    ]);
    expect(events.find(({ command }) => command === "open")?.args).toEqual([
      `http://127.0.0.1:${port}/`,
    ]);
    expect(starts.findIndex(({ command }) => command === "ngrok")).toBeLessThan(
      starts.findIndex(({ command }) => command === "open"),
    );
    expect(
      events
        .filter(({ event }) => event === "SIGTERM")
        .map(({ command }) => command)
        .sort(),
    ).toEqual(["caffeinate", "next", "ngrok"]);
  });

  it("stops the session and reports the wait when the app never answers", async () => {
    const port = await unusedPort();
    const { directory, logPath } = stubCommands();
    const result = spawnSync(process.execPath, [path.join(process.cwd(), "scripts/launch.mjs")], {
      cwd: projectDirectory("cached-build"),
      env: {
        ...launcherEnvironment(directory, logPath, `http://127.0.0.1:${port}`),
        OMNIPOST_LAUNCH_TIMEOUT_MS: "750",
      },
      encoding: "utf8",
    });

    const events = readEvents(logPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`http://127.0.0.1:${port}/`);
    expect(events.map(({ command }) => command)).not.toContain("ngrok");
    expect(events.map(({ command }) => command)).not.toContain("open");
    expect(
      events
        .filter(({ event }) => event === "SIGTERM")
        .map(({ command }) => command)
        .sort(),
    ).toEqual(["caffeinate", "next"]);
  });

  it.each([
    { failing: "ngrok", becomesHealthy: true, expectedSignals: ["caffeinate", "next"] },
    { failing: "next start", becomesHealthy: false, expectedSignals: ["caffeinate"] },
  ])("stops everything it started when $failing fails", async ({
    failing,
    becomesHealthy,
    expectedSignals,
  }) => {
    const port = await unusedPort();
    const { directory, logPath } = stubCommands();
    const launcher = spawn(process.execPath, [path.join(process.cwd(), "scripts/launch.mjs")], {
      cwd: projectDirectory("cached-build"),
      env: {
        ...launcherEnvironment(directory, logPath, `http://127.0.0.1:${port}`),
        LAUNCHER_FAILING_COMMANDS: failing,
        OMNIPOST_LAUNCH_TIMEOUT_MS: "5000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    await waitFor(() =>
      readEvents(logPath).some(({ command, args }) => command === "next" && args[0] === "start"),
    );
    if (becomesHealthy) await startHealthyServer(port);
    const status = await new Promise<number | null>((resolve, reject) => {
      launcher.once("exit", (code) => resolve(code));
      launcher.once("error", reject);
    });

    const events = readEvents(logPath);
    expect(status).toBe(1);
    expect(events.map(({ command }) => command)).not.toContain("open");
    expect(
      events
        .filter(({ event }) => event === "SIGTERM")
        .map(({ command }) => command)
        .sort(),
    ).toEqual(expectedSignals);
  });

  it("stops the whole session when the browser cannot be opened", async () => {
    const port = await unusedPort();
    const { directory, logPath } = stubCommands();
    const launcher = spawn(process.execPath, [path.join(process.cwd(), "scripts/launch.mjs")], {
      cwd: projectDirectory("cached-build"),
      env: {
        ...launcherEnvironment(directory, logPath, `http://127.0.0.1:${port}`),
        LAUNCHER_FAILING_COMMANDS: "open",
        OMNIPOST_LAUNCH_TIMEOUT_MS: "5000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    await waitFor(() =>
      readEvents(logPath).some(({ command, args }) => command === "next" && args[0] === "start"),
    );
    await startHealthyServer(port);
    const status = await new Promise<number | null>((resolve, reject) => {
      launcher.once("exit", (code) => resolve(code));
      launcher.once("error", reject);
    });

    expect(status).toBe(1);
    expect(
      readEvents(logPath)
        .filter(({ event }) => event === "SIGTERM")
        .map(({ command }) => command)
        .sort(),
    ).toEqual(["caffeinate", "next", "ngrok"]);
  });

  it("stops idle-sleep prevention when the production build fails", async () => {
    const port = await unusedPort();
    const { directory, logPath } = stubCommands();
    const result = spawnSync(process.execPath, [path.join(process.cwd(), "scripts/launch.mjs")], {
      cwd: projectDirectory(),
      env: {
        ...launcherEnvironment(directory, logPath, `http://127.0.0.1:${port}`),
        LAUNCHER_FAILING_COMMANDS: "next build",
      },
      encoding: "utf8",
    });

    const events = readEvents(logPath);
    expect(result.status).toBe(1);
    expect(events.filter(({ command, args }) => command === "next" && args[0] === "start")).toEqual([]);
    expect(events.map(({ command }) => command)).not.toContain("ngrok");
    expect(
      events.filter(({ event }) => event === "SIGTERM").map(({ command }) => command),
    ).toEqual(["caffeinate"]);
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
