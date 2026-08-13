import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createSocketServer, type Server as SocketServer } from "node:net";
import { homedir, tmpdir } from "node:os";
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

const LAUNCHER = path.join(process.cwd(), "scripts/launch.mjs");

// Awaited rather than run synchronously, because a launcher command may need
// this process to answer the health endpoint while it runs.
function launcherCommand(
  args: string[],
  { env, cwd = projectDirectory("cached-build") }: { env: NodeJS.ProcessEnv; cwd?: string },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [LAUNCHER, ...args], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/** A launcher left running with its session up: app healthy, browser opened. */
async function startedLauncher(environment: NodeJS.ProcessEnv, port: number) {
  const logPath = environment.LAUNCHER_LOG as string;
  const launcher = spawn(process.execPath, [LAUNCHER], {
    cwd: projectDirectory("cached-build"),
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitFor(() =>
    readEvents(logPath).some(({ command, args }) => command === "next" && args[0] === "start"),
  );
  await startHealthyServer(port);
  await waitFor(() => readEvents(logPath).some(({ command }) => command === "open"));
  return launcher;
}

function writeOwnership(environment: NodeJS.ProcessEnv, record: object | string) {
  writeFileSync(
    path.join(environment.OMNIPOST_RUNTIME_DIR as string, "session.json"),
    typeof record === "string" ? record : JSON.stringify(record),
  );
}

function finishedPid(): number {
  return spawnSync(process.execPath, ["-e", ""]).pid;
}

function ownershipRecord({ appUrl, pid }: { appUrl: string; pid: number }) {
  return {
    sessionId: "11111111-2222-3333-4444-555555555555",
    pid,
    // The recorded start time of a process that has since exited, or that never
    // had this process id in the first place.
    processStartTime: "Mon Jan  1 00:00:00 2024",
    startedAt: "2024-01-01T00:00:00.000Z",
    state: "running",
    appUrl,
  };
}

/** The start time the operating system really reports for a live process. */
function liveProcessStartTime(pid: number): string {
  return execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
  }).trim();
}

// Every way an ownership record can be present without being evidence of a
// live session: a crashed owner, a process id the operating system handed to
// somebody else, a write that was cut in half, and a file OmniPost never wrote.
const untrustworthyRecords: { name: string; record: (appUrl: string) => object | string }[] = [
  {
    name: "ownership left by an owner that is gone",
    record: (appUrl) => ownershipRecord({ appUrl, pid: finishedPid() }),
  },
  {
    name: "ownership naming a recycled process id",
    record: (appUrl) => ownershipRecord({ appUrl, pid: process.pid }),
  },
  {
    // Its owner really is alive: only the missing fields say it was not this
    // Launcher that wrote it.
    name: "a record missing what identifies a session",
    record: (appUrl) => ({
      pid: process.pid,
      processStartTime: liveProcessStartTime(process.pid),
      state: "running",
      appUrl,
    }),
  },
  { name: "a half-written record", record: (appUrl) => `{"appUrl":"${appUrl}","pid` },
  { name: "a record written by something else", record: () => ({ note: "not a session" }) },
];

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

  it("refuses to launch over an app it does not own", async () => {
    const port = await unusedPort();
    await startHealthyServer(port);
    const { directory, logPath } = stubCommands();
    const result = await launcherCommand([], {
      env: launcherEnvironment(directory, logPath, `http://127.0.0.1:${port}`),
    });

    // Something answering on the port is not evidence that OmniPost is there,
    // so the port is an occupant to report rather than a session to adopt.
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(String(port));
    expect(readEvents(logPath)).toEqual([]);
  });

  it("reopens the session it owns instead of starting a second one", async () => {
    const port = await unusedPort();
    const { directory, logPath } = stubCommands();
    const environment = launcherEnvironment(directory, logPath, `http://127.0.0.1:${port}`);
    const launcher = await startedLauncher(environment, port);
    const startedEvents = readEvents(logPath).length;

    const again = await launcherCommand([], { env: environment });
    const reported = await launcherCommand(["status"], { env: environment });
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("already running");
    expect(readEvents(logPath).slice(startedEvents)).toEqual([
      { command: "open", event: "start", args: [`http://127.0.0.1:${port}/`] },
    ]);
    expect(reported.status).toBe(0);
    expect(reported.stdout).toContain("Running");

    launcher.kill("SIGTERM");
    await new Promise<void>((resolve) => launcher.once("exit", () => resolve()));

    // Ownership is given up with the session, so the next launch is not left
    // arguing with a record nobody owns.
    const afterStop = await launcherCommand(["status"], { env: environment });
    expect(afterStop.stdout).toContain("Stopped");
    expect(afterStop.status).toBe(4);
  });

  it("opens the owned session on request and keeps its record to itself", async () => {
    const port = await unusedPort();
    const { directory, logPath } = stubCommands();
    const environment = launcherEnvironment(directory, logPath, `http://127.0.0.1:${port}`);
    const launcher = await startedLauncher(environment, port);
    const startedEvents = readEvents(logPath).length;

    const opened = await launcherCommand(["open"], { env: environment });

    expect(opened.status).toBe(0);
    expect(readEvents(logPath).slice(startedEvents)).toEqual([
      { command: "open", event: "start", args: [`http://127.0.0.1:${port}/`] },
    ]);
    expect(statSync(path.join(environment.OMNIPOST_RUNTIME_DIR, "session.json")).mode & 0o777)
      .toBe(0o600);

    launcher.kill("SIGTERM");
    await new Promise<void>((resolve) => launcher.once("exit", () => resolve()));
  });

  it("keeps its runtime state in the operator's application-support location", async () => {
    const { runtimeDirectory } = await import("../scripts/launcher/session-state.mjs");

    expect(runtimeDirectory(() => undefined)).toBe(
      path.join(homedir(), "Library", "Application Support", "OmniPost"),
    );
  });

  it("gives one of two simultaneous launches the session and turns the other away", async () => {
    const port = await unusedPort();
    const { directory, logPath } = stubCommands();
    const environment = {
      ...launcherEnvironment(directory, logPath, `http://127.0.0.1:${port}`),
      OMNIPOST_LAUNCH_TIMEOUT_MS: "750",
    };

    // Several at once rather than two, because losing the claim is a race and
    // more racers make a regression more likely to show.
    const launches = await Promise.all(
      Array.from({ length: 4 }, () => launcherCommand([], { env: environment })),
    );

    // Whichever of them won, exactly one session was ever started: two
    // supervisors holding the same port and the same reserved tunnel is the
    // outcome ownership exists to prevent.
    const sessions = readEvents(logPath).filter(
      ({ command, event }) => command === "caffeinate" && event === "start",
    );
    expect(sessions).toHaveLength(1);
    expect(launches.map(({ status }) => status)).toEqual([1, 1, 1, 1]);
    expect(launches.map(({ stderr }) => stderr).join("")).toMatch(
      /already owns this Mac|Starting/,
    );
  });

  it("refuses a second launch and reports the phase while the first is still starting", async () => {
    const port = await unusedPort();
    const { directory, logPath } = stubCommands();
    const environment = {
      ...launcherEnvironment(directory, logPath, `http://127.0.0.1:${port}`),
      OMNIPOST_LAUNCH_TIMEOUT_MS: "10000",
    };
    const launcher = spawn(process.execPath, [LAUNCHER], {
      cwd: projectDirectory("cached-build"),
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitFor(() =>
      readEvents(logPath).some(({ command, args }) => command === "next" && args[0] === "start"),
    );
    const startedEvents = readEvents(logPath).length;

    const second = await launcherCommand([], { env: environment });
    const reported = await launcherCommand(["status"], { env: environment });

    expect(second.status).toBe(1);
    expect(second.stderr).toContain("Starting");
    expect(readEvents(logPath)).toHaveLength(startedEvents);
    expect(reported.status).toBe(3);
    expect(reported.stdout).toContain("Starting");
    expect(reported.stdout).toContain("health endpoint");

    launcher.kill("SIGTERM");
    await new Promise<void>((resolve) => launcher.once("exit", () => resolve()));
  });

  it("keeps a failed session's reason for the status that follows it", async () => {
    const port = await unusedPort();
    const { directory, logPath } = stubCommands();
    const environment = {
      ...launcherEnvironment(directory, logPath, `http://127.0.0.1:${port}`),
      OMNIPOST_LAUNCH_TIMEOUT_MS: "750",
    };

    const result = await launcherCommand([], { env: environment });
    const reported = await launcherCommand(["status"], { env: environment });

    expect(result.status).toBe(1);
    expect(reported.status).toBe(5);
    expect(reported.stdout).toContain("Failed");
    expect(reported.stdout).toContain("did not answer");
  });

  it("cannot open a session that is not running", async () => {
    const port = await unusedPort();
    const { directory, logPath } = stubCommands();
    const result = await launcherCommand(["open"], {
      env: launcherEnvironment(directory, logPath, `http://127.0.0.1:${port}`),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Stopped");
    expect(readEvents(logPath)).toEqual([]);
  });

  it.each(untrustworthyRecords)(
    "never reports $name as Running, however healthy the port looks",
    async ({ record }) => {
      const port = await unusedPort();
      await startHealthyServer(port);
      const { directory, logPath } = stubCommands();
      const environment = launcherEnvironment(directory, logPath, `http://127.0.0.1:${port}`);
      writeOwnership(environment, record(`http://127.0.0.1:${port}/`));

      const reported = await launcherCommand(["status"], { env: environment });

      expect(reported.stdout).not.toContain("Running");
      expect(reported.status).not.toBe(0);
    },
  );

  it("will not discard ownership while something it left behind is still serving", async () => {
    const port = await unusedPort();
    await startHealthyServer(port);
    const { directory, logPath } = stubCommands();
    const environment = launcherEnvironment(directory, logPath, `http://127.0.0.1:${port}`);
    writeOwnership(
      environment,
      ownershipRecord({ appUrl: `http://127.0.0.1:${port}/`, pid: finishedPid() }),
    );

    const result = await launcherCommand([], { env: environment });

    // The owner is gone, so the record is stale — but an orphan is still
    // answering for it, and that is worth naming rather than launching over.
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`http://127.0.0.1:${port}/`);
    expect(readEvents(logPath)).toEqual([]);
    expect(existsSync(path.join(environment.OMNIPOST_RUNTIME_DIR, "session.json"))).toBe(true);
  });

  it.each(untrustworthyRecords)("launches past $name", async ({ record }) => {
    const port = await unusedPort();
    const { directory, logPath } = stubCommands();
    const environment = {
      ...launcherEnvironment(directory, logPath, `http://127.0.0.1:${port}`),
      OMNIPOST_LAUNCH_TIMEOUT_MS: "750",
    };
    writeOwnership(environment, record(`http://127.0.0.1:${port}/`));

    // The launch still ends unhappily — nothing ever answers — but it got past
    // the record, which is the point: a crash cannot lock the operator out.
    await launcherCommand([], { env: environment });

    expect(
      readEvents(logPath).filter(
        ({ command, event, args }) => command === "next" && event === "start" && args[0] === "start",
      ),
    ).toHaveLength(1);
  });
});
